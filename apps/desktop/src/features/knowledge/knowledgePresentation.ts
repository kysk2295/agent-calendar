type Item = Record<string, unknown>;

export const WIKI_GROUP_COLORS: Record<string, string> = { 업무: 'var(--accent)', 주식: '#7C5CBF', 인생: '#C99A3B', 회고: '#3E9B72', 일기: '#3B7DD8', 기타: '#9A9080', '0_inbox': '#D7613D', '1_raw': '#C7963C', '2_wiki': '#3B7DD8', '3_output': '#3E9B72', '4_journal': '#7C6DD8', '5_conversation': '#A75F48', '6_agents': '#5D8A7D', '7_automation': '#8E7A58' };

function isItem(value: unknown): value is Item {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isItemArray(value: unknown): value is Item[] {
  return Array.isArray(value) && value.every(isItem);
}

export function arr(payload: Item | undefined, ...keys: string[]): Item[] {
  for (const key of keys) {
    const value = payload?.[key];
    if (isItemArray(value)) return value;
  }
  const data = payload?.data;
  if (isItem(data)) {
    const found = arr(data, ...keys);
    if (found.length) return found;
  }
  const state = payload?.state;
  if (isItem(state)) {
    const found = arr(state, ...keys);
    if (found.length) return found;
  }
  return [];
}

export function obj(payload: Item | undefined, key: string): Item {
  const value = payload?.[key];
  if (isItem(value)) return value;
  const data = payload?.data;
  if (isItem(data)) return obj(data, key);
  const state = payload?.state;
  if (isItem(state)) return obj(state, key);
  return {};
}

export function text(value: unknown, fallback = ''): string {
  return String(value || fallback);
}

export function itemTitle(item: Item, fallback = '항목'): string {
  return text(item.title || item.goal || item.name || item.subject || item.label || item.text || item.path, fallback);
}

export function itemId(item: Item, fallback: string): string {
  return text(item.id || item._id || item.key || item.path, fallback);
}
