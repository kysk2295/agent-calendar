const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile: nodeExecFile } = require('node:child_process');

const DEFAULT_HERMES_CLI_PATH = '/Users/goyunseo/.hermes/hermes-agent/venv/bin/hermes';
const DEFAULT_TIMEOUT_MS = 5000;
const SAFE_PROFILE_ID_RE = /^(?:default|[a-z0-9][a-z0-9_-]*)$/;

function normalizeCell(value) {
  const text = String(value || '').trim();
  if (!text || text === '—' || text === '-') return '';
  return text;
}

function isSeparatorLine(line) {
  const trimmed = String(line || '').trim();
  return Boolean(trimmed) && /^[\s─━\-]+$/u.test(trimmed);
}

function isHermesProfileListOutput(output = '') {
  return String(output || '')
    .split(/\r?\n/)
    .some((line) => /\bProfile\b/i.test(line) && /\bModel\b/i.test(line) && /\bGateway\b/i.test(line));
}

function isSafeProfileId(value) {
  return SAFE_PROFILE_ID_RE.test(String(value || '').trim());
}

function shellQuote(value) {
  const text = String(value || '').trim() || 'hermes';
  if (/^[A-Za-z0-9_./:-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, '\'\\\'\'')}'`;
}

function slugify(value, fallback = 'item') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/…/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function resolveHermesHome({ env = process.env } = {}) {
  const explicit = String(env.HERMES_HOME || '').trim();
  if (explicit) return explicit;
  return path.join(env.HOME || os.homedir(), '.hermes');
}

function resolveHermesCliPath({ env = process.env, fs: fsModule = fs } = {}) {
  const explicit = String(env.HERMES_CLI_PATH || '').trim();
  if (explicit) return explicit;
  try {
    fsModule.accessSync(DEFAULT_HERMES_CLI_PATH, fsModule.constants?.X_OK ?? fs.constants.X_OK);
    return DEFAULT_HERMES_CLI_PATH;
  } catch {
    return 'hermes';
  }
}

function parseHermesProfileList(output = '') {
  if (!isHermesProfileListOutput(output)) return [];
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^Profile\s+Model\s+Gateway\s+Alias\s+Distribution\b/i.test(line))
    .filter((line) => !isSeparatorLine(line))
    .map((line) => {
      let row = line;
      let isDefault = false;
      if (row.startsWith('◆')) {
        isDefault = true;
        row = row.slice(1).trimStart();
      }
      const cells = row.split(/\s{2,}/).map(normalizeCell);
      const name = normalizeCell(cells[0]).replace(/^◆/, '');
      if (!name || !isSafeProfileId(name)) return null;
      const model = normalizeCell(cells[1]);
      const provider = model.includes('/') ? model.split('/')[0] : '';
      return {
        name,
        path: '',
        isDefault: isDefault || name === 'default',
        gateway: normalizeCell(cells[2]),
        alias: normalizeCell(cells[3]),
        distribution: normalizeCell(cells.slice(4).join(' ')),
        model,
        provider,
        skillCount: null,
      };
    })
    .filter(Boolean);
}

function parseHermesSkillList(output = '') {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('│') && line.endsWith('│'))
    .map((line) => line.slice(1, -1).split('│').map((cell) => normalizeCell(cell)))
    .filter((cells) => cells.length >= 5)
    .filter((cells) => !/^Name$/i.test(cells[0]) && !/^Category$/i.test(cells[1]))
    .map(([name, category, source, trust, status]) => {
      const label = normalizeCell(name);
      if (!label) return null;
      return {
        id: slugify(label, 'skill'),
        label,
        name: label,
        category: normalizeCell(category) || 'uncategorized',
        source: normalizeCell(source) || 'unknown',
        sourceRuntime: 'hermes-cli',
        trust: normalizeCell(trust) || 'unknown',
        status: normalizeCell(status) || 'unknown',
      };
    })
    .filter(Boolean);
}

