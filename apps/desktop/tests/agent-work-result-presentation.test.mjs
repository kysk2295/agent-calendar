import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { createServer } from 'vite';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const presentation = await vite.ssrLoadModule('/src/features/agent-operations/workResultPresentation.ts');

after(async () => {
  await vite.close();
});

test('evidence URLs allow only absolute HTTP and HTTPS links', () => {
  // Given / When / Then
  assert.equal(presentation.safeEvidenceHref('https://example.com/source'), 'https://example.com/source');
  assert.equal(presentation.safeEvidenceHref('http://example.com/source'), 'http://example.com/source');
  for (const value of ['', 'not a url', 'javascript:alert(1)', 'data:text/html,bad', 'file:///tmp/private']) {
    assert.equal(presentation.safeEvidenceHref(value), null);
  }
});

test('current result follows the pointer and legacy fallback chooses one newest report', () => {
  // Given
  const reports = [
    { id: 'older', createdAt: '2026-07-14T08:00:00.000Z', updatedAt: '2026-07-14T08:00:00.000Z' },
    { id: 'newer', createdAt: '2026-07-14T09:00:00.000Z', updatedAt: '2026-07-14T09:00:00.000Z' },
  ];

  // When / Then
  assert.equal(presentation.currentAgentReportId(reports, 'older'), 'older');
  assert.equal(presentation.currentAgentReportId(reports, ''), 'newer');
  assert.equal(presentation.currentAgentReportId(reports, 'missing'), 'missing');
});
