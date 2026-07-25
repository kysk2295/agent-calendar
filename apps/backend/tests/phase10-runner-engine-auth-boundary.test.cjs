const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveEngine } = require('../app/lib/durable-execution');
const { normalizeEngine } = require('../app/lib/runner-control');

test('durable execution never selects an engine without explicit Runner-hosted authentication', () => {
  const capabilities = {
    engines: {
      codex: {
        available: true,
        status: 'available',
        authStatus: 'missing',
      },
      claude: {
        available: true,
        status: 'available',
        authStatus: 'unknown',
      },
      grok: {
        available: true,
        status: 'available',
        authStatus: 'authenticated',
      },
    },
  };

  assert.deepEqual(resolveEngine('codex', capabilities), {
    requested: 'codex',
    resolved: '',
    reason: 'engine_auth_required:codex',
  });
  assert.deepEqual(resolveEngine('auto', capabilities), {
    requested: 'auto',
    resolved: 'grok',
    reason: 'auto_selected_first_authenticated:grok',
  });
});

test('Runner capability normalization fails closed when availability lacks verified auth', () => {
  assert.deepEqual(
    normalizeEngine({
      installed: true,
      available: true,
      status: 'available',
      version: '1.2.3',
      authStatus: 'missing',
      message: 'CLI installed',
    }),
    {
      installed: true,
      available: false,
      status: 'auth_required',
      version: '1.2.3',
      authStatus: 'missing',
      message: 'CLI installed, but authentication is not verified on this Runner host.',
    },
  );

  assert.equal(normalizeEngine({
    available: true,
    status: 'available',
    authStatus: 'ok',
  }).available, true);
});