function readIfExists(fsModule, filePath) {
  try {
    return fsModule.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function parseProfileDescription(yaml = '') {
  const lines = String(yaml || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^description\s*:/i.test(line));
  if (start < 0) return '';
  const first = lines[start].replace(/^description\s*:\s*/i, '').trim();
  const rest = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S[^:]*\s*:/.test(line)) break;
    if (!/^\s+/.test(line)) break;
    rest.push(line.trim());
  }
  return [first, ...rest].join(' ').replace(/^['"]|['"]$/g, '').replace(/\s+/g, ' ').trim();
}

function parseSoulSections(content = '') {
  const sections = {};
  let current = 'Intro';
  String(content || '').split(/\r?\n/).forEach((line) => {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = heading[1].trim();
      if (!sections[current]) sections[current] = [];
      return;
    }
    if (!sections[current]) sections[current] = [];
    sections[current].push(line);
  });
  return sections;
}

function compactSection(lines = []) {
  return lines.join('\n').replace(/<!--[\s\S]*?-->/g, '').replace(/\n{2,}/g, '\n').trim();
}

function sectionBullets(lines = []) {
  const bullets = [];
  lines.forEach((line) => {
    const bullet = String(line || '').match(/^\s*[-*]\s+(.+?)\s*$/);
    if (bullet) bullets.push(bullet[1].trim());
  });
  return bullets;
}

function soulTitle(content = '', fallback = 'Hermes Agent') {
  const match = String(content || '').match(/^#\s+(.+?)\s*$/m);
  return match ? match[1].trim() : fallback;
}

function soulMission(content = '') {
  const sections = parseSoulSections(content);
  return compactSection(sections.Mission || []);
}

function rulesFromSoul(content = '', sourcePath = '') {
  const sections = parseSoulSections(content);
  const rules = [];
  ['Owns', 'Avoids', 'Memory Scope', 'Kanban Behavior'].forEach((section) => {
    sectionBullets(sections[section] || []).forEach((text, index) => {
      rules.push({
        id: `soul-${slugify(section)}-${index + 1}`,
        label: section,
        text,
        source: `profile-soul:${section}`,
        scope: sourcePath || 'SOUL.md',
        required: section !== 'Owns',
      });
    });
  });
  const verification = compactSection(sections.Verification || []);
  if (verification) {
    rules.push({
      id: 'soul-verification',
      label: 'Verification',
      text: verification,
      source: 'profile-soul:Verification',
      scope: sourcePath || 'SOUL.md',
      required: true,
    });
  }
  return rules;
}

function readProfileMetadata(profile = {}, options = {}) {
  const fsModule = options.fs || fs;
  const env = options.env || process.env;
  const home = options.hermesHome || resolveHermesHome({ env });
  const name = String(profile.name || '').trim() || 'default';
  const profileRoot = name === 'default' ? home : path.join(home, 'profiles', name);
  const soulPath = name === 'default' ? path.join(home, 'SOUL.md') : path.join(profileRoot, 'SOUL.md');
  const profilePath = name === 'default' ? '' : path.join(profileRoot, 'profile.yaml');
  const soulContent = readIfExists(fsModule, soulPath);
  const profileYaml = profilePath ? readIfExists(fsModule, profilePath) : '';
  return {
    profileRoot,
    soulPath,
    soulContent,
    profilePath,
    description: parseProfileDescription(profileYaml),
  };
}

function profileCommandTemplate(profile = {}, options = {}) {
  const name = String(profile.name || '').trim();
  if (!name || !isSafeProfileId(name)) return '';
  const cli = shellQuote(options.cliPath || 'hermes');
  const safeQuery = 'chat -q "$HERMES_GOAL" -Q -t safe --source tool';
  if (name === 'default') return `${cli} ${safeQuery}`;
  return `${cli} -p ${shellQuote(name)} ${safeQuery}`;
}

function profileRules(profile = {}, metadata = {}) {
  const name = String(profile.name || '').trim() || 'default';
  const soulRules = rulesFromSoul(metadata.soulContent || '', metadata.soulPath || '');
  if (soulRules.length) return soulRules;
  return [
    {
      id: 'profile-isolation',
      label: 'Profile isolation',
      text: name === 'default'
        ? 'Use the default Hermes profile for delegated work unless another profile is explicitly selected.'
        : `Delegate through the ${name} Hermes profile, not the default profile.`,
      source: 'hermes-profile',
      required: true,
    },
    {
      id: 'wiki-writeback',
      label: 'Wiki write-back',
      text: 'Record durable outputs and run evidence back into LLM-Wiki when the task asks for memory or documentation.',
      source: 'hermes-agent-rule',
      required: true,
    },
    {
      id: 'safe-delegation',
      label: 'Safe delegation',
      text: 'Show provider, gateway, and command readiness before assigning a task to this agent.',
      source: 'hermes-agent-rule',
      required: true,
    },
  ];
}

function profileSkills(profile = {}, skills = [], options = {}) {
  const skillCount = Number(profile.skillCount);
  const sourceDevice = options.sourceDevice || 'mac-mini';
  const sourceRuntime = options.sourceRuntime || 'hermes-cli';
  const profileRoot = normalizeCell(profile.profileRoot) || normalizeCell(profile.path);
  const actualSkills = Array.isArray(skills)
    ? skills.filter((skill) => skill && skill.status !== 'disabled')
    : [];
  return [
    {
      id: 'hermes-cli',
      label: 'Hermes CLI',
      source: 'hermes-profile',
      sourceDevice,
      sourcePath: profileRoot,
      sourceRuntime,
      status: 'available',
      count: Number.isFinite(skillCount) ? skillCount : null,
    },
    {
      id: 'profile-alias',
      label: normalizeCell(profile.alias) ? 'Profile alias' : 'Profile switch',
      source: 'hermes-profile',
      sourceDevice,
      sourcePath: profileRoot,
      sourceRuntime,
      status: normalizeCell(profile.alias) ? 'available' : 'fallback',
      command: normalizeCell(profile.alias) || `hermes profile use ${profile.name || 'default'}`,
    },
    ...actualSkills.map((skill) => ({
      ...skill,
      sourceDevice: skill.sourceDevice || sourceDevice,
      sourcePath: skill.sourcePath || profileRoot,
      sourceRuntime: skill.sourceRuntime || sourceRuntime,
    })),
  ];
}

function profileDelegation(profile = {}, commandTemplate = '') {
  const gateway = normalizeCell(profile.gateway);
  const model = normalizeCell(profile.model);
  const inferenceProbe = profile.inferenceProbe || {};
  const blockers = [];
  if (!model) blockers.push('model-missing');
  if (!commandTemplate) blockers.push('command-template-missing');
  const assignable = blockers.length === 0;
  if (inferenceProbe.ok === true) {
    // Provider is configured; no inference blocker is needed.
  } else if (inferenceProbe.reason === 'no-inference-provider' || inferenceProbe.state === 'provider-missing') {
    blockers.push('inference-provider-not-configured');
  } else {
    blockers.push('inference-provider-unverified');
  }
  return {
    assignable,
    ready: assignable && inferenceProbe.ok === true,
    gatewayState: gateway || 'unknown',
    model: model || 'Recommended',
    commandPreview: commandTemplate,
    blockers,
    validation: inferenceProbe.ok === undefined ? undefined : inferenceProbe,
    caution: gateway && gateway !== 'running'
      ? 'Gateway is stopped. One-shot delegation can still run through the local Hermes CLI, but live gateway chat is not active.'
      : '',
  };
}

function profileToHermesAgent(profile = {}, options = {}) {
  const name = String(profile.name || '').trim();
  if (!name || !isSafeProfileId(name)) return null;
  const displayName = name;
  const model = String(profile.model || '').trim() || 'Recommended';
  const commandTemplate = profileCommandTemplate(profile, options);
  const profileWithProbe = { ...profile, inferenceProbe: options.inferenceProbe };
  const metadata = options.profileMetadata?.[name] || readProfileMetadata(profile, options);
  const title = soulTitle(metadata.soulContent || '', `Mac mini Hermes profile ${name}`);
  const mission = soulMission(metadata.soulContent || '') || metadata.description || '';
  const profileInfo = {
    name,
    path: profile.path || '',
    profileRoot: metadata.profileRoot || (metadata.soulPath ? path.dirname(metadata.soulPath) : ''),
    soulPath: metadata.soulPath || '',
    description: metadata.description || '',
    isDefault: Boolean(profile.isDefault || name === 'default'),
    gateway: normalizeCell(profile.gateway),
    provider: normalizeCell(profile.provider) || (model.includes('/') ? model.split('/')[0] : 'auto'),
    skillCount: Number.isFinite(Number(profile.skillCount)) ? Number(profile.skillCount) : null,
  };
  if ('alias' in profile) profileInfo.alias = normalizeCell(profile.alias);
  if ('distribution' in profile) profileInfo.distribution = normalizeCell(profile.distribution);

  const agentIdentity = {
    id: name,
    displayName,
    source: 'hermes-cli',
    resident: true,
    kind: 'mac-mini-hermes-profile',
  };
  const executionBackend = {
    id: 'hermes-cli',
    label: 'Hermes CLI',
    kind: 'hermes-cli',
    model,
    commandTemplate,
  };
  const runtimeBinding = {
    kind: agentIdentity.kind,
    agentKey: name,
    resident: true,
    executionBackendId: executionBackend.id,
    adapterId: executionBackend.id,
    commandTemplate,
    model,
  };

  return {
    id: name,
    displayName,
    name,
    engine: 'hermes',
    role: title,
    persona: mission ? `${title}: ${mission}` : `맥 미니 Hermes 프로필 ${name}.`,
    model,
    status: profile.gateway === 'running' ? 'Active' : 'Idle',
    tools: ['hermes-cli'],
    agentSource: agentIdentity.source,
    agentIdentity,
    executionBackend,
    runnerAdapter: { ...executionBackend },
    runtimeBinding,
    profile: profileInfo,
    rules: profileRules(profile, metadata),
    skills: profileSkills({ ...profile, ...profileInfo }, options.skills, {
      sourceDevice: options.sourceDevice || 'mac-mini',
      sourceRuntime: options.sourceRuntime || 'hermes-cli',
    }),
    delegation: profileDelegation(profileWithProbe, commandTemplate),
    hermesCliPath: options.cliPath || '',
  };
}

function profilesToHermesAgents(profiles = [], options = {}) {
  if (!Array.isArray(profiles)) return [];
  return profiles.map((profile) => profileToHermesAgent(profile, options)).filter(Boolean);
}

function listHermesCliProfiles({
  env = process.env,
  fs: fsModule = fs,
  execFile = nodeExecFile,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const cliPath = resolveHermesCliPath({ env, fs: fsModule });
  return new Promise((resolve, reject) => {
    execFile(cliPath, ['profile', 'list'], {
      timeout: Number(timeoutMs) || DEFAULT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env,
    }, (error, stdout, stderr) => {
      if (error) {
        const safeError = new Error(error.message || 'Hermes CLI profile list failed');
        safeError.code = error.code;
        safeError.signal = error.signal;
        safeError.killed = error.killed;
        safeError.cliPath = cliPath;
        safeError.stderr = String(stderr || '').slice(0, 2000);
        reject(safeError);
        return;
      }
      const stdoutText = String(stdout || '');
      if (!isHermesProfileListOutput(stdoutText)) {
        const invalidError = new Error('Hermes CLI profile list output did not contain a Profile/Model/Gateway table');
        invalidError.code = 'invalid-profile-list';
        invalidError.cliPath = cliPath;
        reject(invalidError);
        return;
      }
      resolve({
        cliPath,
        stdout: stdoutText,
        profiles: parseHermesProfileList(stdoutText),
      });
    });
  });
}

async function listHermesProfileAgents(options = {}) {
  const cliPath = resolveHermesCliPath({
    env: options.env || process.env,
    fs: options.fs || fs,
  });
  try {
    const result = await listHermesCliProfiles(options);
    const skills = await listHermesCliSkills({ ...options, cliPath: result.cliPath }).catch(() => []);
    const inferenceProbe = options.probeInference
      ? await checkHermesInferenceProvider({ ...options, cliPath: result.cliPath }).catch((error) => ({
        ok: false,
        state: 'probe-error',
        reason: error.code || 'error',
        message: error.message || 'Hermes inference probe failed',
        checkedAt: new Date().toISOString(),
      }))
      : undefined;
    const agents = profilesToHermesAgents(result.profiles, {
      ...options,
      cliPath: result.cliPath,
      skills,
      inferenceProbe,
    });
    return {
      agents,
      profiles: result.profiles,
      agentSourceStatus: {
        ok: true,
        source: 'hermes-cli',
        cliPath: result.cliPath,
        profileCount: result.profiles.length,
        skillCount: skills.length,
        inferenceProbe,
      },
    };
  } catch (error) {
    return {
      agents: [],
      profiles: [],
      agentSourceStatus: {
        ok: false,
        source: 'hermes-cli',
        cliPath: error.cliPath || cliPath,
        reason: error.code || (error.killed ? 'timeout' : 'error'),
        message: error.killed ? 'Hermes CLI profile list timed out' : (error.message || 'Hermes CLI profile list failed'),
      },
    };
  }
}

function summarizeInferenceProbeFailure(error = {}, stdout = '', stderr = '') {
  const output = `${stdout || ''}\n${stderr || ''}\n${error.message || ''}`;
  if (/No inference provider configured/i.test(output)) {
    return {
      ok: false,
      state: 'provider-missing',
      reason: 'no-inference-provider',
      message: 'No inference provider configured. Run hermes model or configure an API key in ~/.hermes/.env.',
    };
  }
  return {
    ok: false,
    state: error.killed ? 'timeout' : 'failed',
    reason: error.code || (error.killed ? 'timeout' : 'error'),
    message: String(output || 'Hermes inference probe failed').trim().slice(0, 500),
  };
}

function checkHermesInferenceProvider({
  env = process.env,
  execFile = nodeExecFile,
  timeoutMs = 15000,
  cliPath,
  prompt = 'Hermes OS provider readiness check. Reply with READY.',
} = {}) {
  const resolvedCliPath = cliPath || resolveHermesCliPath({ env, fs });
  return new Promise((resolve) => {
    execFile(resolvedCliPath, ['chat', '-q', prompt], {
      timeout: Number(timeoutMs) || 15000,
      maxBuffer: 1024 * 1024,
      env,
    }, (error, stdout, stderr) => {
      const checkedAt = new Date().toISOString();
      if (error) {
        resolve({
          ...summarizeInferenceProbeFailure(error, stdout, stderr),
          method: 'hermes chat -q',
          cliPath: resolvedCliPath,
          checkedAt,
        });
        return;
      }
      const outputFailure = summarizeInferenceProbeFailure({}, stdout, stderr);
      if (outputFailure.reason === 'no-inference-provider') {
        resolve({
          ...outputFailure,
          method: 'hermes chat -q',
          cliPath: resolvedCliPath,
          checkedAt,
        });
        return;
      }
      resolve({
        ok: true,
        state: 'ready',
        reason: '',
        message: String(stdout || '').trim().slice(0, 500),
        method: 'hermes chat -q',
        cliPath: resolvedCliPath,
        checkedAt,
      });
    });
  });
}

function listHermesCliSkills({
  env = process.env,
  execFile = nodeExecFile,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cliPath,
} = {}) {
  const resolvedCliPath = cliPath || resolveHermesCliPath({ env, fs });
  return new Promise((resolve) => {
    execFile(resolvedCliPath, ['skills', 'list'], {
      timeout: Number(timeoutMs) || DEFAULT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env,
    }, (_error, stdout) => {
      resolve(parseHermesSkillList(stdout || ''));
    });
  });
}

module.exports = {
  DEFAULT_HERMES_CLI_PATH,
  resolveHermesCliPath,
  resolveHermesHome,
  parseHermesProfileList,
  parseHermesSkillList,
  profileToHermesAgent,
  profilesToHermesAgents,
  listHermesCliProfiles,
  listHermesCliSkills,
  listHermesProfileAgents,
  checkHermesInferenceProvider,
};
