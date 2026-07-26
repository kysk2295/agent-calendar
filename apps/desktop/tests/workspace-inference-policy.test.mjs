import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({
  root: new URL('..', import.meta.url).pathname,
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
});

test.after(async () => vite.close());

const policy = await vite.ssrLoadModule('/src/features/settings/workspaceInferencePolicy.ts');

test('Workspace AI policy defaults safely and accepts only supported public fields', () => {
  assert.deepEqual(policy.readWorkspaceInferencePolicy({}), {
    mode: 'runner',
    defaultEngine: 'auto',
  });
  assert.deepEqual(policy.readWorkspaceInferencePolicy({
    settings: {
      inferencePolicy: {
        mode: 'agent_calendar_cloud',
        defaultEngine: 'grok',
        apiKey: 'must-not-survive',
        credentials: { token: 'must-not-survive' },
      },
    },
  }), {
    mode: 'agent_calendar_cloud',
    defaultEngine: 'grok',
  });
});

test('Workspace AI policy payload never carries Runner or provider credentials', () => {
  const payload = policy.workspaceInferencePolicyPayload({
    mode: 'runner',
    defaultEngine: 'hermes',
    apiKey: 'forbidden',
    token: 'forbidden',
  });
  assert.deepEqual(payload, {
    inferencePolicy: {
      mode: 'runner',
      defaultEngine: 'hermes',
    },
  });
  assert.doesNotMatch(JSON.stringify(payload), /forbidden|apiKey|token|cookie|credential/i);
});
