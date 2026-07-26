'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildWorkspaceScheduleIngestDrafts,
  parseScheduleIngestRequest,
} = require('../app/lib/workspace-schedule-ingest');
const { resolveWorkspaceScope } = require('../app/lib/workspace-scope');

async function issuedScope(workspaceId, userId = 'user-a', role = 'owner') {
  return resolveWorkspaceScope({
    query: async () => ({ rowCount: 1, rows: [{ role }] }),
  }, { workspaceId, userId });
}

function multipart(parts, boundary = 'agent-calendar-boundary') {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n${part.headers.join('\r\n')}\r\n\r\n`, 'utf8'));
    chunks.push(Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body, 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    buffer: Buffer.concat(chunks),
  };
}

test('bounded ingest parser accepts text and one supported image without trusting workspace fields', () => {
  const request = multipart([
    {
      headers: ['Content-Disposition: form-data; name="text"'],
      body: '7월 30일 오전 9시 회의 등록해줘',
    },
    {
      headers: ['Content-Disposition: form-data; name="workspaceId"'],
      body: 'forged-workspace',
    },
    {
      headers: [
        'Content-Disposition: form-data; name="image"; filename="schedule.png"',
        'Content-Type: image/png',
      ],
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    },
  ]);

  const parsed = parseScheduleIngestRequest(request);
  assert.equal(parsed.textInput, '7월 30일 오전 9시 회의 등록해줘');
  assert.equal(parsed.imageFile.filename, 'schedule.png');
  assert.equal(parsed.imageFile.contentType, 'image/png');
  assert.deepEqual(parsed.imageFile.buffer, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.equal('workspaceId' in parsed, false);
});

test('ingest parser rejects malformed multipart and unsupported attachments', () => {
  assert.throws(
    () => parseScheduleIngestRequest({
      contentType: 'multipart/form-data',
      buffer: Buffer.from('missing boundary'),
    }),
    (error) => error.code === 'INVALID_MULTIPART' && error.statusHint === 400,
  );

  const unsupported = multipart([{
    headers: [
      'Content-Disposition: form-data; name="image"; filename="calendar.pdf"',
      'Content-Type: application/pdf',
    ],
    body: Buffer.from('%PDF'),
  }]);
  assert.throws(
    () => parseScheduleIngestRequest(unsupported),
    (error) => error.code === 'UNSUPPORTED_INGEST_MEDIA_TYPE' && error.statusHint === 415,
  );
});

test('Workspace ingest checks only the authenticated Workspace calendar and never persists drafts', async () => {
  const scopeA = await issuedScope('workspace-a');
  const queries = [];
  const writes = [];
  const runtime = {
    product: {
      createCalendarEvent: async (...args) => writes.push(['event', ...args]),
      createTask: async (...args) => writes.push(['task', ...args]),
      listCalendarEvents: async () => [],
    },
    unifiedCalendar: {
      queryRange: async (scope, range) => {
        queries.push({ scope, range });
        return {
          ok: true,
          workspaceId: scope.workspaceId,
          entries: scope.workspaceId === 'workspace-a'
            ? [{
              id: 'workspace-a-event',
              sourceKind: 'external_calendar',
              title: 'Workspace A 기존 회의',
              startsAt: '2026-07-30T00:30:00.000Z',
              endsAt: '2026-07-30T01:30:00.000Z',
              timezone: 'Asia/Seoul',
            }]
            : [{
              id: 'workspace-b-event',
              sourceKind: 'external_calendar',
              title: 'Workspace B 비밀 회의',
              startsAt: '2026-07-30T00:30:00.000Z',
              endsAt: '2026-07-30T01:30:00.000Z',
              timezone: 'Asia/Seoul',
            }],
          coverage: [],
        };
      },
    },
    scheduleIngestCompletion: async () => JSON.stringify({
      drafts: [{
        kind: 'event',
        title: '새 회의',
        date: '2026-07-30',
        start: '09:00',
        end: '10:00',
        location: null,
        notes: '원문: 7월 30일 오전 9시 회의',
        confidence: 'high',
      }],
      warnings: [],
    }),
  };

  const result = await buildWorkspaceScheduleIngestDrafts({
    scope: scopeA,
    request: {
      textInput: '7월 30일 오전 9시 회의 등록해줘',
      imageFile: null,
    },
    runtime,
    env: {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.workspaceId, 'workspace-a');
  assert.equal(result.drafts.length, 1);
  assert.deepEqual(
    result.conflicts.map((conflict) => conflict.existing.id),
    ['workspace-a-event'],
  );
  assert.equal(JSON.stringify(result).includes('workspace-b'), false);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].scope, scopeA);
  assert.match(queries[0].range.from, /^2026-07-29T/);
  assert.match(queries[0].range.to, /^2026-08-01T/);
  assert.deepEqual(writes, []);
});

test('Workspace ingest returns an honest empty draft when no extraction runner is available', async () => {
  const scopeA = await issuedScope('workspace-a', 'user-a', 'member');
  const result = await buildWorkspaceScheduleIngestDrafts({
    scope: scopeA,
    request: { textInput: '내일 3시 회의 등록해줘', imageFile: null },
    runtime: {
      product: {},
      unifiedCalendar: {
        queryRange: async () => {
          throw new Error('calendar query must not run without drafts');
        },
      },
    },
    env: {},
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.drafts, []);
  assert.ok(result.warnings.some((warning) => warning.includes('LLM URL')));
  assert.deepEqual(result.conflicts, []);
});
