'use strict';

const path = require('node:path');

const REQUIRED_OFFICIAL_PROFILES = Object.freeze([
  'default',
  'bizconsultant',
  'stockagent',
  'uniportpm',
  'wikicurator',
]);

const REQUIRED_SECTIONS = Object.freeze([
  'schemaVersion',
  'officialProfiles',
  'engines',
  'ports',
  'launchAgents',
  'pathTemplates',
  'secretRegistry',
  'deploymentInputs',
  'reconstructionCommands',
  'safeRunnerCommandTemplate',
  'blockers',
]);

const SECRET_KEY_RE = /^(value|token|secret|password|accessToken|refreshToken|authorization|apiKey|api_key|clientSecret|privateKey|cookie)$/i;
// Detection pattern is intentionally non-global so RegExp.test remains stateless.
// Prefix-only shapes (synthetic lengths). Never store real credentials.
const SECRET_VALUE_SHAPE_SOURCE = String.raw`(sk-[A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|ghp_[A-Za-z0-9_]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,})`;
const SECRET_VALUE_DETECT_RE = new RegExp(SECRET_VALUE_SHAPE_SOURCE, 'i');
const ABSOLUTE_USER_PATH_SOURCE = String.raw`\/Users\/[^/\s"']+`;
const UNSAFE_RUNTIME_CAPABILITY_BLOCKER_ID = 'P0-S2-UNSAFE-RUNTIME-CAPABILITY';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function containsSecretShapedValue(value) {
  return SECRET_VALUE_DETECT_RE.test(String(value || ''));
}

function normalizeCapabilityName(value) {
  return String(value || '').trim();
}

function isForbiddenRuntimeCapability(name) {
  const text = normalizeCapabilityName(name).toLowerCase();
  if (!text) return false;
  if (text === 'no-approval-runner' || text.includes('no-approval-runner')) return true;
  if (text.includes('approval-bypass') || text.includes('approval_bypass')) return true;
  if (text.includes('bypass-approval') || text.includes('bypass_approval')) return true;
  if (text.includes('yolo')) return true;
  return false;
}

