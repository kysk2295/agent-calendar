const fs = require('node:fs');
const path = require('node:path');

function redactSecret(value) {
  if (!value) return null;
  const text = String(value);
  if (text.length <= 4) return '••••';
  return `${'•'.repeat(Math.max(4, text.length - 4))}${text.slice(-4)}`;
}

function mergeObjects(base, next) {
  const output = { ...base };
  for (const [key, value] of Object.entries(next || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = mergeObjects(base[key] || {}, value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function publicMailAccounts(accounts = []) {
  return (Array.isArray(accounts) ? accounts : []).map((account) => ({
    id: account.id || `${account.provider || 'mail'}:${account.email || account.username || ''}`,
    provider: account.provider || 'mail',
    email: account.email || '',
    username: account.username || account.email || '',
    host: account.host || '',
    port: Number(account.port) || 993,
    secure: account.secure !== false,
    enabled: account.enabled !== false,
    connected: Boolean((account.username || account.email) && (account.password || account.accessToken)),
    password: redactSecret(account.password),
    accessToken: redactSecret(account.accessToken),
    lastSyncAt: account.lastSyncAt || '',
    lastError: account.lastError || '',
  }));
}

function defaultSettings() {
  return {
    ticktick: {
      accessToken: '',
      refreshToken: '',
      expiresAt: '',
      clientId: '',
      clientSecret: '',
      apiBase: 'https://api.ticktick.com',
    },
    telegram: {
      botToken: '',
      allowedChatIds: [],
    },
    mail: {
      accounts: [],
    },
    runner: {
      mode: 'simulated',
      allowShellCommands: false,
      command: '',
      cwd: process.cwd(),
      timeoutMs: 300000,
    },
    remote: {
      publicBaseUrl: '',
      tunnelProvider: 'manual',
    },
    auth: {
      accessToken: '',
    },
    autopilot: {
      enabled: false,
      intervalMs: 60000,
    },
    uiPreferences: {
      notify: true,
      agentShare: true,
      weekStartMon: true,
    },
    wikiRoot: '/Users/koyunseo/Library/Mobile Documents/com~apple~CloudDocs/LLM-Wiki',
  };
}

class SecretStore {
  constructor({ dataDir } = {}) {
    this.dataDir = dataDir || path.resolve(process.cwd(), 'work/hermes-os-data');
    this.path = path.join(this.dataDir, 'secrets.json');
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  getSettings() {
    if (!fs.existsSync(this.path)) {
      const settings = defaultSettings();
      this.#save(settings);
      return settings;
    }
    return mergeObjects(defaultSettings(), JSON.parse(fs.readFileSync(this.path, 'utf8')));
  }

  saveSettings(nextSettings) {
    const settings = mergeObjects(this.getSettings(), nextSettings || {});
    this.#save(settings);
    return this.getPublicSettings();
  }

  getPublicSettings() {
    const settings = this.getSettings();
    return {
      ticktick: {
        connected: Boolean(settings.ticktick.accessToken),
        accessToken: redactSecret(settings.ticktick.accessToken),
        refreshToken: redactSecret(settings.ticktick.refreshToken),
        expiresAt: settings.ticktick.expiresAt || '',
        clientId: settings.ticktick.clientId || '',
        clientSecret: redactSecret(settings.ticktick.clientSecret),
        apiBase: settings.ticktick.apiBase,
      },
      telegram: {
        connected: Boolean(settings.telegram.botToken),
        botToken: redactSecret(settings.telegram.botToken),
        allowedChatIds: settings.telegram.allowedChatIds || [],
      },
      mail: {
        accounts: publicMailAccounts(settings.mail?.accounts),
      },
      runner: {
        mode: settings.runner.mode,
        allowShellCommands: Boolean(settings.runner.allowShellCommands),
        commandConfigured: Boolean(String(settings.runner.command || '').trim()),
        cwd: settings.runner.cwd || process.cwd(),
        timeoutMs: Number(settings.runner.timeoutMs) || 300000,
      },
      remote: {
        publicBaseUrl: settings.remote.publicBaseUrl || '',
        tunnelProvider: settings.remote.tunnelProvider || 'manual',
      },
      auth: {
        enabled: Boolean(settings.auth.accessToken),
        accessToken: redactSecret(settings.auth.accessToken),
      },
      autopilot: {
        enabled: Boolean(settings.autopilot.enabled),
        intervalMs: Number(settings.autopilot.intervalMs) || 60000,
      },
      uiPreferences: {
        notify: settings.uiPreferences?.notify !== false,
        agentShare: settings.uiPreferences?.agentShare !== false,
        weekStartMon: settings.uiPreferences?.weekStartMon !== false,
      },
      wikiRoot: settings.wikiRoot,
    };
  }

  saveTickTickTokens(tokens) {
    return this.saveSettings({
      ticktick: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      },
    });
  }

  #save(settings) {
    fs.writeFileSync(this.path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }
}

module.exports = {
  SecretStore,
  redactSecret,
};
