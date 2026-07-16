export type UiPreferences = {
  notify: boolean;
  agentShare: boolean;
  weekStartMon: boolean;
};

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  notify: true,
  agentShare: true,
  weekStartMon: true,
};

type SettingsSaver = (settings: { uiPreferences: UiPreferences }) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

export function readUiPreferences(
  payload: unknown,
  fallback: UiPreferences = DEFAULT_UI_PREFERENCES,
): UiPreferences {
  const envelope = record(payload);
  const direct = record(envelope.uiPreferences);
  const nested = record(record(envelope.settings).uiPreferences);
  const source = Object.keys(direct).length ? direct : nested;
  return {
    notify: typeof source.notify === 'boolean' ? source.notify : fallback.notify,
    agentShare: typeof source.agentShare === 'boolean' ? source.agentShare : fallback.agentShare,
    weekStartMon: typeof source.weekStartMon === 'boolean' ? source.weekStartMon : fallback.weekStartMon,
  };
}

export async function persistUiPreferences({
  preferences,
  saveLocal,
  saveRemote,
}: {
  preferences: UiPreferences;
  saveLocal?: SettingsSaver;
  saveRemote: SettingsSaver;
}): Promise<UiPreferences> {
  const payload = saveLocal
    ? await saveLocal({ uiPreferences: preferences })
    : await saveRemote({ uiPreferences: preferences });
  return readUiPreferences(payload, preferences);
}
