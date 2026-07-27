'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  projectPublicDisplayEvent,
  publicDisplayTuple,
} = require('../app/lib/public-work-conversation-event');

test('public Work Conversation projection keeps only user-meaningful credential-free events', () => {
  const rows = [
    {
      id: 'evt_user',
      sequence: 1,
      kind: 'user_message',
      payload: { text: 'Continue from Telegram', origin: 'telegram', token: 'private' },
      created_at: '2026-07-26T00:00:00.000Z',
    },
    {
      id: 'evt_progress',
      sequence: 2,
      kind: 'progress',
      payload: { text: 'raw runner progress', metadata: { command: 'private command' } },
      created_at: '2026-07-26T00:00:01.000Z',
    },
    {
      id: 'evt_tool',
      sequence: 3,
      kind: 'tool_activity',
      payload: { text: 'raw tool output', metadata: { raw: 'private output' } },
      created_at: '2026-07-26T00:00:02.000Z',
    },
    {
      id: 'evt_artifact',
      sequence: 4,
      kind: 'artifact',
      payload: { text: 'private artifact', metadata: { path: '/private/result' } },
      created_at: '2026-07-26T00:00:03.000Z',
    },
    {
      id: 'evt_answer',
      sequence: 5,
      kind: 'completion',
      payload: {
        text: 'Current Calendar result password=hunter2',
        origin: 'execution',
        metadata: {
          resolvedExecutionEngine: 'codex',
          credential: 'must-not-project',
          raw: 'must-not-project',
        },
      },
      created_at: '2026-07-26T00:00:04.000Z',
    },
    {
      id: 'evt_approval',
      sequence: 6,
      kind: 'approval_request',
      payload: { text: 'Approve the supported calendar change?', origin: 'agent' },
      created_at: '2026-07-26T00:00:05.000Z',
    },
    {
      id: 'evt_error',
      sequence: 7,
      kind: 'error',
      payload: { text: 'Calendar update failed: token=private', origin: 'calendar' },
      created_at: '2026-07-26T00:00:06.000Z',
    },
  ];

  const projected = rows
    .map((row) => projectPublicDisplayEvent(row, { sessionId: 'session_public' }))
    .filter(Boolean);

  assert.deepEqual(
    projected.map(publicDisplayTuple),
    [
      [1, 'user_message', 'Continue from Telegram', 'telegram'],
      [5, 'completion', 'Current Calendar result password=[REDACTED]', 'execution'],
      [6, 'approval_request', 'Approve the supported calendar change?', 'agent'],
      [7, 'error', 'Calendar update failed: token=[REDACTED]', 'calendar'],
    ],
  );
  assert.deepEqual(projected[1].metadata, { resolvedExecutionEngine: 'codex' });
  assert.doesNotMatch(JSON.stringify(projected), /hunter2|must-not-project|private output|private artifact/);
});

test('public Work Conversation projection rejects lifecycle noise but keeps final agent answers', () => {
  const project = (kind, payload, sequence) => projectPublicDisplayEvent({
    id: `evt_${sequence}`,
    sequence,
    kind,
    payload,
    created_at: `2026-07-26T00:00:0${sequence}.000Z`,
  }, { sessionId: 'session_public' });

  assert.equal(project('agent_message', {
    text: 'Runner accepted the job',
    metadata: { jobId: 'job_1', phase: 'accepted' },
  }, 1), null);
  assert.deepEqual(
    publicDisplayTuple(project('agent_message', {
      text: 'Final agent answer',
      origin: 'execution',
      metadata: { jobId: 'job_1', source: 'live_work_turn' },
    }, 2)),
    [2, 'agent_message', 'Final agent answer', 'execution'],
  );
  assert.equal(project('completion', {
    text: 'Codex execution completed',
    metadata: { jobId: 'job_1' },
  }, 3), null);
});

test('public Work Conversation projection preserves the existing 8000-character text contract', () => {
  const text = '가'.repeat(8_000);
  const projected = projectPublicDisplayEvent({
    id: 'evt_long_public_text',
    sequence: 1,
    kind: 'user_message',
    payload: { text, origin: 'desktop' },
    created_at: '2026-07-26T00:00:00.000Z',
  }, { sessionId: 'session_public' });

  assert.equal(projected.text, text);
  assert.equal(projected.text.length, 8_000);
});
