import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const desktopRoot = new URL('../', import.meta.url);
const directorySource = await readFile(new URL('src/features/agent-operations/AgentDirectoryPanel.tsx', desktopRoot), 'utf8');
const workspaceSource = await readFile(new URL('src/features/agent-operations/AgentWorkWorkspace.tsx', desktopRoot), 'utf8');
const controlHomeSource = await readFile(new URL('src/features/agent-operations/AgentControlRoomBoard.tsx', desktopRoot), 'utf8');
const css = await readFile(new URL('src/features/agent-operations/agent-workspace.css', desktopRoot), 'utf8');

test('Agent Work translates the Argo roster into an accountable agent directory', () => {
  assert.match(directorySource, /내 에이전트/);
  assert.match(directorySource, /연결된 에이전트/);
  assert.match(directorySource, /에이전트 만들기/);
  assert.match(directorySource, /외부 에이전트 연결/);
  assert.match(directorySource, /책임/);
  assert.match(directorySource, /말투와 성격/);
  assert.match(directorySource, /계속 기억할 내용/);
  assert.match(directorySource, /프로필 v/);
  // Profile history lists jobs already recorded against a profile version; it is not a live feed.
  assert.match(directorySource, /기록된 작업/);
  assert.match(directorySource, /출처/);
  assert.match(directorySource, /Runner/);
  assert.doesNotMatch(directorySource, /크루 영입|회사 기억|사장님/);
});

test('agent creation and connection never ask for provider credentials', () => {
  assert.match(directorySource, /externalAgentId/);
  assert.match(directorySource, /provider/);
  assert.match(directorySource, /Runner에 인증된 계정/);
  assert.doesNotMatch(directorySource, /apiKey|API 키|token|토큰|cookie|credential/i);
});

test('an empty Workspace explains that agents are not pre-connected and offers both roster paths', () => {
  assert.match(directorySource, /이 Workspace에는 미리 연결된 에이전트가 없습니다/);
  assert.match(directorySource, /첫 에이전트 만들기/);
  assert.match(directorySource, /Runner에서 가져오기/);
  assert.match(controlHomeSource, /미리 연결된 에이전트가 없습니다/);
  assert.doesNotMatch(directorySource, /공식 에이전트|기본 에이전트 5명|officialProfiles/);
});

test('the directory remains beside Control Home and Work Conversation on desktop', () => {
  assert.match(workspaceSource, /className="agent-control-shell"/);
  assert.match(workspaceSource, /<AgentDirectoryPanel/);
  assert.match(css, /\.agent-control-shell\s*\{[^}]*grid-template-columns:\s*224px\s+minmax\(0,\s*1fr\)/s);
  assert.match(css, /@media\s*\(max-width:\s*768px\)[\s\S]*?\.agent-directory-panel\s*\{[^}]*display:\s*none/s);
});
