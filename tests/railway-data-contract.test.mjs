import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../src/api/hermesApi.ts', import.meta.url), 'utf8');

test('calendar renders only Railway tasks/events for a date, never fallback filler rows', () => {
  assert.equal(appSource.includes('calendarItems.slice(fallbackIndex'), false);
  assert.equal(appSource.includes('matched.length ? matched : calendarItems.slice'), false);
});

test('calendar-created work is persisted as calendar events, not tasks', () => {
  assert.match(appSource, /hermesApi\.createCalendarEvent\(/);
  assert.match(appSource, /hermesApi\.updateCalendarEvent\(/);
  assert.match(appSource, /hermesApi\.deleteCalendarEvent\(/);
  assert.doesNotMatch(appSource, /hermesApi\.updateTask\(remoteId,\s*patch\)/);
  assert.doesNotMatch(appSource, /source:\s*'calendar'/);
  assert.match(apiSource, /createCalendarEvent:/);
  assert.match(apiSource, /updateCalendarEvent:/);
  assert.match(apiSource, /deleteCalendarEvent:/);
  assert.match(apiSource, /\/api\/calendar\/events/);
});

test('desktop task mutations keep TickTick as one-time import source only', () => {
  assert.match(appSource, /syncTickTick:\s*false/);
  assert.equal(appSource.includes('hermesApi.updateTask(id, { ...taskPayload(snapshot), syncTickTick: false })'), true);
  assert.equal(appSource.includes('hermesApi.deleteTask(id, { syncTickTick: false })'), true);
});

test('desktop list and tag metadata are persisted to Railway without TickTick sync', () => {
  assert.match(appSource, /source:\s*TAXONOMY_SOURCE/);
  assert.match(appSource, /taxonomyKind:\s*item\.kind/);
  assert.match(appSource, /syncTickTick:\s*false/);
});

test('desktop taxonomy can be edited and hidden through Railway metadata records', () => {
  assert.match(appSource, /recordId\?:\s*string/);
  assert.match(appSource, /function updateTaxonomy\(/);
  assert.match(appSource, /function hideTaxonomy\(/);
  assert.match(appSource, /hermesApi\.updateTask\(item\.recordId/);
  assert.match(appSource, /hidden:\s*true/);
  assert.match(appSource, /className="taxonomy-manager"/);
});

test('calendar CRUD persists duration, all-day, and recurrence through Railway event fields', () => {
  assert.match(appSource, /const CALENDAR_META_MARKER/);
  assert.match(appSource, /function calendarMetadata\(/);
  assert.match(appSource, /function calendarNotes\(/);
  assert.match(appSource, /payload\.recurrence\s*=/);
  assert.match(appSource, /payload\.allDay\s*=/);
  assert.match(appSource, /payload\.endDate\s*=/);
  assert.match(appSource, /payload\.endTime\s*=/);
  assert.match(appSource, /const patchItem = isEvent \? patchCalendarEvent : patchTask/);
  assert.match(appSource, /patchItem\(selectedTask,\s*\{\s*allDay:/);
  assert.match(appSource, /patchCalendarEvent\(selectedTask,\s*\{\s*endDate:/);
});

test('task surfaces exclude calendar-only event records', () => {
  assert.match(appSource, /function isCalendarEventRecord\(/);
  assert.match(appSource, /function isTaskRecord\(/);
  assert.match(appSource, /rawTasks\.filter\(isTaskRecord\)/);
  assert.match(appSource, /const scheduledTaskItems = filteredTasks\.filter/);
});

test('wiki graph is interactive and wiki ask uses Railway LLM endpoint', () => {
  assert.match(apiSource, /askWiki:/);
  assert.match(apiSource, /\/api\/wiki\/ask/);
  assert.match(appSource, /function askWiki\(/);
  assert.doesNotMatch(appSource, /위키 기반 요약입니다\. 관련 문서와 최근 작업을 함께 검토하세요/);
  assert.match(appSource, /const \[graphZoom,\s*setGraphZoom\]/);
  assert.match(appSource, /const \[graphPan,\s*setGraphPan\]/);
  assert.match(appSource, /onWheel=\{/);
  assert.match(appSource, /wiki-graph-controls/);
});

test('sidebar removes fixed mock note and someday tabs and topbar search', () => {
  assert.equal(appSource.includes("navKey: 'list:notes'"), false);
  assert.equal(appSource.includes("navKey: 'list:someday'"), false);
  assert.equal(appSource.includes('className="top-search"'), false);
});

test('list editor uses modal emoji picker and preserves folder-edit image pattern', () => {
  assert.match(appSource, /type ModalId = .*'taxonomy'/);
  assert.match(appSource, /function TaxonomyModal\(/);
  assert.match(appSource, /className="emoji-picker"/);
  assert.match(appSource, /className="taxonomy-modal"/);
  assert.equal(appSource.includes('onFocus={() => setPickerOpen(true)}'), false);
});

test('task completion animates before the row disappears', () => {
  assert.match(appSource, /completingTaskIds/);
  assert.match(appSource, /setTimeout\(\(\) => patchTask\(task,\s*\{\s*status:\s*'Done'/);
  assert.match(appSource, /data-completing/);
});

test('gmail mail connection is wired to Railway mail endpoints', () => {
  assert.match(apiSource, /saveMailAccount:/);
  assert.match(apiSource, /syncMail:/);
  assert.match(appSource, /function connectGmail\(/);
  assert.match(appSource, /hermesApi\.saveMailAccount/);
  assert.match(appSource, /hermesApi\.syncMail/);
  assert.match(appSource, /provider:\s*'gmail'/);
});

test('task list adopts TickTick-style inspector and scan-friendly rows', () => {
  assert.match(appSource, /function TaskInspectorPane\(/);
  assert.match(appSource, /className="list-screen ticktick-list-screen/);
  assert.match(appSource, /className="task-due"/);
  assert.match(appSource, /만료됨/);
  assert.match(appSource, /연기하다/);
  assert.match(appSource, /onDoubleClick=\{\(\) => openTask\(task\)\}/);
});
