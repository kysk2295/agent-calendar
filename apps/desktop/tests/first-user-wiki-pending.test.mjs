import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const desktopRoot = new URL('../', import.meta.url);

test('folderless workspace keeps pending_local and does not claim wiki written', async () => {
  const [presentation, conversation, wiki, app] = await Promise.all([
    readFile(new URL('src/features/agent-operations/workConversationPresentation.ts', desktopRoot), 'utf8'),
    readFile(new URL('src/features/agent-operations/AgentWorkConversationView.tsx', desktopRoot), 'utf8'),
    readFile(new URL('src/features/knowledge/WikiScreen.tsx', desktopRoot), 'utf8'),
    readFile(new URL('src/App.tsx', desktopRoot), 'utf8'),
  ]);
  assert.match(presentation, /pending_local[\s\S]+폴더 미연결 · 보관 대기/);
  assert.match(conversation, /wikiArchiveStatusLabel/);
  assert.match(wiki, /폴더 미연결 · 보관 대기/);
  assert.match(wiki, /로컬 폴더 연결/);
  assert.doesNotMatch(wiki, /LLM_WIKI_VAULT/);
  assert.match(app, /pendingWorkResultWikiProjections/);
  assert.match(app, /applyWorkResultWikiProjection/);
});

test('Wiki folder picker uses main-process directory dialog and never posts a raw path to Railway', async () => {
  const [main, settings, preload, preloadCts, types, app] = await Promise.all([
    readFile(new URL('electron/main.ts', desktopRoot), 'utf8'),
    readFile(new URL('electron/settings.ts', desktopRoot), 'utf8'),
    readFile(new URL('electron/preload.ts', desktopRoot), 'utf8'),
    readFile(new URL('electron/preload.cts', desktopRoot), 'utf8'),
    readFile(new URL('src/vite-env.d.ts', desktopRoot), 'utf8'),
    readFile(new URL('src/App.tsx', desktopRoot), 'utf8'),
  ]);
  assert.match(main, /wiki:choose-vault/);
  assert.match(main, /showOpenDialog/);
  assert.match(main, /properties: \['openDirectory'\]/);
  assert.match(main, /wiki:apply-work-result-projection[\s\S]+readSettings\(\)\.wikiVaultPath[\s\S]+saveWorkResultWikiProjection/);
  assert.match(settings, /wikiVaultPath/);
  assert.match(settings, /type PublicDesktopSettings = \{[\s\S]+hasWikiVault: boolean/);
  assert.match(preload, /chooseWikiVault:.*wiki:choose-vault/);
  assert.match(preload, /applyWorkResultWikiProjection:.*wiki:apply-work-result-projection/);
  assert.match(preloadCts, /chooseWikiVault:.*wiki:choose-vault/);
  assert.match(types, /chooseWikiVault\(\)/);
  assert.match(types, /applyWorkResultWikiProjection\(request:/);
  assert.doesNotMatch(types, /wikiVaultPath/);
  assert.match(app, /chooseLocalWikiVault/);
  assert.match(app, /if \(!hasWikiVaultRef\.current \|\| !window\.hermesDesktop\?\.applyWorkResultWikiProjection\) return/);
  assert.doesNotMatch(app, /hermesApi[^\n]+wikiVaultPath/);
  assert.doesNotMatch(main, /request\.wikiVaultPath/);
  assert.doesNotMatch(main, /return \{[^}\n]*wikiVaultPath\s*:/);
});
