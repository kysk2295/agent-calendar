import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const desktopRoot = new URL('../', import.meta.url);

test('renderer selects only unique completed Work pending-local Wiki manifests', async () => {
  const vite = await createServer({
    appType: 'custom',
    root: fileURLToPath(desktopRoot),
    server: { middlewareMode: true, hmr: false },
  });
  try {
    const projection = await vite.ssrLoadModule('/src/features/knowledge/workResultWikiProjection.ts');
    const workResultId = `work_result_${'a'.repeat(28)}`;
    const pending = {
      sourceKind: 'agent_work',
      status: 'completed',
      workResultId,
      result: {
        wiki: {
          status: 'pending_local',
          projectionId: `work-result-wiki:${workResultId}`,
          relativePath: `5_conversation/agent-runs/${workResultId}.md`,
          markdown: `\nwork_result_id: ${workResultId}\nstatus: completed\nsource: agent-calendar\n`,
        },
      },
    };

    assert.deepEqual(
      projection.pendingWorkResultWikiProjections([
        pending,
        pending,
        { ...pending, status: 'active' },
        { ...pending, sourceKind: 'calendar' },
        { ...pending, result: { wiki: { ...pending.result.wiki, status: 'written' } } },
      ]),
      [{ workResultId, ...pending.result.wiki }],
    );
  } finally {
    await vite.close();
  }
});

test('Desktop routes completed Work Wiki manifests through the trusted Electron writer', async () => {
  const [app, main, preload, runtimePreload, types] = await Promise.all([
    readFile(new URL('src/App.tsx', desktopRoot), 'utf8'),
    readFile(new URL('electron/main.ts', desktopRoot), 'utf8'),
    readFile(new URL('electron/preload.ts', desktopRoot), 'utf8'),
    readFile(new URL('electron/preload.cts', desktopRoot), 'utf8'),
    readFile(new URL('src/vite-env.d.ts', desktopRoot), 'utf8'),
  ]);

  assert.match(main, /wiki:apply-work-result-projection/);
  assert.match(main, /saveWorkResultWikiProjection/);
  assert.match(main, /const vaultPath = readSettings\(\)\.wikiVaultPath/);
  assert.match(preload, /applyWorkResultWikiProjection:.*wiki:apply-work-result-projection/);
  assert.match(runtimePreload, /applyWorkResultWikiProjection:.*wiki:apply-work-result-projection/);
  assert.match(types, /applyWorkResultWikiProjection\(request:/);
  assert.match(app, /pendingWorkResultWikiProjections/);
  assert.match(app, /hasWikiVaultRef\.current/);
  assert.match(app, /applyWorkResultWikiProjection/);
});
