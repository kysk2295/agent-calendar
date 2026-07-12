import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

test('migration copies missing legacy userData files without overwriting or deleting originals', async () => {
  // Given
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-user-data-'));
  const legacyDir = path.join(root, 'agents-calendar-desktop');
  const currentDir = path.join(root, 'Agent Calendar');
  const legacySettings = '{"theme":"warm"}\n';
  const currentSettings = '{"theme":"dark"}\n';
  const legacyUsers = '{"users":[{"email":"legacy@example.com"}]}\n';
  await mkdir(legacyDir, { recursive: true });
  await mkdir(currentDir, { recursive: true });
  await writeFile(path.join(legacyDir, 'settings.json'), legacySettings);
  await writeFile(path.join(legacyDir, 'auth-users.json'), legacyUsers);
  await writeFile(path.join(currentDir, 'settings.json'), currentSettings);

  const settingsUrl = new URL('../dist-electron/settings.js', import.meta.url).href;
  const driverPath = path.join(root, 'migration-driver.mjs');
  await writeFile(driverPath, [
    "import { registerHooks } from 'node:module';",
    "const electronUrl = 'data:text/javascript,export const app = { getPath() { return \\\"\\\"; } };';",
    'registerHooks({',
    '  resolve(specifier, context, nextResolve) {',
    "    if (specifier === 'electron') return { shortCircuit: true, url: electronUrl };",
    '    return nextResolve(specifier, context);',
    '  },',
    '});',
    'try {',
    `  const { migrateLegacyUserDataFiles } = await import(${JSON.stringify(settingsUrl)});`,
    `  await migrateLegacyUserDataFiles(${JSON.stringify(legacyDir)}, ${JSON.stringify(currentDir)});`,
    '  process.exit(0);',
    '} catch (error) {',
    '  console.error(error);',
    '  process.exit(1);',
    '}',
  ].join('\n'));

  try {
    // When
    const child = spawn(process.execPath, [driverPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [exitCode] = await once(child, 'exit');

    // Then
    assert.equal(exitCode, 0, stderr);
    assert.equal(await readFile(path.join(currentDir, 'settings.json'), 'utf8'), currentSettings);
    assert.equal(await readFile(path.join(currentDir, 'auth-users.json'), 'utf8'), legacyUsers);
    assert.equal(await readFile(path.join(legacyDir, 'settings.json'), 'utf8'), legacySettings);
    assert.equal(await readFile(path.join(legacyDir, 'auth-users.json'), 'utf8'), legacyUsers);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