function findForbiddenRuntimeCapabilities(capabilities = []) {
  const list = Array.isArray(capabilities) ? capabilities : [];
  const found = [];
  for (const item of list) {
    const name = normalizeCapabilityName(item);
    if (!name || !isForbiddenRuntimeCapability(name)) continue;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

function buildUnsafeRuntimeCapabilityBlocker({ capabilities = [] } = {}) {
  const list = (Array.isArray(capabilities) ? capabilities : [])
    .map((item) => normalizeCapabilityName(item))
    .filter(Boolean)
    .slice(0, 40);
  const forbiddenCapabilities = findForbiddenRuntimeCapabilities(list);
  if (!forbiddenCapabilities.length) return null;
  return {
    id: UNSAFE_RUNTIME_CAPABILITY_BLOCKER_ID,
    summary: 'Runtime health advertises forbidden approval-bypass or yolo-style capabilities that conflict with production safety policy.',
    forbiddenCapabilities,
    evidence: {
      // Preserve the full redacted capability list for audit evidence.
      capabilities: list,
    },
    unblock: 'Reconfigure the execution-host runtime so health never advertises approval bypasses; product policy requires approval-bound safe runners only.',
  };
}

function collectRuntimeCapabilitiesFromInventory(inventory = {}) {
  if (Array.isArray(inventory.runtimeCapabilities)) return inventory.runtimeCapabilities;
  if (Array.isArray(inventory.runtimeHealth?.capabilities)) return inventory.runtimeHealth.capabilities;
  if (Array.isArray(inventory.runtimeHealth?.runtimeVersion?.capabilities)) {
    return inventory.runtimeHealth.runtimeVersion.capabilities;
  }
  if (Array.isArray(inventory.liveProbe?.capabilities)) return inventory.liveProbe.capabilities;
  return null;
}

function findSecretShapedValues(inventory) {
  const findings = [];
  const walk = (value, pathName) => {
    if (typeof value === 'string') {
      if (containsSecretShapedValue(value)) {
        findings.push({ path: pathName, reason: 'secret-shaped-string' });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${pathName}[${index}]`));
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        const childPath = pathName ? `${pathName}.${key}` : key;
        if (SECRET_KEY_RE.test(key) && typeof child === 'string' && child.trim()) {
          findings.push({ path: childPath, reason: 'explicit-secret-value-field' });
        }
        walk(child, childPath);
      }
    }
  };
  walk(inventory, '');
  return findings;
}

function validateMacminiRuntimeInventory(inventory) {
  const errors = [];
  if (!isPlainObject(inventory)) {
    return { ok: false, errors: ['inventory must be an object'] };
  }

  for (const section of REQUIRED_SECTIONS) {
    if (!Object.hasOwn(inventory, section)) {
      errors.push(`missing required section: ${section}`);
    }
  }

  if (inventory.schemaVersion !== 1) {
    errors.push('schemaVersion must be 1');
  }

  if (!Array.isArray(inventory.officialProfiles)) {
    errors.push('officialProfiles must be an array');
  } else {
    for (const profile of REQUIRED_OFFICIAL_PROFILES) {
      if (!inventory.officialProfiles.includes(profile)) {
        errors.push(`officialProfiles missing ${profile}`);
      }
    }
  }

  if (!Array.isArray(inventory.engines) || inventory.engines.length < 1) {
    errors.push('engines must be a non-empty array');
  } else {
    inventory.engines.forEach((engine, index) => {
      if (!isPlainObject(engine) || !engine.id || !engine.credentialOwner) {
        errors.push(`engines[${index}] must include id and credentialOwner`);
      }
    });
  }

  if (!Array.isArray(inventory.ports) || inventory.ports.length < 1) {
    errors.push('ports must be a non-empty array');
  } else {
    inventory.ports.forEach((entry, index) => {
      if (!isPlainObject(entry) || !Number.isInteger(entry.port) || !entry.service) {
        errors.push(`ports[${index}] must include integer port and service`);
      }
    });
    if (!inventory.ports.some((entry) => entry.port === 64369)) {
      errors.push('ports must include Hermes OS Runtime port 64369');
    }
  }

  if (!Array.isArray(inventory.launchAgents) || inventory.launchAgents.length < 1) {
    errors.push('launchAgents must be a non-empty array');
  }

  if (!Array.isArray(inventory.pathTemplates) || inventory.pathTemplates.length < 1) {
    errors.push('pathTemplates must be a non-empty array');
  } else if (inventory.pathTemplates.some((item) => typeof item === 'string' && item.includes('/Users/') && !item.includes('$HOME') && !item.includes('<'))) {
    errors.push('pathTemplates must use $HOME/$HERMES_HOME templates, not raw /Users/... paths');
  }

  if (!Array.isArray(inventory.secretRegistry) || inventory.secretRegistry.length < 1) {
    errors.push('secretRegistry must be a non-empty array');
  } else {
    inventory.secretRegistry.forEach((entry, index) => {
      if (!isPlainObject(entry) || !entry.name || !entry.storage) {
        errors.push(`secretRegistry[${index}] must include name and storage`);
      }
      if (Object.hasOwn(entry, 'value')) {
        errors.push(`secretRegistry[${index}] must not include value`);
      }
    });
    const names = inventory.secretRegistry.map((entry) => entry.name);
    for (const required of ['HERMES_RELAY_TOKEN', 'HERMES_REMOTE_AUTH_TOKEN', 'DATABASE_URL']) {
      if (!names.includes(required)) {
        errors.push(`secretRegistry missing required name ${required}`);
      }
    }
  }

  if (!isPlainObject(inventory.deploymentInputs)) {
    errors.push('deploymentInputs must be an object');
  } else {
    for (const key of ['railwayProjectId', 'railwayServiceId', 'expectedSourceRepo', 'healthcheckPath']) {
      if (!inventory.deploymentInputs[key]) {
        errors.push(`deploymentInputs missing ${key}`);
      }
    }
  }

  if (!Array.isArray(inventory.reconstructionCommands) || inventory.reconstructionCommands.length < 1) {
    errors.push('reconstructionCommands must be a non-empty array');
  }

  if (typeof inventory.safeRunnerCommandTemplate !== 'string' || !inventory.safeRunnerCommandTemplate.includes('-t safe')) {
    errors.push('safeRunnerCommandTemplate must include -t safe');
  }
  if (typeof inventory.safeRunnerCommandTemplate === 'string' && /--yolo|\s-z\s/.test(inventory.safeRunnerCommandTemplate)) {
    errors.push('safeRunnerCommandTemplate must not use --yolo or -z');
  }

  if (!Array.isArray(inventory.blockers)) {
    errors.push('blockers must be an array');
  }

  const runtimeCapabilities = collectRuntimeCapabilitiesFromInventory(inventory);
  if (runtimeCapabilities) {
    const forbidden = findForbiddenRuntimeCapabilities(runtimeCapabilities);
    if (forbidden.length) {
      const hasUnsafeBlocker = Array.isArray(inventory.blockers)
        && inventory.blockers.some((entry) => entry && entry.id === UNSAFE_RUNTIME_CAPABILITY_BLOCKER_ID);
      if (!hasUnsafeBlocker) {
        errors.push(
          `runtimeCapabilities include forbidden markers (${forbidden.join(', ')}) without blocker ${UNSAFE_RUNTIME_CAPABILITY_BLOCKER_ID}`,
        );
      } else {
        const blocker = inventory.blockers.find((entry) => entry && entry.id === UNSAFE_RUNTIME_CAPABILITY_BLOCKER_ID);
        const evidenceCaps = Array.isArray(blocker?.evidence?.capabilities) ? blocker.evidence.capabilities : [];
        if (!evidenceCaps.length) {
          errors.push(`${UNSAFE_RUNTIME_CAPABILITY_BLOCKER_ID} must preserve evidence.capabilities for audit`);
        }
        if (!Array.isArray(blocker.forbiddenCapabilities) || !blocker.forbiddenCapabilities.length) {
          errors.push(`${UNSAFE_RUNTIME_CAPABILITY_BLOCKER_ID} must list forbiddenCapabilities`);
        }
      }
    }
  }

  const secretFindings = findSecretShapedValues(inventory);
  secretFindings.forEach((finding) => {
    errors.push(`redaction violation at ${finding.path}: ${finding.reason}`);
  });

  return {
    ok: errors.length === 0,
    errors,
    officialProfiles: REQUIRED_OFFICIAL_PROFILES.slice(),
  };
}

function redactProbeText(value = '') {
  return String(value || '')
    .replace(new RegExp(ABSOLUTE_USER_PATH_SOURCE, 'g'), '$HOME')
    .replace(new RegExp(SECRET_VALUE_SHAPE_SOURCE, 'gi'), '[redacted-secret-shaped]')
    .replace(/\b(authorization|token|secret|password|api[_-]?key)\s*[:=]\s*([^\s,"']+)/gi, '$1=[redacted]');
}

function redactProbeValue(value, keyPath = '') {
  if (typeof value === 'string') {
    const leaf = keyPath.split('.').pop() || '';
    if (SECRET_KEY_RE.test(leaf)) {
      return value ? `[present:${value.length}chars]` : '';
    }
    return redactProbeText(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item, index) => redactProbeValue(item, `${keyPath}[${index}]`));
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const nextPath = keyPath ? `${keyPath}.${key}` : key;
      if (['value', 'token', 'secret', 'password', 'accessToken', 'authorization'].includes(key)) {
        out[key] = child ? '[redacted]' : '';
        continue;
      }
      out[key] = redactProbeValue(child, nextPath);
    }
    return out;
  }
  return value;
}

function toSafeDisplayPath(filePath = '', { repoRoot = path.resolve(__dirname, '../../../..') } = {}) {
  const absolute = path.resolve(String(filePath || ''));
  const normalizedRoot = path.resolve(repoRoot);
  const relative = path.relative(normalizedRoot, absolute);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }
  return path.basename(absolute) || 'path';
}

function formatFixtureCheckResult({
  fixturePath,
  officialProfiles = [],
  secretRegistryCount = 0,
  blockerCount = 0,
  repoRoot,
} = {}) {
  return {
    ok: true,
    mode: 'fixture',
    fixture: toSafeDisplayPath(fixturePath, { repoRoot }),
    officialProfiles,
    secretRegistryCount,
    blockerCount,
  };
}

function sanitizeRuntimeHealth(health = {}) {
  if (!isPlainObject(health)) {
    return { status: 0, reachable: false };
  }
  if (health.reachable === false || Number(health.status) === 0) {
    return {
      status: Number(health.status) || 0,
      reachable: false,
    };
  }

  const runtimeVersion = isPlainObject(health.runtimeVersion)
    ? {
      name: redactProbeText(health.runtimeVersion.name || ''),
      version: redactProbeText(health.runtimeVersion.version || ''),
      capabilities: Array.isArray(health.runtimeVersion.capabilities)
        ? health.runtimeVersion.capabilities.map((item) => redactProbeText(item)).slice(0, 40)
        : [],
    }
    : null;

  const capabilities = Array.isArray(health.capabilities)
    ? health.capabilities.map((item) => redactProbeText(item)).slice(0, 40)
    : (runtimeVersion?.capabilities || []);

  // Identity / filesystem fields are omitted rather than printed.
  return {
    status: Number(health.status) || 200,
    reachable: true,
    name: redactProbeText(health.name || ''),
    runtimeVersion,
    capabilities,
    nodeVersion: redactProbeText(health.nodeVersion || ''),
  };
}

function summarizeLocalProbe(probe = {}) {
  return {
    ok: true,
    mode: 'read-only-local-probe',
    redacted: true,
    host: redactProbeValue(probe.host || {}),
    ports: Array.isArray(probe.ports) ? probe.ports.map((entry) => ({
      port: entry.port,
      service: entry.service || '',
      listening: Boolean(entry.listening),
      status: entry.status || (entry.listening ? 'listening' : 'not-listening'),
    })) : [],
    launchAgents: Array.isArray(probe.launchAgents) ? probe.launchAgents.map((entry) => ({
      label: entry.label,
      loaded: Boolean(entry.loaded),
      state: redactProbeText(entry.state || ''),
    })) : [],
    pathPresence: Array.isArray(probe.pathPresence) ? probe.pathPresence.map((entry) => ({
      template: redactProbeText(entry.template || ''),
      present: Boolean(entry.present),
    })) : [],
    profiles: Array.isArray(probe.profiles) ? probe.profiles.map((entry) => ({
      id: entry.id,
      present: Boolean(entry.present),
    })) : [],
    versions: redactProbeValue(probe.versions || {}),
    blockers: Array.isArray(probe.blockers) ? probe.blockers.map((entry) => redactProbeValue(entry)) : [],
    runtimeHealth: probe.runtimeHealth ? sanitizeRuntimeHealth(probe.runtimeHealth) : undefined,
  };
}

function isDocumentedExecutionHostLayout({
  homeDir,
  hermesHome,
  pathExists = () => false,
} = {}) {
  const home = String(homeDir || '');
  const hermes = String(hermesHome || path.join(home, '.hermes'));
  // Derived only from $HOME / $HERMES_HOME templates — never hard-coded usernames.
  return pathExists(path.join(hermes, 'os-runtime', 'scripts', 'hermes-railway-relay-bridge.js'))
    && pathExists(path.join(home, 'Library', 'LaunchAgents', 'com.yunseo.hermes-railway-relay.plist'));
}

module.exports = {
  REQUIRED_OFFICIAL_PROFILES,
  REQUIRED_SECTIONS,
  UNSAFE_RUNTIME_CAPABILITY_BLOCKER_ID,
  buildUnsafeRuntimeCapabilityBlocker,
  containsSecretShapedValue,
  findForbiddenRuntimeCapabilities,
  findSecretShapedValues,
  formatFixtureCheckResult,
  isDocumentedExecutionHostLayout,
  isForbiddenRuntimeCapability,
  redactProbeText,
  redactProbeValue,
  sanitizeRuntimeHealth,
  summarizeLocalProbe,
  toSafeDisplayPath,
  validateMacminiRuntimeInventory,
};
