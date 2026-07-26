import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({
  root: new URL('..', import.meta.url).pathname,
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
});

test.after(async () => vite.close());

const domain = await vite.ssrLoadModule('/src/domains/communication/communication.ts');

test('Communication normalizes calendar-only chat history', () => {
  const messages = domain.normalizeCalendarChatHistory([
    { target: 'calendar', role: 'user', message: '오늘 일정' },
    { target: 'wiki', role: 'assistant', text: '위키 답변' },
    { target: 'calendar', role: 'assistant', content: '오후 3시가 비어 있어요.' },
    { target: 'calendar', role: 'assistant', text: '' },
  ]);

  assert.deepEqual(messages, [
    { role: 'user', text: '오늘 일정' },
    { role: 'assistant', text: '오후 3시가 비어 있어요.' },
  ]);
});

test('Calendar AI stream metadata becomes an actionable assistant message', () => {
  const message = domain.calendarAiMessageFromDone({
    turnId: 'turn-1',
    answer: '초안을 확인해 주세요.',
    mode: 'action_draft',
    actionDraft: {
      id: 'draft-1',
      actionKind: 'calendar_create',
      status: 'pending_approval',
      input: {
        title: '팀 회의',
        startsAt: '2026-07-25T01:00:00.000Z',
        endsAt: '2026-07-25T02:00:00.000Z',
      },
    },
    coverage: [{ sourceId: 'internal', label: 'Agent Calendar', state: 'complete' }],
    sources: [{ id: 'event-1', title: '기존 일정' }],
  });

  assert.equal(message.id, 'turn-1');
  assert.equal(message.mode, 'action_draft');
  assert.equal(message.actionDraft?.id, 'draft-1');
  assert.equal(message.actionDraft?.input.title, '팀 회의');
  assert.equal(message.coverage?.[0]?.state, 'complete');
  assert.equal(message.sources?.[0]?.title, '기존 일정');
});

test('Communication parses, filters, and maps schedule drafts', () => {
  const drafts = domain.scheduleDraftsFromPayload({
    drafts: [
      { kind: 'event', title: '고객 미팅', date: '2026-07-24', start: '10:00', end: '11:00', location: '회의실 A', notes: '제안서 검토' },
      { kind: 'task', title: '후속 메일', date: '2026-07-24', confidence: 'low', selected: false },
      { kind: 'task', title: ' ', date: '2026-07-24' },
    ],
  });

  assert.deepEqual(drafts[0], {
    kind: 'event',
    title: '고객 미팅',
    date: '2026-07-24',
    start: '10:00',
    end: '11:00',
    location: '회의실 A',
    notes: '제안서 검토',
    confidence: 'high',
    selected: true,
  });
  assert.equal(drafts[1].confidence, 'low');
  assert.equal(drafts[1].selected, true);
  assert.deepEqual(domain.selectedScheduleDrafts(drafts.map((draft, index) => (
    index === 1 ? { ...draft, selected: false } : draft
  ))), [drafts[0]]);
  assert.deepEqual(domain.scheduleDraftRegistrationItem(drafts[0]), {
    title: '고객 미팅',
    date: '2026-07-24',
    time: '10:00',
    endTime: '11:00',
    location: '회의실 A',
    notes: '제안서 검토',
    status: 'Planned',
    owner: 'Me',
    kind: 'calendar-event',
    type: 'calendar-event',
  });
});

test('Communication normalizes schedule ingest drafts, warnings, conflicts, and summary', () => {
  assert.deepEqual(domain.normalizeScheduleIngestResponse({
    data: {
      drafts: [{ kind: 'task', title: '견적 검토', date: '2026-07-25' }],
      warnings: ['시간을 확인해 주세요.'],
      conflicts: [{ draftIndex: 0, existing: { title: '기존 일정' } }],
    },
  }), {
    drafts: [{
      kind: 'task',
      title: '견적 검토',
      date: '2026-07-25',
      start: null,
      end: null,
      location: null,
      notes: '',
      confidence: 'high',
      selected: true,
    }],
    warnings: ['시간을 확인해 주세요.'],
    conflicts: [{ draftIndex: 0, existing: { title: '기존 일정' } }],
    summary: '일정 초안 1건을 찾았어요. 확인 후 등록됩니다.',
  });
  assert.equal(domain.normalizeScheduleIngestResponse({ warnings: ['날짜를 찾지 못했어요.'] }).summary, '날짜를 찾지 못했어요.');
});

test('Communication enforces the image attachment policy', () => {
  assert.deepEqual(domain.validateScheduleAttachment({ type: 'image/png', size: 10 * 1024 * 1024 }), { accepted: true, error: '' });
  assert.deepEqual(domain.validateScheduleAttachment({ type: 'application/pdf', size: 1 }), {
    accepted: false,
    error: 'png, jpeg, heic 이미지만 첨부할 수 있어요.',
  });
  assert.deepEqual(domain.validateScheduleAttachment({ type: 'image/heic', size: 10 * 1024 * 1024 + 1 }), {
    accepted: false,
    error: '이미지는 10MB 이하만 첨부할 수 있어요.',
  });
});

test('Communication derives mail presentation and the supported task update', () => {
  const inbox = [
    { _id: 'mail-1', sender: 'Alice', title: '계약 검토', snippet: '검토 부탁드립니다.', important: true },
    { id: 'mail-2', from: 'Bob', subject: '회의', preview: '내일 만나요.' },
  ];
  assert.deepEqual(domain.mailPresentation(inbox[0], 'mail-0'), {
    id: 'mail-1',
    from: 'Alice',
    subject: '계약 검토',
    preview: '검토 부탁드립니다.',
    starred: true,
    unread: true,
    avatar: 'A',
    time: '방금',
  });
  assert.deepEqual(domain.optimisticMailTaskUpdate(inbox, 'mail-1')[0], { ...inbox[0], actionStatus: '기본함에 추가됨' });
  assert.equal('optimisticMailArchiveUpdate' in domain, false);
  assert.equal('optimisticMailStarUpdate' in domain, false);
  assert.equal('gmailAccountInput' in domain, false);
  assert.equal('normalizeGmailSyncResponse' in domain, false);
});
