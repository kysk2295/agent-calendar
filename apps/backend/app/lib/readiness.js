function makeItem(input) {
  const { id, label, ready, detail, nextAction } = input;
  return {
    ...input,
    id,
    label,
    ready: Boolean(ready),
    tone: ready ? 'mint' : 'amber',
    detail,
    nextAction: ready ? 'Ready' : nextAction,
  };
}

const SETUP_ACTIONS = {
  remote: {
    id: 'setup-remote',
    target: 'Remote access',
    detail: 'Set the public base URL and a bearer access token so the Mac mini can be reached from the web.',
    primary: 'Set URL and token',
    view: 'settings',
    focusId: 'settingsPublicBaseUrl',
    commandId: 'remoteStatusBtn',
  },
  ticktick: {
    id: 'setup-ticktick',
    target: 'TickTick system token',
    detail: 'Provision HERMES_TICKTICK_ACCESS_TOKEN on the runtime so Hermes can sync #hermes, #agent, #auto, or /hermes tasks without GUI setup.',
    primary: 'Import env token',
    view: 'settings',
    focusId: 'settingsTickTickToken',
    commandId: 'bootstrapSystemConnectionsBtn',
  },
  telegram: {
    id: 'setup-telegram',
    target: 'Telegram system webhook',
    detail: 'Provision HERMES_TELEGRAM_BOT_TOKEN and HERMES_TELEGRAM_ALLOWED_CHAT_IDS on the runtime; Hermes registers the webhook server-side.',
    primary: 'Bootstrap webhook',
    view: 'settings',
    focusId: 'settingsTelegramToken',
    commandId: 'bootstrapSystemConnectionsBtn',
  },
  runner: {
    id: 'setup-runner',
    target: 'Hermes runner',
    detail: 'Switch runner mode to local-command, allow shell execution, and point command/cwd at the Hermes runtime on the Mac mini.',
    primary: 'Configure runner',
    view: 'settings',
    focusId: 'settingsRunnerCommand',
    commandId: 'testRunnerBtn',
  },
  scheduler: {
    id: 'setup-scheduler',
    target: 'Scheduler daemon',
    detail: 'Create at least one enabled scheduler job and start the resident daemon loop.',
    primary: 'Start scheduler',
    view: 'automation',
    focusId: 'schedulerNameInput',
    commandId: 'startDaemonBtn',
  },
  launchd: {
    id: 'setup-launchd',
    target: 'LaunchAgent',
    detail: 'Write the launchd plist and bootstrap it so Hermes OS comes back after reboot.',
    primary: 'Write plist',
    view: 'automation',
    focusId: 'launchdTargetPathInput',
    commandId: 'writeLaunchdBtn',
  },
};

function buildSetupActions(items) {
  return items
    .filter((item) => !item.ready)
    .map((item) => ({
      ...SETUP_ACTIONS[item.id],
      label: item.nextAction,
      primary: item.primary || SETUP_ACTIONS[item.id]?.primary,
      commandId: item.commandId || SETUP_ACTIONS[item.id]?.commandId,
      tone: 'amber',
    }))
    .filter((action) => action.id);
}

function buildConnectorReadiness({
  settings = {},
  schedulerJobs = [],
  daemonStatus = {},
  deploymentStatus = {},
  remoteVerification = null,
} = {}) {
  const ticktick = settings.ticktick || {};
  const telegram = settings.telegram || {};
  const runner = settings.runner || {};
  const remote = settings.remote || {};
  const auth = settings.auth || {};
  const allowedTelegramChats = Array.isArray(telegram.allowedChatIds) ? telegram.allowedChatIds.filter(Boolean) : [];
  const enabledJobs = schedulerJobs.filter((job) => job && job.enabled !== false);
  const remoteVerificationKnown = Boolean(remoteVerification && remoteVerification.checkedAt);
  const remoteVerificationFailed = Boolean(remoteVerificationKnown && remoteVerification.reachable === false);
  const remoteReady = Boolean(remote.publicBaseUrl && auth.accessToken && !remoteVerificationFailed);
  const remoteDetail = !remote.publicBaseUrl
    ? 'No public URL configured'
    : remoteVerificationFailed
      ? (remoteVerification.error || 'Public URL verification failed')
      : remoteVerificationKnown && remoteVerification.reachable
        ? `Verified ${remoteVerification.checkedAt}`
        : remote.publicBaseUrl;

  const items = [
    makeItem({
      id: 'remote',
      label: 'Remote access',
      ready: remoteReady,
      detail: remoteDetail,
      nextAction: remoteVerificationFailed ? 'Fix or verify public route' : 'Set public URL and access token',
      primary: remoteVerificationFailed ? 'Verify public route' : undefined,
      commandId: remoteVerificationFailed ? 'verifyRemoteAccessBtn' : undefined,
    }),
    makeItem({
      id: 'ticktick',
      label: 'TickTick',
      ready: Boolean(ticktick.accessToken),
      detail: ticktick.accessToken
        ? (ticktick.clientId ? 'System token + OAuth client saved' : 'System token saved')
        : 'No system access token',
      nextAction: 'Provision HERMES_TICKTICK_ACCESS_TOKEN',
    }),
    makeItem({
      id: 'telegram',
      label: 'Telegram',
      ready: Boolean(telegram.botToken && remote.publicBaseUrl && allowedTelegramChats.length),
      detail: !telegram.botToken
        ? 'No system bot token'
        : allowedTelegramChats.length
          ? `${allowedTelegramChats.length} allowed chats`
          : 'Allowed chat ids required',
      nextAction: 'Provision bot token, allowed chat ids, and public URL',
    }),
    makeItem({
      id: 'runner',
      label: 'Local runner',
      ready: runner.mode === 'local-command' && Boolean(runner.allowShellCommands && runner.command),
      detail: runner.mode === 'local-command' ? (runner.command || 'No command') : 'Simulated mode',
      nextAction: 'Enable local-command runner with command',
    }),
    makeItem({
      id: 'scheduler',
      label: 'Scheduler',
      ready: Boolean(daemonStatus.running && enabledJobs.length),
      detail: `${enabledJobs.length} enabled jobs · daemon ${daemonStatus.running ? 'running' : 'stopped'}`,
      nextAction: 'Create enabled job and start daemon',
    }),
    makeItem({
      id: 'launchd',
      label: 'Launchd',
      ready: Boolean(deploymentStatus.ready),
      detail: deploymentStatus.ready ? 'LaunchAgent plist ready' : 'LaunchAgent not ready',
      nextAction: 'Write plist and check deployment',
    }),
  ];

  const readyCount = items.filter((item) => item.ready).length;
  return {
    items,
    actions: buildSetupActions(items),
    summary: {
      readyCount,
      total: items.length,
      allReady: readyCount === items.length,
      blocking: items.filter((item) => !item.ready).map((item) => item.id),
    },
  };
}

module.exports = {
  buildConnectorReadiness,
};
