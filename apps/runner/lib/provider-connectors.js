'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { createHermesAutomationConnector } = require('./automation-connectors');

const execFileAsync = util.promisify(childProcess.execFile);
const PROVIDERS = new Set(['claude', 'codex', 'grok', 'hermes']);
const MAX_FILE_BYTES = 64 * 1024;
const MAX_ENTRIES = 200;
const HOST_PATH_PATTERN = /(?:^|[\s"'=:])(?:\/Users\/|\/home\/|[A-Za-z]:\\|\\\\[^\\\s]+\\)/;
const SECRET_VALUE_PATTERN = /(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|authorization|cookie|credential|password|secret|token)\s*[:=])/i;

function connectorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function publicText(value, max) {
  const normalized = String(value ?? '').trim();
  if (normalized.length > max) {
    throw connectorError('CONNECTOR_OUTPUT_INVALID', 'connector public metadata exceeds its limit');
  }
  if (HOST_PATH_PATTERN.test(normalized) || SECRET_VALUE_PATTERN.test(normalized)) {
    throw connectorError('CONNECTOR_OUTPUT_SECRET', 'connector output contains private host data');
  }
  return normalized;
}

function normalizePublicCatalogEntry(providerValue, input = {}) {
  const provider = String(providerValue || '').trim().toLowerCase();
  if (!PROVIDERS.has(provider)) {
    throw connectorError('CONNECTOR_PROVIDER_UNSUPPORTED', 'unsupported provider connector');
  }
  const externalAgentId = publicText(input.externalAgentId ?? input.id, 160);
  const displayName = publicText(input.displayName ?? input.name ?? externalAgentId, 160);
  if (!externalAgentId || !displayName) {
    throw connectorError('CONNECTOR_OUTPUT_INVALID', 'connector agent identity is required');
  }
  return {
    provider,
    externalAgentId,
    displayName,
    description: publicText(input.description, 500),
    sourceKind: publicText(input.sourceKind || 'local_profile', 64),
    capability: publicText(input.capability || 'importable', 64),
  };
}

function safePublicCatalogEntry(provider, input) {
  try {
    return normalizePublicCatalogEntry(provider, input);
  } catch (error) {
    if (error?.code === 'CONNECTOR_OUTPUT_INVALID' || error?.code === 'CONNECTOR_OUTPUT_SECRET') {
      return null;
    }
    throw error;
  }
}

function normalizePublicSessionEntry(providerValue, input = {}) {
  const provider = String(providerValue || '').trim().toLowerCase();
  if (!PROVIDERS.has(provider)) {
    throw connectorError('CONNECTOR_PROVIDER_UNSUPPORTED', 'unsupported provider connector');
  }
  const externalSessionId = publicText(input.externalSessionId ?? input.id, 200);
  if (!externalSessionId) {
    throw connectorError('CONNECTOR_OUTPUT_INVALID', 'connector session identity is required');
  }
  return {
    provider,
    externalSessionId,
    title: publicText(input.title || `${provider} session ${externalSessionId.slice(0, 8)}`, 200),
    updatedAt: publicText(input.updatedAt, 64),
    status: publicText(input.status || 'available', 64),
    sourceKind: publicText(input.sourceKind || 'local_session', 64),
    capability: publicText(input.capability || 'resumable', 64),
  };
}

function readBoundedText(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return '';
  return fs.readFileSync(filePath, 'utf8');
}

function listFiles(directory, extension) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(extension))
      .slice(0, MAX_ENTRIES)
      .map((entry) => path.join(directory, entry.name));
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function listFilesRecursive(directory, extension, depth = 5) {
  const files = [];
  function visit(current, remainingDepth) {
    if (files.length >= MAX_ENTRIES || remainingDepth < 0) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (files.length >= MAX_ENTRIES || entry.isSymbolicLink()) break;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath, remainingDepth - 1);
      else if (entry.isFile() && entry.name.endsWith(extension)) files.push(entryPath);
    }
  }
  visit(directory, depth);
  return files;
}

function quotedValue(source, key) {
  const match = source.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"'\\r\\n]*)["']\\s*$`, 'm'));
  return match ? match[1].trim() : '';
}

function frontmatterValue(source, key) {
  const frontmatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) return '';
  const match = frontmatter[1].match(new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, 'm'));
  if (!match) return '';
  return match[1].replace(/^(['"])(.*)\1$/, '$2').trim();
}

function listCodexAgents(codexHome) {
  return listFiles(path.join(codexHome, 'agents'), '.toml')
    .map((filePath) => {
      const source = readBoundedText(filePath);
      const externalAgentId = path.basename(filePath, '.toml');
      return safePublicCatalogEntry('codex', {
        externalAgentId,
        displayName: quotedValue(source, 'name') || externalAgentId,
        description: quotedValue(source, 'description'),
      });
    })
    .filter(Boolean);
}

function claudeAgentDirectories(claudeHome, cwd) {
  const candidates = [
    path.join(claudeHome, 'agents'),
    path.join(cwd, '.claude', 'agents'),
  ];
  return [...new Set(candidates)];
}

function listClaudeAgents(claudeHome, cwd) {
  const seen = new Set();
  const entries = [];
  for (const directory of claudeAgentDirectories(claudeHome, cwd)) {
    for (const filePath of listFiles(directory, '.md')) {
      const source = readBoundedText(filePath);
      const externalAgentId = path.basename(filePath, '.md');
      if (seen.has(externalAgentId)) continue;
      const entry = safePublicCatalogEntry('claude', {
        externalAgentId,
        displayName: frontmatterValue(source, 'name') || externalAgentId,
        description: frontmatterValue(source, 'description'),
      });
      if (!entry) continue;
      seen.add(externalAgentId);
      entries.push(entry);
    }
  }
  return entries;
}

function listHermesProfiles(stdout) {
  const entries = [];
  const seen = new Set();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s+\(active\))?(?:\s|$)/);
    if (
      !match
      || /^profile$/i.test(match[1])
      || seen.has(match[1])
      || SECRET_VALUE_PATTERN.test(line)
    ) continue;
    seen.add(match[1]);
    entries.push(normalizePublicCatalogEntry('hermes', {
      externalAgentId: match[1],
      displayName: match[1],
    }));
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries;
}

