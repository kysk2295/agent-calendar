import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const apiSource = await readFile(new URL('../src/api/hermesApi.ts', import.meta.url), 'utf8');
const communicationSource = await readFile(new URL('../src/domains/communication/communication.ts', import.meta.url), 'utf8');
const chatDrawerSource = await readFile(new URL('../src/features/communication/ChatDrawer.tsx', import.meta.url), 'utf8');

test('chat drawer renders schedule ingest draft cards and registration controls', () => {
  assert.match(communicationSource, /export\s+type\s+ScheduleDraft/);
  assert.match(communicationSource, /confidence:\s*'high'\s*\|\s*'low'/);
  assert.match(chatDrawerSource, /export\s+function\s+ScheduleDraftCards/);
  assert.match(chatDrawerSource, /선택 항목 등록/);
  assert.match(chatDrawerSource, /draft\.confidence === 'low'/);
  assert.match(source, /<ChatDrawer[^\n]+registerDrafts=\{registerScheduleDrafts\}/);
});

test('chat ingest registration uses existing task and calendar event APIs', () => {
  assert.match(source, /registerScheduleDrafts/);
  assert.match(source, /hermesApi\.createCalendarEvent|persistCreatedTask\([^)]*'calendar'/s);
  assert.match(source, /hermesApi\.createTask|persistCreatedTask\([^)]*'task'/s);
});

test('chat ingest supports one image attachment through multipart FormData', () => {
  assert.match(source, /chatAttachment/);
  assert.match(chatDrawerSource, /type="file"/);
  assert.match(chatDrawerSource, /accept="image\/png,image\/jpeg,image\/heic"/);
  assert.match(source, /FormData/);
  assert.match(source, /ingestSchedule/);
  assert.match(source, /<ChatDrawer[^\n]+attachment=\{chatAttachment\}[^\n]+setAttachment=\{setChatAttachment\}/);
  assert.match(apiSource, /const SCHEDULE_INGEST_TIMEOUT_MS = 210_000/);
  assert.match(apiSource, /ingestSchedule:[^\n]+SCHEDULE_INGEST_TIMEOUT_MS/);
  assert.match(source, /이미지에서 일정과 시간을 분석하고 있어요/);
});

test('Desktop does not expose the retired duplicate calendar draft endpoint', () => {
  assert.doesNotMatch(apiSource, /draftCalendarWork/);
  assert.doesNotMatch(apiSource, /\/api\/calendar\/draft/);
});
