export type CommunicationRecord = Readonly<Record<string, unknown>>;

export type ScheduleDraft = {
  kind: 'event' | 'task';
  title: string;
  date: string;
  start: string | null;
  end: string | null;
  location: string | null;
  notes: string;
  confidence: 'high' | 'low';
  selected?: boolean;
};

export type CalendarAiActionDraft = {
  id: string;
  actionKind: string;
  status: string;
  input: Record<string, unknown>;
};

export type ChatMessage = {
  id?: string;
  role: string;
  text: string;
  mode?: string;
  answerMode?: string;
  coverageAugmented?: boolean;
  actionDraft?: CalendarAiActionDraft | null;
  sources?: CommunicationRecord[];
  coverage?: CommunicationRecord[];
  drafts?: ScheduleDraft[];
  warnings?: string[];
  conflicts?: CommunicationRecord[];
};

export type AttachmentInput = {
  type: string;
  size: number;
};

function isCommunicationRecord(value: unknown): value is CommunicationRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function recordValue(value: unknown): CommunicationRecord {
  return isCommunicationRecord(value) ? value : {};
}

function text(value: unknown, fallback = '') {
  return String(value || fallback);
}

function records(payload: CommunicationRecord | undefined, ...keys: string[]): CommunicationRecord[] {
  for (const key of keys) {
    const value = payload?.[key];
    if (Array.isArray(value)) return value.filter(isCommunicationRecord);
  }
  const data = recordValue(payload?.data);
  if (Object.keys(data).length) {
    const found = records(data, ...keys);
    if (found.length) return found;
  }
  const state = recordValue(payload?.state);
  return Object.keys(state).length ? records(state, ...keys) : [];
}

function strings(payload: CommunicationRecord, key: string) {
  const direct = payload[key];
  if (Array.isArray(direct)) return direct.map(String);
  const data = recordValue(payload.data);
  const nested = data[key];
  return Array.isArray(nested) ? nested.map(String) : [];
}

export function toChatMessage(item: CommunicationRecord): ChatMessage {
  const id = text(item.id);
  const mode = text(item.kind || item.mode);
  const actionDraft = calendarAiActionDraft(item.actionDraft);
  const sources = records(item, 'sources');
  const coverage = records(item, 'coverage');
  return {
    ...(id ? { id } : {}),
    role: text(item.role, 'assistant'),
    text: text(item.text || item.message || item.content || item.goal, ''),
    ...(mode ? { mode } : {}),
    ...(actionDraft ? { actionDraft } : {}),
    ...(sources.length ? { sources } : {}),
    ...(coverage.length ? { coverage } : {}),
  };
}

function calendarAiActionDraft(value: unknown): CalendarAiActionDraft | null {
  const rawDraft = recordValue(value);
  const id = text(rawDraft.id);
  if (!id) return null;
  return {
    id,
    actionKind: text(rawDraft.actionKind),
    status: text(rawDraft.status),
    input: { ...recordValue(rawDraft.input) },
  };
}

export function calendarAiMessageFromDone(payload: CommunicationRecord): ChatMessage {
  const actionDraft = calendarAiActionDraft(payload.actionDraft);
  const answerMode = text(payload.answerMode || payload.mode) || undefined;
  const coverageAugmented = payload.coverageAugmented === true || answerMode === 'llm-augmented';
  return {
    id: text(payload.turnId) || undefined,
    role: 'assistant',
    text: text(payload.answer),
    mode: text(payload.mode) || undefined,
    ...(answerMode ? { answerMode } : {}),
    ...(coverageAugmented ? { coverageAugmented: true } : {}),
    actionDraft,
    sources: records(payload, 'sources'),
    coverage: records(payload, 'coverage'),
  };
}

export function calendarAnswerHonestyLabel(message: Pick<ChatMessage, 'answerMode' | 'coverageAugmented' | 'mode'>): string {
  if (message.coverageAugmented || message.answerMode === 'llm-augmented') {
    return '근거 보강됨 · 모델 답변 뒤에 일정 완료 기록이 추가됨';
  }
  switch (message.answerMode || message.mode) {
    case 'llm':
      return '모델 답변';
    case 'llm-retry':
      return '모델 재시도 답변';
    case 'fallback':
      return '규칙 기반 답변';
    default:
      return '';
  }
}

