'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { generateEd25519Keypair, fingerprint, formatFingerprint } = require('./crypto');

function defaultStateDir(env = process.env) {
  if (env.AGENT_CALENDAR_RUNNER_HOME) {
    return path.resolve(env.AGENT_CALENDAR_RUNNER_HOME);
  }
  return path.join(os.homedir(), '.agent-calendar-runner');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows may ignore mode
  }
}

function writePrivateFile(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore
  }
}

function loadOrCreateIdentity(stateDir) {
  ensureDir(stateDir);
  const keyPath = path.join(stateDir, 'device-key.json');
  if (fs.existsSync(keyPath)) {
    const parsed = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    return {
      publicKey: parsed.publicKey,
      privateKey: parsed.privateKey,
      fingerprint: fingerprint(parsed.publicKey),
      fingerprintGrouped: formatFingerprint(fingerprint(parsed.publicKey)),
      path: keyPath,
    };
  }
  const keys = generateEd25519Keypair();
  const payload = {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    createdAt: new Date().toISOString(),
  };
  writePrivateFile(keyPath, `${JSON.stringify(payload, null, 2)}\n`);
  return {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    fingerprint: fingerprint(keys.publicKey),
    fingerprintGrouped: formatFingerprint(fingerprint(keys.publicKey)),
    path: keyPath,
  };
}

function loadState(stateDir) {
  const statePath = path.join(stateDir, 'state.json');
  if (!fs.existsSync(statePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(stateDir, state) {
  ensureDir(stateDir);
  const statePath = path.join(stateDir, 'state.json');
  writePrivateFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return statePath;
}

function knowledgeSourcesPath(stateDir) {
  return path.join(stateDir, 'knowledge-sources.json');
}

function listKnowledgeSources(stateDir) {
  const filePath = knowledgeSourcesPath(stateDir);
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed.sources) ? parsed.sources : [];
  } catch {
    return [];
  }
}

function registerKnowledgeSource(stateDir, { sourceId, path: sourcePath, label = '' } = {}) {
  const id = String(sourceId || '').trim();
  if (!id) {
    throw Object.assign(new Error('sourceId is required'), { code: 'KNOWLEDGE_SOURCE_ID_REQUIRED' });
  }
  const resolvedPath = path.resolve(String(sourcePath || ''));
  if (!sourcePath || !fs.existsSync(resolvedPath)) {
    throw Object.assign(new Error('local source path does not exist'), { code: 'KNOWLEDGE_SOURCE_PATH_INVALID' });
  }
  const realPath = fs.realpathSync(resolvedPath);
  const sources = listKnowledgeSources(stateDir).filter((source) => source.sourceId !== id);
  sources.push({
    sourceId: id,
    path: realPath,
    label: String(label || path.basename(realPath)).slice(0, 200),
    updatedAt: new Date().toISOString(),
  });
  sources.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  ensureDir(stateDir);
  writePrivateFile(
    knowledgeSourcesPath(stateDir),
    `${JSON.stringify({ sources }, null, 2)}\n`,
  );
  return sources.find((source) => source.sourceId === id);
}

function removeKnowledgeSource(stateDir, sourceId) {
  const id = String(sourceId || '').trim();
  const current = listKnowledgeSources(stateDir);
  const sources = current.filter((source) => source.sourceId !== id);
  if (sources.length === current.length) return false;
  writePrivateFile(
    knowledgeSourcesPath(stateDir),
    `${JSON.stringify({ sources }, null, 2)}\n`,
  );
  return true;
}

module.exports = {
  defaultStateDir,
  ensureDir,
  loadOrCreateIdentity,
  listKnowledgeSources,
  loadState,
  registerKnowledgeSource,
  removeKnowledgeSource,
  saveState,
  writePrivateFile,
};
