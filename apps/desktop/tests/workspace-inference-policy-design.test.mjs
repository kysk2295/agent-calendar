import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const panelSource = readFileSync(
  new URL('../src/features/settings/WorkspaceInferencePolicyPanel.tsx', import.meta.url),
  'utf8',
);

test('Desktop settings exposes a Workspace-owned AI execution policy pane', () => {
  assert.match(appSource, /WorkspaceInferencePolicyPanel/);
  assert.match(appSource, /id:\s*'ai'/);
  assert.match(appSource, /label:\s*'AI 실행'/);
  assert.match(panelSource, /data-testid="inference-mode-runner"/);
  assert.match(panelSource, /data-testid="inference-mode-cloud"/);
  assert.match(panelSource, /data-testid="inference-default-engine"/);
  assert.match(panelSource, /data-testid="inference-policy-save"/);
});

test('AI execution settings preserve the Runner credential boundary', () => {
  assert.doesNotMatch(panelSource, /type=["']password["']/);
  assert.doesNotMatch(panelSource, /name=["'](?:apiKey|token|cookie|credential)["']/i);
  assert.match(panelSource, /Runner에서 인증/);
  assert.match(panelSource, /자동 전환하지 않습니다/);
});
