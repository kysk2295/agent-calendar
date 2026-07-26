import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({
  root: new URL('..', import.meta.url).pathname,
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
});

test.after(async () => vite.close());

const domain = await vite.ssrLoadModule('/src/domains/work-management/workManagement.ts');

test('Work Management owns quick entry parsing', () => {
  assert.deepEqual(domain.parseQuick('보고서 작성 #업무 @agent !높음 매주 09:30', '2026-07-23'), {
    title: '보고서 작성',
    date: '2026-07-23',
    time: '09:30',
    tags: ['업무'],
    owner: 'Agent',
    repeat: 'weekly',
    priority: 'P1',
  });
});

test('Work Management round-trips embedded calendar metadata', () => {
  const item = {
    title: '도메인 회의',
    date: '2026-07-23',
    time: '10:00',
    endTime: '11:30',
    repeat: 'weekly',
    notes: '설계 검토',
  };
  const payload = domain.calendarEventPayload(item);
  assert.equal(payload.kind, 'calendar-event');
  assert.equal(payload.endTime, '11:30');
  assert.equal(payload.recurrence, 'weekly');
  assert.match(payload.notes, /\[Agent Calendar\]/);
  assert.deepEqual(domain.calendarMetadata(payload), {
    allDay: false,
    endDate: '',
    endTime: '11:30',
    repeat: 'weekly',
    repeatUntil: '',
  });
});

test('Work Management keeps taxonomy and persistence rules together', () => {
  const taxonomy = domain.parseTaxonomyRecord({
    id: 'taxonomy-1',
    title: '__agents_calendar_list:제품',
    source: 'hermes-desktop-taxonomy',
    notes: JSON.stringify({ kind: 'list', id: 'product', label: '제품', icon: '📁', group: '리스트' }),
  });
  assert.equal(taxonomy?.kind, 'list');
  assert.equal(taxonomy?.label, '제품');
  assert.equal(domain.shouldPersistTask('local-1'), false);
  assert.equal(domain.shouldPersistTask('task-1'), true);
});