function fileSessionEntry(provider, filePath) {
  const name = path.basename(filePath, '.jsonl');
  const match = name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  if (!match) return null;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES * 64) return null;
  return normalizePublicSessionEntry(provider, {
    externalSessionId: match[0],
    title: `${provider === 'codex' ? 'Codex' : 'Claude'} session ${match[0].slice(0, 8)}`,
    updatedAt: stat.mtime.toISOString(),
  });
}

function listFileSessions(provider, directory) {
  return listFilesRecursive(directory, '.jsonl')
    .map((filePath) => fileSessionEntry(provider, filePath))
    .filter(Boolean)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_ENTRIES);
}

function listHermesSessions(stdout) {
  const sessions = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const columns = line.trim().split(/\s{2,}/).filter(Boolean);
    if (columns.length < 5 || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,}$/.test(columns.at(-1))) continue;
    sessions.push(normalizePublicSessionEntry('hermes', {
      externalSessionId: columns.at(-1),
      title: columns[0],
    }));
    if (sessions.length >= MAX_ENTRIES) break;
  }
  return sessions;
}

function listGrokSessions(stdout) {
  const sessions = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f-]{20,})\s{2,}(\d{4}-\d{2}-\d{2})\s{2,}(\d{4}-\d{2}-\d{2})\s{2,}\S+\s{2,}(.+)$/i);
    if (!match) continue;
    sessions.push(normalizePublicSessionEntry('grok', {
      externalSessionId: match[1],
      title: match[4],
      updatedAt: `${match[3]}T00:00:00.000Z`,
    }));
    if (sessions.length >= MAX_ENTRIES) break;
  }
  return sessions;
}

function createProviderConnector(options = {}) {
  const env = options.env || process.env;
  const homeDir = path.resolve(String(options.homeDir || env.HOME || process.cwd()));
  const codexHome = path.resolve(String(options.codexHome || env.CODEX_HOME || path.join(homeDir, '.codex')));
  const claudeHome = path.resolve(String(options.claudeHome || env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude')));
  const cwd = path.resolve(String(options.cwd || process.cwd()));
  const execFile = options.execFile || (async (command, args) => {
    const result = await execFileAsync(command, args, {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
      timeout: 15_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  });
  const automationConnector = options.automationConnector || createHermesAutomationConnector({
    env: options.env || process.env,
    fetchImpl: options.fetchImpl || fetch,
  });

  return {
    async listAgents(providerValue, { consent = false } = {}) {
      if (!consent) {
        throw connectorError(
          'CONNECTOR_CONSENT_REQUIRED',
          'local provider catalog discovery requires explicit consent',
        );
      }
      const provider = String(providerValue || '').trim().toLowerCase();
      if (!PROVIDERS.has(provider)) {
        throw connectorError('CONNECTOR_PROVIDER_UNSUPPORTED', 'unsupported provider connector');
      }
      if (provider === 'codex') return listCodexAgents(codexHome);
      if (provider === 'claude') return listClaudeAgents(claudeHome, cwd);
      if (provider === 'hermes') {
        const result = await execFile('hermes', ['profile', 'list']);
        if (Number(result?.code || 0) !== 0) {
          throw connectorError('CONNECTOR_COMMAND_FAILED', 'Hermes profile discovery failed');
        }
        return listHermesProfiles(result?.stdout);
      }
      return [];
    },
    async listSessions(providerValue, { consent = false } = {}) {
      if (!consent) {
        throw connectorError(
          'CONNECTOR_CONSENT_REQUIRED',
          'local provider session discovery requires explicit consent',
        );
      }
      const provider = String(providerValue || '').trim().toLowerCase();
      if (!PROVIDERS.has(provider)) {
        throw connectorError('CONNECTOR_PROVIDER_UNSUPPORTED', 'unsupported provider connector');
      }
      if (provider === 'codex') return listFileSessions('codex', path.join(codexHome, 'sessions'));
      if (provider === 'claude') return listFileSessions('claude', path.join(claudeHome, 'projects'));
      if (provider === 'hermes') {
        const result = await execFile('hermes', ['sessions', 'list', '--limit', '200']);
        if (Number(result?.code || 0) !== 0) {
          throw connectorError('CONNECTOR_COMMAND_FAILED', 'Hermes session discovery failed');
        }
        return listHermesSessions(result?.stdout);
      }
      const result = await execFile('grok', ['sessions', 'list', '--limit', '200']);
      if (Number(result?.code || 0) !== 0) {
        throw connectorError('CONNECTOR_COMMAND_FAILED', 'Grok session discovery failed');
      }
      return listGrokSessions(result?.stdout);
    },
    async runAutomation(providerValue, input = {}) {
      return automationConnector.run(providerValue, input);
    },
  };
}

module.exports = {
  createProviderConnector,
  normalizePublicCatalogEntry,
  normalizePublicSessionEntry,
};
