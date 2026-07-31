import { useEffect, useRef, useState } from 'react';
import {
  calendarAnswerHonestyLabel,
  validateScheduleAttachment,
  type ChatMessage,
  type CalendarAiActionDraft,
  type CommunicationRecord,
  type ScheduleDraft,
} from '../../domains/communication/communication';
import { buildMorningBriefingPrompt, latestAssistantSpeech } from '../voice/voiceAssistant';

type SpeechRecognitionResultEventLike = {
  readonly results: ArrayLike<{ readonly 0: { readonly transcript: string } }>;
};

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechRecognitionWindow = Window & {
  readonly SpeechRecognition?: SpeechRecognitionConstructor;
  readonly webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

type ChatDrawerProps = {
  readonly messages: ChatMessage[];
  readonly input: string;
  readonly setInput: (value: string) => void;
  readonly attachment: File | null;
  readonly setAttachment: (value: File | null) => void;
  readonly send: (messageOverride?: string) => Promise<void>;
  readonly busy: boolean;
  readonly setChip: (value: string) => void;
  readonly close: () => void;
  readonly registerDrafts: (drafts: ScheduleDraft[]) => Promise<void>;
  readonly memories: CommunicationRecord[];
  readonly memoryOpen: boolean;
  readonly toggleMemory: () => void;
  readonly updateMemory: (id: string, value: string) => Promise<void>;
  readonly forgetMemory: (id: string) => Promise<void>;
  readonly purgeMemory: (id: string) => Promise<void>;
  readonly actOnDraft: (draft: CalendarAiActionDraft, action: 'approve' | 'revise' | 'cancel', input?: Record<string, unknown>) => Promise<void>;
  readonly actionBusyId: string;
};

function text(value: unknown, fallback = ''): string {
  return String(value || fallback);
}

function isRecord(value: unknown): value is CommunicationRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function recordValue(value: unknown): CommunicationRecord {
  return isRecord(value) ? value : {};
}

function objectValue(payload: CommunicationRecord, key: string): CommunicationRecord {
  const value = payload[key];
  if (isRecord(value)) return value;
  const data = recordValue(payload.data);
  if (Object.keys(data).length) return objectValue(data, key);
  const state = recordValue(payload.state);
  if (Object.keys(state).length) return objectValue(state, key);
  return {};
}

function actionLabel(kind: string) {
  if (kind === 'calendar_create') return '일정 만들기';
  if (kind === 'calendar_update') return '일정 수정';
  if (kind === 'calendar_delete') return '일정 삭제';
  if (kind === 'delegate_work') return '에이전트에게 위임';
  return '작업 실행';
}

function dateTimeValue(value: unknown) {
  const raw = text(value);
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function CalendarAiDraftCard({
  draft,
  busy,
  act,
}: {
  readonly draft: CalendarAiActionDraft;
  readonly busy: boolean;
  readonly act: ChatDrawerProps['actOnDraft'];
}) {
  const [title, setTitle] = useState(text(draft.input.title || draft.input.goal));
  const completed = draft.status === 'completed';
  const cancelled = draft.status === 'cancelled';
  const schedulePatch = recordValue(draft.input.patch);
  const startsAt = draft.input.startsAt || schedulePatch.startsAt;
  const endsAt = draft.input.endsAt || schedulePatch.endsAt;
  const revisedInput = draft.actionKind === 'delegate_work'
    ? { title: title.trim(), goal: title.trim() }
    : { title: title.trim() };
  return <section className="calendar-ai-action" data-status={draft.status}>
    <div className="calendar-ai-action-heading">
      <strong>{actionLabel(draft.actionKind)}</strong>
      <span>{completed ? '실행 완료' : cancelled ? '취소됨' : '승인 전 초안'}</span>
    </div>
    <input aria-label="Calendar AI 작업 제목" value={title} disabled={completed || cancelled || busy} onChange={(event) => setTitle(event.target.value)} />
    {Boolean(startsAt) && <small>{dateTimeValue(startsAt)}{endsAt ? ` - ${dateTimeValue(endsAt)}` : ''}</small>}
    {!completed && !cancelled && <div className="calendar-ai-action-buttons">
      <button disabled={busy || !title.trim()} onClick={() => void act(draft, 'approve', revisedInput)}>{busy ? '처리 중' : '승인하고 실행'}</button>
      <button disabled={busy || title.trim() === text(draft.input.title || draft.input.goal)} onClick={() => void act(draft, 'revise', revisedInput)}>초안 수정</button>
      <button disabled={busy} onClick={() => void act(draft, 'cancel')}>취소</button>
    </div>}
  </section>;
}

function CalendarAiMemoryRow({
  memory,
  updateMemory,
  forgetMemory,
  purgeMemory,
}: {
  readonly memory: CommunicationRecord;
  readonly updateMemory: ChatDrawerProps['updateMemory'];
  readonly forgetMemory: ChatDrawerProps['forgetMemory'];
  readonly purgeMemory: ChatDrawerProps['purgeMemory'];
}) {
  const [value, setValue] = useState(text(memory.value));
  const [busy, setBusy] = useState(false);
  const active = text(memory.status) === 'active';
  return <div className="calendar-ai-memory-row" data-status={text(memory.status)}>
    <input aria-label="개인 기억 내용" value={value} disabled={!active || busy} onChange={(event) => setValue(event.target.value)} />
    <small>{active ? '사용자가 직접 저장한 기억' : '잊은 기억'}</small>
    {active && <div>
      <button disabled={busy || !value.trim() || value.trim() === text(memory.value)} onClick={async () => { setBusy(true); try { await updateMemory(text(memory.id), value.trim()); } finally { setBusy(false); } }}>저장</button>
      <button disabled={busy} onClick={async () => { setBusy(true); try { await forgetMemory(text(memory.id)); } finally { setBusy(false); } }}>잊기</button>
    </div>}
    {!active && <div><button disabled={busy} onClick={async () => { setBusy(true); try { await purgeMemory(text(memory.id)); } finally { setBusy(false); } }}>완전 삭제</button></div>}
  </div>;
}

export function ScheduleDraftCards({ drafts, warnings = [], conflicts = [], registerDrafts }: { readonly drafts: ScheduleDraft[]; readonly warnings?: string[]; readonly conflicts?: CommunicationRecord[]; readonly registerDrafts: (drafts: ScheduleDraft[]) => Promise<void> }) {
  const [items, setItems] = useState<ScheduleDraft[]>(() => drafts.map((draft) => ({ ...draft, selected: draft.selected !== false })));
  const [cancelled, setCancelled] = useState(false);
  const [saving, setSaving] = useState(false);
  if (cancelled) return <div className="draft-cancelled">초안을 취소했습니다.</div>;
  const updateDraft = (index: number, patch: Partial<ScheduleDraft>) => {
    setItems((current) => current.map((draft, draftIndex) => (draftIndex === index ? { ...draft, ...patch } : draft)));
  };
  const conflictText = (index: number) => conflicts
    .filter((conflict) => Number(conflict.draftIndex) === index)
    .map((conflict) => {
      const existing = objectValue(conflict, 'existing');
      return text(existing.title || conflict.title || conflict.existing, '기존 일정');
    })
    .join(' · ');
  return <div className="draft-list">
    {warnings.length > 0 && <div className="draft-warning">{warnings.join('\n')}</div>}
    {items.map((draft, index) => {
      const conflict = conflictText(index);
      return <section className="draft-card" key={`${draft.title}-${index}`}>
        <label className="draft-check"><input type="checkbox" checked={draft.selected !== false} onChange={(event) => updateDraft(index, { selected: event.target.checked })} /><span>{draft.kind === 'task' ? '할 일' : '일정'}</span>{draft.confidence === 'low' && <b>확인 필요</b>}</label>
        <input aria-label="초안 제목" value={draft.title} onChange={(event) => updateDraft(index, { title: event.target.value })} />
        <div className="draft-grid">
          <input aria-label="초안 날짜" value={draft.date} onChange={(event) => updateDraft(index, { date: event.target.value })} />
          <input aria-label="초안 시작 시간" value={draft.start || ''} onChange={(event) => updateDraft(index, { start: event.target.value || null })} />
          <input aria-label="초안 종료 시간" value={draft.end || ''} onChange={(event) => updateDraft(index, { end: event.target.value || null })} />
        </div>
        {draft.notes && <small>{draft.notes}</small>}
        {conflict && <em>충돌: {conflict}</em>}
      </section>;
    })}
    <div className="draft-actions">
      <button disabled={saving || !items.some((draft) => draft.selected !== false)} onClick={async () => { setSaving(true); await registerDrafts(items); setSaving(false); }}>
        {saving ? '등록 중' : '선택 항목 등록'}
      </button>
      <button onClick={() => setCancelled(true)}>취소</button>
    </div>
  </div>;
}

export function ChatDrawer({
  messages,
  input,
  setInput,
  attachment,
  setAttachment,
  send,
  busy,
  setChip,
  close,
  registerDrafts,
  memories,
  memoryOpen,
  toggleMemory,
  updateMemory,
  forgetMemory,
  purgeMemory,
  actOnDraft,
  actionBusyId,
}: ChatDrawerProps) {
  const [attachmentError, setAttachmentError] = useState('');
  const [voiceStatus, setVoiceStatus] = useState('');
  const [listening, setListening] = useState(false);
  const [voiceReplyPending, setVoiceReplyPending] = useState(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceRequestStartCountRef = useRef(0);
  const followingLatestRef = useRef(true);
  const previousMessageCountRef = useRef(0);
  const speechRecognitionWindow = window as SpeechRecognitionWindow;
  const speechRecognitionConstructor = speechRecognitionWindow.SpeechRecognition || speechRecognitionWindow.webkitSpeechRecognition;
  const voiceInputSupported = Boolean(speechRecognitionConstructor);
  const voiceOutputSupported = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  useEffect(() => {
    setVoiceStatus(voiceInputSupported
      ? '음성 질문을 들을 준비가 됐어요.'
      : '이 환경에서는 음성 인식을 사용할 수 없어요. 텍스트 질문과 답변 낭독은 계속 사용할 수 있어요.');
  }, [voiceInputSupported]);
  useEffect(() => () => {
    recognitionRef.current?.stop();
    window.speechSynthesis?.cancel();
  }, []);
  useEffect(() => {
    if (!voiceReplyPending || busy || messages.length <= voiceRequestStartCountRef.current) return;
    const answer = latestAssistantSpeech(messages);
    if (!answer) return;
    setVoiceReplyPending(false);
    if (!voiceOutputSupported) {
      setVoiceStatus('답변은 도착했지만 이 환경에서는 음성 재생을 사용할 수 없어요.');
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(answer);
    utterance.lang = 'ko-KR';
    utterance.rate = 1;
    window.speechSynthesis.speak(utterance);
    setVoiceStatus('답변을 음성으로 읽고 있어요.');
  }, [busy, messages, voiceOutputSupported, voiceReplyPending]);
  useEffect(() => {
    const container = messagesRef.current;
    if (!container) return;
    const previousCount = previousMessageCountRef.current;
    const addedMessages = previousCount <= messages.length ? messages.slice(previousCount) : messages;
    if (previousCount === 0 || messages.length < previousCount || addedMessages.some((message) => message.role === 'user')) {
      followingLatestRef.current = true;
    }
    previousMessageCountRef.current = messages.length;
    if (followingLatestRef.current) container.scrollTop = container.scrollHeight;
  }, [messages, voiceStatus]);
  const trackLatestScroll = () => {
    const container = messagesRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - (container.scrollTop + container.clientHeight);
    followingLatestRef.current = distanceFromBottom <= 24;
  };
  const chooseAttachment = (file: File | undefined) => {
    if (!file) return;
    const validation = validateScheduleAttachment(file);
    if (!validation.accepted) {
      setAttachmentError(validation.error);
      return;
    }
    setAttachmentError('');
    setAttachment(file);
  };
  const submitVoiceTurn = (message: string) => {
    const value = message.trim();
    if (!value || busy) return;
    voiceRequestStartCountRef.current = messages.length;
    setVoiceReplyPending(true);
    setVoiceStatus('캘린더와 할 일을 확인하고 있어요.');
    void send(value);
  };
  const startMorningBriefing = () => submitVoiceTurn(buildMorningBriefingPrompt());
  const toggleListening = () => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    if (!speechRecognitionConstructor || busy) return;
    const recognition = new speechRecognitionConstructor();
    recognition.lang = 'ko-KR';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onstart = () => {
      setListening(true);
      setVoiceStatus('듣고 있어요. 자연스럽게 말씀하세요.');
    };
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim() || '';
      if (transcript) submitVoiceTurn(transcript);
    };
    recognition.onerror = () => {
      setListening(false);
      setVoiceStatus('음성을 듣지 못했어요. 마이크 권한을 확인하고 다시 시도해 주세요.');
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = recognition;
    recognition.start();
  };
  return <aside className="chat">
    <header><img className="chat-mark" src="./agent-calendar-logo.png" alt="" draggable={false} /><div><strong>캘린더 AI</strong><span>대화 · 일정 · 에이전트 작업</span></div><button className="calendar-ai-memory-toggle" onClick={toggleMemory} aria-pressed={memoryOpen}>기억 {memories.filter((memory) => text(memory.status) === 'active').length}</button><button onClick={close} aria-label="캘린더 AI 닫기">✕</button></header>
    {memoryOpen && <section className="calendar-ai-memories" aria-label="개인 기억">
      <div><strong>개인 기억</strong><span>직접 저장한 내용만 대화에 사용합니다.</span></div>
      {memories.length
        ? memories.map((memory, index) => <CalendarAiMemoryRow key={text(memory.id, `memory-${index}`)} memory={memory} updateMemory={updateMemory} forgetMemory={forgetMemory} purgeMemory={purgeMemory} />)
        : <p>저장된 개인 기억이 없습니다. 대화에서 “기억해줘”라고 말해 보세요.</p>}
    </section>}
    <section className="voice-assistant" aria-label="음성 비서">
      <div>
        <strong>오늘의 음성 브리핑</strong>
        <span>{voiceStatus}</span>
      </div>
      <div>
        <button type="button" className="voice-briefing-button" disabled={busy} onClick={startMorningBriefing} aria-label="아침 브리핑 시작">아침 브리핑</button>
        <button type="button" className="voice-mic-button" data-listening={listening} disabled={!voiceInputSupported || busy} onClick={toggleListening} aria-label={listening ? '음성 질문 듣기 중지' : '음성으로 질문'}>{listening ? '■' : '●'}</button>
      </div>
    </section>
    <div className="messages" ref={messagesRef} onScroll={trackLatestScroll}>{messages.map((message, index) => {
      const honesty = message.role === 'assistant' ? calendarAnswerHonestyLabel(message) : '';
      return <div className={`message ${message.role}`} key={message.id || index}><span>{message.text || '응답 수신 중...'}</span>{honesty ? <em className="calendar-ai-honesty" data-mode={message.answerMode || message.mode || ''}>{honesty}</em> : null}{message.coverage?.some((coverage) => text(coverage.state) !== 'complete') && <em className="calendar-ai-coverage">일부 연결 일정의 조회 범위가 완전하지 않습니다.</em>}{message.sources?.length ? <div className="calendar-ai-sources">{message.sources.slice(0, 5).map((source, sourceIndex) => <span key={text(source.id || source.handle, `source-${sourceIndex}`)}>{text(source.title, '근거')}</span>)}</div> : null}{message.actionDraft ? <CalendarAiDraftCard draft={message.actionDraft} busy={actionBusyId === message.actionDraft.id} act={actOnDraft} /> : null}{message.drafts?.length ? <ScheduleDraftCards drafts={message.drafts} warnings={message.warnings} conflicts={message.conflicts} registerDrafts={registerDrafts} /> : null}</div>;
    })}</div>
    <div className="chat-chips">{['이번 주 완료율?', '오늘 할 일 정리해줘', '이번 주 빈 시간 알려줘'].map((chip) => <button key={chip} onClick={() => setChip(chip)}>{chip}</button>)}</div>
    <footer>
      <div className="chat-compose">
        {attachment && <div className="chat-attachment"><span>{attachment.name}</span><button type="button" onClick={() => setAttachment(null)} aria-label="첨부 이미지 제거">×</button></div>}
        {attachmentError && <div className="chat-attachment-error">{attachmentError}</div>}
        <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="일정이나 할 일을 물어보세요" />
      </div>
      <div className="chat-send-stack">
        <label className="chat-attach-button" title="이미지 첨부">
          <input type="file" accept="image/png,image/jpeg,image/heic" onChange={(event) => chooseAttachment(event.target.files?.[0])} />
          <span>첨부</span>
        </label>
        <button onClick={() => void send()}>전송</button>
      </div>
    </footer>
  </aside>;
}
