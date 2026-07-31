'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  workspaceAuthMode,
} = require('../app/lib/workspace-request-context');

const ROOT = path.join(__dirname, '../../..');

test('WorkOS dogfood startup selects production mode without changing the library default', () => {
  const setupScript = fs.readFileSync(path.join(ROOT, 'scripts/setup-workos-env.sh'), 'utf8');
  const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.match(
    setupScript,
    /export WORKSPACE_AUTH_MODE=production/,
    'generated WorkOS env must make production the dogfood default',
  );
  assert.match(
    String(rootPackage.scripts && rootPackage.scripts['backend:start:workos'] || ''),
    /start-workos-backend\.sh/,
    'root package must expose the guarded WorkOS dogfood startup path',
  );
  assert.equal(
    fs.existsSync(path.join(ROOT, 'scripts/start-workos-backend.sh')),
    true,
    'guarded WorkOS dogfood startup script must exist',
  );

  assert.equal(workspaceAuthMode({}), 'legacy');
  assert.equal(workspaceAuthMode({ WORKSPACE_AUTH_MODE: 'legacy' }), 'legacy');
  assert.equal(workspaceAuthMode({ WORKSPACE_AUTH_MODE: 'production' }), 'production');
});

test('guarded WorkOS startup requires scoped persistence and preserves an explicit legacy override', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-workos-cutover-'));
  const fakeBin = path.join(tempDir, 'bin');
  const fakeNpm = path.join(fakeBin, 'npm');
  const envFile = path.join(tempDir, '.env.workos.test');
  const startScript = path.join(ROOT, 'scripts/start-workos-backend.sh');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(fakeNpm, [
    '#!/usr/bin/env bash',
    'printf "mode=%s\\n" "$WORKSPACE_AUTH_MODE"',
    'printf "database=%s\\n" "${DATABASE_URL:+configured}"',
    'printf "args=%s\\n" "$*"',
  ].join('\n'));
  fs.chmodSync(fakeNpm, 0o755);

  const baseEnv = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH || ''}`,
    WORKOS_ENV_FILE: envFile,
  };
  delete baseEnv.WORKSPACE_AUTH_MODE;
  delete baseEnv.WORKOS_CLIENT_ID;
  delete baseEnv.WORKOS_API_KEY;
  delete baseEnv.DATABASE_URL;

  try {
    fs.writeFileSync(envFile, [
      'export WORKOS_CLIENT_ID=client_test',
      'export WORKOS_API_KEY=sk_test_12345678901234567890',
      'export DATABASE_URL=postgres://dogfood-test',
      'export WORKSPACE_AUTH_MODE=production',
    ].join('\n'));

    const production = execFileSync('bash', [startScript], {
      cwd: ROOT,
      env: baseEnv,
      encoding: 'utf8',
    });
    assert.match(production, /^mode=production$/m);
    assert.match(production, /^database=configured$/m);
    assert.match(production, /^args=run backend:start$/m);

    const legacy = execFileSync('bash', [startScript], {
      cwd: ROOT,
      env: { ...baseEnv, WORKSPACE_AUTH_MODE: 'legacy' },
      encoding: 'utf8',
    });
    assert.match(legacy, /^mode=legacy$/m);

    fs.writeFileSync(envFile, [
      'export WORKOS_CLIENT_ID=client_test',
      'export WORKOS_API_KEY=sk_test_12345678901234567890',
      'export WORKSPACE_AUTH_MODE=production',
    ].join('\n'));
    assert.throws(
      () => execFileSync('bash', [startScript], {
        cwd: ROOT,
        env: baseEnv,
        encoding: 'utf8',
        stdio: 'pipe',
      }),
      (error) => error && error.status === 1 && /DATABASE_URL/.test(String(error.stderr)),
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
