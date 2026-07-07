import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');

test('chat drawer renders schedule ingest draft cards and registration controls', () => {
  assert.match(source, /type\s+ScheduleDraft/);
  assert.match(source, /function\s+ScheduleDraftCards/);
  assert.match(source, /선택 항목 등록/);
  assert.match(source, /confidence/);
});

test('chat ingest registration uses existing task and calendar event APIs', () => {
  assert.match(source, /registerScheduleDrafts/);
  assert.match(source, /hermesApi\.createCalendarEvent|persistCreatedTask\([^)]*'calendar'/s);
  assert.match(source, /hermesApi\.createTask|persistCreatedTask\([^)]*'task'/s);
});

test('chat ingest supports one image attachment through multipart FormData', () => {
  assert.match(source, /chatAttachment/);
  assert.match(source, /type="file"/);
  assert.match(source, /accept="image\/png,image\/jpeg,image\/heic"/);
  assert.match(source, /FormData/);
  assert.match(source, /ingestSchedule/);
});
