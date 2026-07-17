const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { chmod, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { spawnSync } = require('node:child_process');

test('Railway deploy script pins a clean pushed main commit into SOURCE_COMMIT', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-deploy-script-'));
  const binDir = path.join(tempDir, 'bin');
  const logPath = path.join(tempDir, 'railway.log');
  const repoRoot = path.resolve(__dirname, '../../..');
  const scriptPath = path.join(repoRoot, 'scripts', 'deploy-railway-main.sh');
  await require('node:fs/promises').mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, 'git'), `#!/usr/bin/env bash
case "$*" in
  *"status --porcelain"*) exit 0 ;;
  *"branch --show-current"*) echo main ;;
  *"rev-parse HEAD"*) echo 0123456789abcdef0123456789abcdef01234567 ;;
  *"rev-parse origin/main"*) echo 0123456789abcdef0123456789abcdef01234567 ;;
  *) echo "unexpected git args: $*" >&2; exit 2 ;;
esac
`, 'utf8');
  await writeFile(path.join(binDir, 'railway'), `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DEPLOY_LOG"
`, 'utf8');
  await chmod(path.join(binDir, 'git'), 0o755);
  await chmod(path.join(binDir, 'railway'), 0o755);

  try {
    const result = spawnSync('bash', [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:/usr/bin:/bin`,
        DEPLOY_LOG: logPath,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const log = await readFile(logPath, 'utf8');
    assert.match(log, /variable set SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567 --skip-deploys/);
    assert.match(log, /up --ci --message main@0123456789ab/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
