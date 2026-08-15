import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');

function functionSource(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} is missing`);
  const bodyMarker = source.indexOf('\n  ) {', start);
  assert.notEqual(bodyMarker, -1, `${signature} has no body`);
  const bodyStart = bodyMarker + 5;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`${signature} has no closing brace`);
}

test('approving delegate_work opens the existing agents conversation for that mission', () => {
  const handler = functionSource(appSource, 'async function actOnCalendarAiDraft(');

  assert.match(handler, /obj\(payload, 'receipt'\)/);
  assert.match(handler, /obj\(receipt, 'result'\)/);
  assert.match(handler, /action === 'approve'[\s\S]*draft\.actionKind === 'delegate_work'/);
  assert.match(handler, /await refreshAgentOperations\(\)/);
  assert.match(handler, /openScreen\('agents'\)/);
  assert.match(handler, /data-work-mission/);
  assert.match(handler, /\.click\(\)/);
});
