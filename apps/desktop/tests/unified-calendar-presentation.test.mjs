import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({
  root: new URL('..', import.meta.url).pathname,
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
});

test.after(async () => vite.close());

const presentation = await vite.ssrLoadModule('/src/domains/work-management/unifiedCalendarPresentation.ts');

test('coverageSummary distinguishes complete vs incomplete', () => {
  assert.equal(presentation.coverageSummary([]), '소스 없음');
  assert.equal(
    presentation.coverageSummary([{ sourceId: 's1', state: 'complete', label: 'Google' }]),
    '커버리지 완료 · 소스 1',
  );
  assert.match(
    presentation.coverageSummary([
      { sourceId: 's1', state: 'unsynchronized', label: 'Google' },
      { sourceId: 'internal', state: 'complete' },
    ]),
    /불완전/,
  );
  assert.match(
    presentation.coverageSummary([{ sourceId: 's1', state: 'stale', label: 'G' }]),
    /불완전/,
  );
});

test('sourceBadge and mapUnifiedEntries preserve source-aware fields', () => {
  const mapped = presentation.mapUnifiedEntriesToCalendarEvents([
    {
      id: 'external:src:key',
      entryId: 'cocc_1',
      sourceId: 'src_google',
      sourceKind: 'external_calendar',
      provider: 'google',
      sourceLabel: 'Google Calendar',
      providerEventId: 'gev_1',
      title: 'Google timed meeting',
      allDay: false,
      startsAt: '2026-07-24T01:00:00.000Z',
      endsAt: '2026-07-24T02:00:00.000Z',
      writable: true,
      etag: '"e1"',
    },
    {
      id: 'internal:agent-1',
      entryId: 'agent-1',
      sourceId: 'agent_work',
      sourceKind: 'agent_work',
      provider: 'agent_work',
      title: 'Agent result: report',
      startsAt: '2026-07-24T12:00:00.000Z',
      endsAt: '2026-07-24T13:00:00.000Z',
      writable: false,
      status: 'rework',
    },
    {
      id: 'internal:int-1',
      entryId: 'int-1',
      sourceId: 'internal',
      sourceKind: 'internal',
      provider: 'internal',
      title: 'Internal meeting',
      allDay: true,
      startsAt: '2026-07-24T00:00:00.000Z',
      endsAt: '2026-07-25T00:00:00.000Z',
      writable: true,
    },
  ]);

  assert.equal(mapped.length, 3);
  assert.equal(mapped[0].sourceLabel, 'Google Calendar');
  assert.equal(mapped[0].providerEventId, 'gev_1');
  assert.equal(mapped[0].isExternal, true);
  assert.equal(mapped[0].time, '01:00');
  assert.equal(mapped[1].source, 'agent-work');
  assert.equal(mapped[1].writable, false);
  assert.equal(mapped[1].origin, 'agent');
  assert.equal(mapped[1].status, 'rework');
  assert.equal(mapped[1].lifecycleStatus, 'rework');
  assert.equal(mapped[1].agentTaskState, 'rework');
  assert.equal(mapped[1].agentTaskLabel, '재작업');
  assert.equal(mapped[2].allDay, true);
  assert.equal(mapped[2].time, '');
  assert.equal(presentation.sourceBadge({
    sourceKind: 'external_calendar',
    provider: 'google',
    sourceLabel: '',
  }), 'Google');
  assert.equal(presentation.sourceBadge(mapped[0]), 'Google Calendar');
  assert.equal(presentation.monthSourceBadge(mapped[0]), 'Google Calendar');
  assert.equal(presentation.monthSourceBadge(mapped[2]), '');
  assert.equal(presentation.isReadOnlyCalendarEntry(mapped[1]), true);
  assert.equal(presentation.isExternalWritableEvent(mapped[0]), true);
});
