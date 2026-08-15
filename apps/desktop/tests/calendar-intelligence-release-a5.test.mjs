import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');

function calendarAiDraftHandler() {
  const start = appSource.indexOf('async function actOnCalendarAiDraft(');
  const end = appSource.indexOf('\n  async function askWiki()', start);
  assert.notEqual(start, -1, 'Calendar AI draft handler is missing');
  assert.notEqual(end, -1, 'Calendar AI draft handler boundary is missing');
  return appSource.slice(start, end);
}

test('Calendar keeps Second Brain as context instead of adding a briefing card to the default surface', () => {
  assert.doesNotMatch(appSource, /SecondBrainCalendarBriefing/);
  assert.match(appSource, /createSecondBrainClient/);
  assert.match(appSource, /openScreen\('calendar'\)/);
});

test('Calendar AI work approval preserves raw model text while opening the returned mission', () => {
  const handler = calendarAiDraftHandler();
  const messagePatchStart = handler.indexOf('setChatMessages((current) => current.map');
  const messagePatchEnd = handler.indexOf(')));', messagePatchStart);
  const messagePatch = handler.slice(messagePatchStart, messagePatchEnd);

  assert.match(messagePatch, /\.\.\.message,[\s\S]*actionDraft:/);
  assert.doesNotMatch(messagePatch, /\btext\s*:/);
  assert.match(handler, /obj\(receipt, 'result'\)\.missionId/);
  assert.match(handler, /openScreen\('agents'\)/);
});
