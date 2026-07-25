import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const desktopRoot = new URL('../', import.meta.url);
const directorySource = await readFile(new URL('src/features/agent-operations/AgentDirectoryPanel.tsx', desktopRoot), 'utf8');
const workspaceSource = await readFile(new URL('src/features/agent-operations/AgentWorkWorkspace.tsx', desktopRoot), 'utf8');
const apiSource = await readFile(new URL('src/api/hermesApi.ts', desktopRoot), 'utf8');
const appSource = await readFile(new URL('src/App.tsx', desktopRoot), 'utf8');
const css = await readFile(new URL('src/features/agent-operations/agent-workspace.css', desktopRoot), 'utf8');

test('connected agents are discovered and imported through a selected Workspace Runner', () => {
  assert.match(apiSource, /requestAgentCatalog/);
  assert.match(apiSource, /getAgentCatalogRequest/);
  assert.match(apiSource, /importAgentCatalogEntry/);
  assert.match(directorySource, /Runner에서 가져오기/);
  assert.match(directorySource, /로컬 프로필 정보를 읽는 데 동의합니다/);
  assert.match(directorySource, /catalog\.entries/);
  assert.match(directorySource, /defaultRunnerId/);
  assert.match(appSource, /automationRunners/);
  assert.match(appSource, /Promise\.all\(\[\s*hermesApi\.getAgentOperations\(\),\s*hermesApi\.listRunners\(\)/);
  assert.doesNotMatch(directorySource, /apiKey|API 키|token|토큰|cookie|credential/i);
});

test('agent sessions can be searched resumed renamed and archived without replacing their provider identity', () => {
  assert.match(apiSource, /listProviderAgentSessions/);
  assert.match(apiSource, /updateProviderAgentSession/);
  assert.match(workspaceSource, /providerSessions/);
  assert.match(directorySource, /세션 검색/);
  assert.match(directorySource, /새 세션/);
  assert.match(directorySource, /이름 변경/);
  assert.match(directorySource, /보관/);
  assert.match(workspaceSource, /session\.missionId/);
  assert.match(css, /\.agent-session-rail/);
});

test('terminal provider session states are explained rather than silently opening a new session', () => {
  assert.match(directorySource, /인증이 만료되었습니다/);
  assert.match(directorySource, /provider 세션을 찾을 수 없습니다/);
  assert.match(directorySource, /사용량 한도에 도달했습니다/);
  assert.match(directorySource, /새 세션을 시작할 수 있습니다/);
});
