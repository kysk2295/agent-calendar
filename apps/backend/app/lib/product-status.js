const CORE_CHECKS = [
  {
    id: 'browser-os',
    label: 'Browser OS shell',
    weight: 10,
    done: () => true,
  },
  {
    id: 'runtime-api',
    label: 'Runtime API and durable state',
    weight: 12,
    done: ({ state }) => Boolean(state && Array.isArray(state.agents) && Array.isArray(state.runs)),
  },
  {
    id: 'llm-wiki-writeback',
    label: 'LLM-Wiki write-back',
    weight: 12,
    done: ({ settings, state }) => Boolean(settings.wikiRoot && state && Array.isArray(state.runs) && state.runs.length),
  },
  {
    id: 'remote-access',
    label: 'Remote browser access',
    weight: 12,
    done: ({ settings, state, publicUrl }) => Boolean(publicUrl || settings.remote?.publicBaseUrl || state.remoteVerification?.reachable),
  },
  {
    id: 'scheduler-autopilot',
    label: 'Scheduler and autopilot',
    weight: 10,
    done: ({ state }) => Boolean(Array.isArray(state.schedulerJobs) && state.schedulerJobs.length && state.daemon?.running),
  },
  {
    id: 'web-command-router',
    label: 'Web command routing',
    weight: 10,
    done: ({ state }) => Boolean(Array.isArray(state.runs) && state.runs.some((run) => run.source === 'web-command')),
  },
  {
    id: 'ticktick-live',
    label: 'TickTick live activation',
    weight: 12,
    done: ({ settings }) => Boolean(settings.ticktick?.accessToken),
  },
  {
    id: 'telegram-live',
    label: 'Telegram live activation',
    weight: 12,
    done: ({ settings }) => Boolean(settings.telegram?.botToken && settings.telegram?.allowedChatIds?.length),
  },
  {
    id: 'runner-adapters',
    label: 'Real runner adapters',
    weight: 10,
    done: ({ settings }) => Boolean(settings.runner?.mode === 'local-command' && settings.runner?.allowShellCommands && settings.runner?.command),
  },
  {
    id: 'productization',
    label: 'Product packaging and onboarding',
    weight: 10,
    done: ({ settings }) => Boolean(settings.product?.packaged),
  },
];

const ROADMAP = [
  {
    id: 'connector-activation',
    label: 'Activate TickTick and Telegram for real operation',
    detail: 'Provision TickTick and Telegram runtime env vars, then let Hermes bootstrap sync/webhook server-side.',
  },
  {
    id: 'runner-adapters',
    label: 'Add real model/tool runner adapters',
    detail: 'Route research, coding, wiki, and content work to concrete Codex/Claude/Grok/local-command adapters.',
  },
  {
    id: 'long-run-resume',
    label: 'Harden day-scale autonomous runs',
    detail: 'Add checkpoint cadence, pause reasons, cost/time guards, and automatic resume brief save points.',
  },
  {
    id: 'stable-remote-url',
    label: 'Stabilize remote access URL',
    detail: 'Replace disposable quick tunnel URLs with a named Cloudflare tunnel or Tailscale address.',
  },
  {
    id: 'productization',
    label: 'Package as always-on personal OS',
    detail: 'Add session polish, persistent DB boundaries, onboarding, and mobile QA.',
  },
];

function publicSettings(settings = {}) {
  return {
    remote: {
      publicBaseUrl: settings.remote?.publicBaseUrl || '',
      tunnelProvider: settings.remote?.tunnelProvider || '',
    },
    ticktick: {
      connected: Boolean(settings.ticktick?.accessToken),
      oauthReady: Boolean(settings.ticktick?.clientId && settings.ticktick?.clientSecret),
    },
    telegram: {
      botTokenSaved: Boolean(settings.telegram?.botToken),
      allowedChatCount: Array.isArray(settings.telegram?.allowedChatIds) ? settings.telegram.allowedChatIds.length : 0,
    },
    runner: {
      mode: settings.runner?.mode || 'simulated',
      allowShellCommands: Boolean(settings.runner?.allowShellCommands),
      commandConfigured: Boolean(settings.runner?.command),
    },
    wikiRoot: settings.wikiRoot || '',
  };
}

function buildProductStatus({ settings = {}, state = {}, readiness = null, publicUrl = '' } = {}) {
  const safeSettings = publicSettings(settings);
  const context = { settings, state, publicUrl };
  const completed = [];
  const missing = [];
  let earned = 0;
  const total = CORE_CHECKS.reduce((sum, check) => sum + check.weight, 0);

  for (const check of CORE_CHECKS) {
    const done = Boolean(check.done(context));
    const item = { id: check.id, label: check.label, weight: check.weight };
    if (done) {
      completed.push(item);
      earned += check.weight;
    } else {
      missing.push(item);
    }
  }

  return {
    name: 'Hermes OS',
    stage: 'personal MVP',
    progressPercent: Math.round((earned / total) * 100),
    publicUrl: publicUrl || safeSettings.remote.publicBaseUrl,
    readiness: readiness?.summary || null,
    settings: safeSettings,
    completed,
    missing,
    next: ROADMAP.filter((item) => missing.some((missingItem) => missingItem.id === item.id) || item.id === 'connector-activation').slice(0, 5),
  };
}

module.exports = {
  buildProductStatus,
};
