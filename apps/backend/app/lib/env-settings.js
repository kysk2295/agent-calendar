function parseBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseInteger(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseMailAccountsJson(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((account) => ({
        id: String(account.id || `${account.provider || 'mail'}:${account.email || account.username || ''}`).trim(),
        provider: String(account.provider || 'gmail').trim().toLowerCase(),
        email: String(account.email || account.username || '').trim(),
        username: String(account.username || account.email || '').trim(),
        password: String(account.password || '').trim(),
        accessToken: String(account.accessToken || '').trim(),
        host: String(account.host || '').trim(),
        port: Number(account.port || 993),
        secure: account.secure !== false,
        enabled: account.enabled !== false,
      }))
      .filter((account) => account.email || account.username);
  } catch {
    return [];
  }
}

function readPath(object, path) {
  return path.split('.').reduce((value, key) => (value && value[key] !== undefined ? value[key] : undefined), object);
}

function setPath(object, path, value) {
  const keys = path.split('.');
  let cursor = object;
  keys.slice(0, -1).forEach((key) => {
    cursor[key] = cursor[key] || {};
    cursor = cursor[key];
  });
  cursor[keys[keys.length - 1]] = value;
}

function hasExistingValue(current, path) {
  const value = readPath(current, path);
  if (path === 'runner.mode' && value === 'simulated') return false;
  if (path === 'runner.allowShellCommands' && value === false) return false;
  if (path === 'runner.timeoutMs' && Number(value) === 300000) return false;
  if (path === 'runner.cwd' && !readPath(current, 'runner.command')) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  return Boolean(String(value || '').trim());
}

const ENV_DEFINITIONS = [
  { env: 'HERMES_TICKTICK_ACCESS_TOKEN', path: 'ticktick.accessToken' },
  { env: 'HERMES_TICKTICK_REFRESH_TOKEN', path: 'ticktick.refreshToken' },
  { env: 'HERMES_TICKTICK_CLIENT_ID', path: 'ticktick.clientId' },
  { env: 'HERMES_TICKTICK_CLIENT_SECRET', path: 'ticktick.clientSecret' },
  { env: 'HERMES_TELEGRAM_BOT_TOKEN', path: 'telegram.botToken' },
  { env: 'HERMES_TELEGRAM_ALLOWED_CHAT_IDS', path: 'telegram.allowedChatIds', transform: parseCsv },
  { env: 'HERMES_MAIL_ACCOUNTS_JSON', path: 'mail.accounts', transform: parseMailAccountsJson },
  { env: 'HERMES_REMOTE_PUBLIC_BASE_URL', path: 'remote.publicBaseUrl' },
  { env: 'HERMES_PUBLIC_BASE_URL', path: 'remote.publicBaseUrl' },
  { env: 'HERMES_REMOTE_AUTH_TOKEN', path: 'auth.accessToken' },
  { env: 'HERMES_RUNNER_MODE', path: 'runner.mode' },
  { env: 'HERMES_RUNNER_ALLOW_SHELL', path: 'runner.allowShellCommands', transform: parseBoolean },
  { env: 'HERMES_RUNNER_COMMAND', path: 'runner.command' },
  { env: 'HERMES_RUNNER_CWD', path: 'runner.cwd' },
  { env: 'HERMES_RUNNER_TIMEOUT_MS', path: 'runner.timeoutMs', transform: parseInteger },
];

function collectEnvSettings(env = process.env, { current = {}, overwrite = false } = {}) {
  const settings = {};
  const imported = [];
  const claimedPaths = new Set();

  for (const definition of ENV_DEFINITIONS) {
    const raw = env[definition.env];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    if (claimedPaths.has(definition.path)) continue;
    if (!overwrite && hasExistingValue(current, definition.path)) continue;
    const value = definition.transform ? definition.transform(raw) : String(raw).trim();
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
    setPath(settings, definition.path, value);
    imported.push({ env: definition.env, path: definition.path });
    claimedPaths.add(definition.path);
  }

  return { settings, imported };
}

module.exports = {
  collectEnvSettings,
  parseBoolean,
  parseCsv,
  parseMailAccountsJson,
};
