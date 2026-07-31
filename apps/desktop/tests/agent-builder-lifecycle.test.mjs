import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const desktopRoot = new URL('../', import.meta.url);
const [apiSource, appSource, directorySource, typesSource, cssSource] = await Promise.all([
  readFile(new URL('src/api/hermesApi.ts', desktopRoot), 'utf8'),
  readFile(new URL('src/App.tsx', desktopRoot), 'utf8'),
  readFile(new URL('src/features/agent-operations/AgentDirectoryPanel.tsx', desktopRoot), 'utf8'),
  readFile(new URL('src/features/agent-operations/types.ts', desktopRoot), 'utf8'),
  readFile(new URL('src/features/agent-operations/agent-workspace.css', desktopRoot), 'utf8'),
]);

test('Desktop API exposes the persisted builder lifecycle endpoints', () => {
  assert.match(apiSource, /createAgentBuilderDraft:[\s\S]*\/api\/agents\/builder/);
  assert.match(apiSource, /reviewAgentBuilderDraft:[\s\S]*\/api\/agents\/\$\{encodeURIComponent\(agentId\)\}\/review/);
  assert.match(apiSource, /startAgentBuilderTest:[\s\S]*\/api\/agents\/\$\{encodeURIComponent\(agentId\)\}\/tests/);
  assert.match(apiSource, /getAgentBuilderTest:[\s\S]*\/tests\/\$\{encodeURIComponent\(requestId\)\}/);
  assert.match(apiSource, /cancelAgentBuilderTest:[\s\S]*\/cancel/);
  assert.match(apiSource, /activateAgentBuilderProfile:[\s\S]*\/activate/);
  assert.match(apiSource, /listAgentProfileVersions:[\s\S]*\/profile-versions/);
});

test('Desktop roster types represent draft, tested, active, and immutable versions without credentials', () => {
  assert.match(typesSource, /readonly lifecycle\?:[\s\S]*state:\s*'draft'\s*\|\s*'tested'\s*\|\s*'active'/);
  assert.match(typesSource, /readonly reviewedRevision:\s*number/);
  assert.match(typesSource, /readonly testedRevision:\s*number/);
  assert.match(typesSource, /readonly activeVersion:\s*number/);
  assert.match(typesSource, /export type AgentProfileVersion/);
  assert.doesNotMatch(typesSource, /agentBuilder[\s\S]{0,500}(apiKey|password|credential|token)/i);
});

test('Agent Directory renders real lifecycle controls and disables activation until tested', () => {
  assert.match(directorySource, /한 줄로 에이전트 만들기/);
  assert.match(directorySource, /aria-label="한 줄 에이전트 요청"/);
  assert.match(directorySource, /비활성 초안 저장/);
  assert.match(directorySource, /Draft/);
  assert.match(directorySource, /검토 완료/);
  assert.match(directorySource, /테스트 실행/);
  assert.match(directorySource, /테스트 실패/);
  assert.match(directorySource, /테스트 통과/);
  assert.match(directorySource, /프로필 활성화/);
  assert.match(directorySource, /disabled=\{[\s\S]*lifecycle[\s\S]*state\s*!==\s*'tested'/);
  assert.match(directorySource, /프로필 버전 기록/);
  assert.doesNotMatch(directorySource, /type=["']password["']/i);
  assert.doesNotMatch(directorySource, /외부 전송 실행|Calendar에 추가/);
});

test('App wires draft, review, test polling/cancel, activation, and version history callbacks', () => {
  assert.match(appSource, /createWorkspaceAgentBuilderDraft/);
  assert.match(appSource, /reviewWorkspaceAgentBuilderDraft/);
  assert.match(appSource, /testWorkspaceAgentBuilderDraft/);
  assert.match(appSource, /cancelWorkspaceAgentBuilderTest/);
  assert.match(appSource, /activateWorkspaceAgentBuilderProfile/);
  assert.match(appSource, /loadWorkspaceAgentProfileVersions/);
  assert.match(appSource, /onCreateBuilderDraft=\{createWorkspaceAgentBuilderDraft\}/);
  assert.match(appSource, /onActivateBuilderProfile=\{activateWorkspaceAgentBuilderProfile\}/);
});

test('builder dialog and version history remain horizontally bounded', () => {
  assert.match(cssSource, /\.agent-builder-dialog[\s\S]*max-width:/);
  assert.match(cssSource, /\.agent-builder-dialog[\s\S]*overflow-x:\s*hidden/);
  assert.match(cssSource, /\.agent-profile-version-list[\s\S]*min-width:\s*0/);
});