export function normalizeCalendarChatHistory(items: CommunicationRecord[]): ChatMessage[] {
  return items
    .filter((message) => text(message.target) === 'calendar')
    .slice(-40)
    .map(toChatMessage)
    .filter((message) => message.text);
}

export function calendarChatHistoryFromPayload(payload: CommunicationRecord): ChatMessage[] {
  return normalizeCalendarChatHistory(records(payload, 'messages', 'chatMessages'));
}

export function scheduleDraftsFromPayload(payload: CommunicationRecord): ScheduleDraft[] {
  return records(payload, 'drafts').map((draft) => ({
    kind: text(draft.kind) === 'task' ? 'task' : 'event',
    title: text(draft.title, '일정 초안'),
    date: text(draft.date),
    start: text(draft.start) || null,
    end: text(draft.end) || null,
    location: text(draft.location) || null,
    notes: text(draft.notes),
    confidence: text(draft.confidence) === 'low' ? 'low' : 'high',
    selected: true,
  }));
}

export function selectedScheduleDrafts(drafts: ScheduleDraft[]) {
  return drafts.filter((draft) => draft.selected !== false && draft.title.trim() && draft.date.trim());
}

export function scheduleDraftRegistrationItem(draft: ScheduleDraft): CommunicationRecord {
  const calendarEvent = draft.kind === 'event';
  return {
    title: draft.title.trim(),
    date: draft.date.trim(),
    time: draft.start || '',
    endTime: draft.end || '',
    location: draft.location || '',
    notes: draft.notes || '',
    status: 'Planned',
    owner: 'Me',
    kind: calendarEvent ? 'calendar-event' : 'task',
    type: calendarEvent ? 'calendar-event' : 'task',
  };
}

export function normalizeScheduleIngestResponse(payload: CommunicationRecord) {
  const drafts = scheduleDraftsFromPayload(payload);
  const warnings = strings(payload, 'warnings');
  const conflicts = records(payload, 'conflicts');
  return {
    drafts,
    warnings,
    conflicts,
    summary: drafts.length
      ? `일정 초안 ${drafts.length}건을 찾았어요. 확인 후 등록됩니다.`
      : (warnings[0] || '일정 초안을 만들지 못했어요.'),
  };
}

export function validateScheduleAttachment(file: AttachmentInput) {
  if (!['image/png', 'image/jpeg', 'image/heic'].includes(file.type)) {
    return { accepted: false, error: 'png, jpeg, heic 이미지만 첨부할 수 있어요.' };
  }
  if (file.size > 10 * 1024 * 1024) {
    return { accepted: false, error: '이미지는 10MB 이하만 첨부할 수 있어요.' };
  }
  return { accepted: true, error: '' };
}

export function mailId(mail: CommunicationRecord, fallback: string) {
  return text(mail.id || mail._id || mail.key || mail.path, fallback);
}

export function mailPresentation(mail: CommunicationRecord, fallbackId: string) {
  const from = text(mail.from || mail.sender || mail.sourceLabel, 'Agent Calendar');
  return {
    id: mailId(mail, fallbackId),
    from,
    subject: text(mail.subject || mail.title, '메일'),
    preview: text(mail.preview || mail.body || mail.snippet, '메일 내용을 확인하세요.'),
    starred: Boolean(mail.star || mail.starred || mail.important),
    unread: mail.unread !== false && !mail.read,
    avatar: from.trim().slice(0, 1).toUpperCase(),
    time: text(mail.time || mail.createdAt, '방금'),
  };
}

export function optimisticMailTaskUpdate(inbox: CommunicationRecord[], id: string) {
  return inbox.map((mail, index) => (
    mailId(mail, `mail-${index}`) === id ? { ...mail, actionStatus: '기본함에 추가됨' } : mail
  ));
}
