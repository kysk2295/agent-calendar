import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const mod = await vite.ssrLoadModule('/src/features/runner/providerAccountsPresentation.ts');

after(async () => {
  await vite.close();
});

test('provider sections always include Claude Codex Grok with honest empty states', () => {
  const sections = mod.buildProviderSections([]);
  const ids = sections.map((s) => s.id);
  assert.deepEqual(ids, ['claude', 'codex', 'grok', 'hermes', 'gemini']);
  for (const section of sections) {
    assert.ok(section.accounts.some((a) => a.kind === 'system_default'));
    assert.ok(section.emptyHint.length > 10);
  }
});

test('authenticated engine surfaces system default active and device email when present', () => {
  const sections = mod.buildProviderSections([
    {
      name: 'claude',
      cap: {
        available: true,
        status: 'available',
        authStatus: 'authenticated',
        version: '1.2.3',
        message: 'signed in as kysk229500@gmail.com',
      },
    },
  ], { hostLabel: 'Mac mini' });
  const claude = sections.find((s) => s.id === 'claude');
  assert.ok(claude);
  assert.equal(claude.auth.ready, true);
  const system = claude.accounts.find((a) => a.kind === 'system_default');
  assert.equal(system?.active, true);
  assert.equal(system?.badge, '활성');
  const device = claude.accounts.find((a) => a.kind === 'device');
  assert.equal(device?.email, 'kysk229500@gmail.com');
  assert.equal(device?.badge, '이 기기');
  assert.match(device?.subtitle || '', /Mac mini/);
});

test('auth_required does not invent an active account', () => {
  const sections = mod.buildProviderSections([
    { name: 'codex', cap: { installed: true, status: 'auth_required', authStatus: 'auth_required' } },
  ]);
  const codex = sections.find((s) => s.id === 'codex');
  assert.equal(codex?.auth.ready, false);
  assert.equal(codex?.accounts.find((a) => a.kind === 'system_default')?.active, false);
  assert.equal(codex?.accounts.filter((a) => a.kind === 'device').length, 0);
});
