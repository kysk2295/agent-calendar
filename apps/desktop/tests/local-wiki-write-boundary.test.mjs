import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const desktopRoot = new URL('../', import.meta.url);

test('packaged writer stores one exact completed Work result idempotently', async () => {
  const vite = await createServer({
    appType: 'custom',
    root: fileURLToPath(desktopRoot),
    server: { middlewareMode: true, hmr: false },
  });
  const vault = await mkdtemp(path.join(os.tmpdir(), 'work-result-local-wiki-'));
  const workResultId = `work_result_${'b'.repeat(28)}`;
  const markdown = [
    '---',
    'type: work-result',
    `work_result_id: ${workResultId}`,
    'mission_id: mission-local-wiki',
    'status: completed',
    'source: agent-calendar',
    '---',
    '',
    '# 완료 결과',
    '',
    'LOCAL_WIKI_WORK_RESULT_OK',
  ].join('\n');
  const request = {
    status: 'pending_local',
    workResultId,
    projectionId: `work-result-wiki:${workResultId}`,
    relativePath: `5_conversation/agent-runs/${workResultId}.md`,
    markdown,
  };

  try {
    const { saveWorkResultWikiProjection } = await vite.ssrLoadModule('/electron/localWikiWriter.ts');
    const first = await saveWorkResultWikiProjection(vault, request);
    assert.equal(first.status, 'written');
    assert.equal(first.replay, false);
    assert.equal(first.relativePath, request.relativePath);
    assert.match(first.contentDigest, /^[a-f0-9]{64}$/);
    const target = path.join(vault, request.relativePath);
    assert.equal(await readFile(target, 'utf8'), markdown);

    const replay = await saveWorkResultWikiProjection(vault, request);
    assert.deepEqual(replay, { ...first, replay: true });
    await assert.rejects(
      () => saveWorkResultWikiProjection(vault, { ...request, relativePath: '../escape.md' }),
      /path/i,
    );
    await assert.rejects(
      () => saveWorkResultWikiProjection(vault, { ...request, projectionId: 'work-result-wiki:other' }),
      /identity/i,
    );
    assert.equal(await readFile(target, 'utf8'), markdown);

    const conflictId = `work_result_${'c'.repeat(28)}`;
    const conflictPath = `5_conversation/agent-runs/${conflictId}.md`;
    await mkdir(path.dirname(path.join(vault, conflictPath)), { recursive: true });
    await writeFile(path.join(vault, conflictPath), 'EXISTING_UNCHANGED', 'utf8');
    await assert.rejects(
      () => saveWorkResultWikiProjection(vault, {
        ...request,
        workResultId: conflictId,
        projectionId: `work-result-wiki:${conflictId}`,
        relativePath: conflictPath,
        markdown: markdown.replaceAll(workResultId, conflictId),
      }),
      /digest.*conflict/i,
    );
    assert.equal(await readFile(path.join(vault, conflictPath), 'utf8'), 'EXISTING_UNCHANGED');
  } finally {
    await vite.close();
    await rm(vault, { recursive: true, force: true });
  }
});
