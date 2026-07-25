const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { chmod, mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { spawnSync } = require('node:child_process');

const PROJECT_ID = 'b64a9c8f-101e-4e08-9a7f-68fea0a4de9a';
const ENVIRONMENT_ID = '7629b09d-3447-4f74-9b06-2f9b8aafb80a';
const SERVICE_ID = 'b7bd75ff-cc24-4a6d-9387-1628fcaff9d6';
const EXPECTED_COMMIT = '0123456789abcdef0123456789abcdef01234567';

async function runDeployScript({
  sourceRepo = 'kysk2295/agent-calendar',
  preflight = 'valid',
} = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-deploy-script-'));
  const binDir = path.join(tempDir, 'bin');
  const logPath = path.join(tempDir, 'railway.log');
  const repoRoot = path.resolve(__dirname, '../../..');
  const scriptPath = path.join(repoRoot, 'scripts', 'deploy-railway-main.sh');
  const preflightPath = path.join(tempDir, 'preflight.json');
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, 'git'), `#!/usr/bin/env bash
case "$*" in
  *"status --porcelain"*) exit 0 ;;
  *"branch --show-current"*) echo main ;;
  *"rev-parse HEAD"*) echo ${EXPECTED_COMMIT} ;;
  *"rev-parse origin/main"*) echo ${EXPECTED_COMMIT} ;;
  *) echo "unexpected git args: $*" >&2; exit 2 ;;
esac
`, 'utf8');
  await writeFile(path.join(binDir, 'railway'), `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DEPLOY_LOG"
case "$*" in
  "service list --project ${PROJECT_ID} --environment ${ENVIRONMENT_ID} --json")
    printf '%s\n' '[{"id":"${SERVICE_ID}","name":"hermes-os","source":{"repo":"${sourceRepo}","image":null}}]'
    ;;
  "redeploy --from-source --yes --json --project ${PROJECT_ID} --environment ${ENVIRONMENT_ID} --service ${SERVICE_ID}")
    printf '%s\n' '{"id":"deployment-1"}'
    ;;
  *)
    echo "unexpected railway args: $*" >&2
    exit 2
    ;;
esac
`, 'utf8');
  await chmod(path.join(binDir, 'git'), 0o755);
  await chmod(path.join(binDir, 'railway'), 0o755);
  if (preflight === 'valid') {
    const verifiedAtMs = Date.now();
    const verifiedAt = new Date(verifiedAtMs).toISOString();
    const expiresAt = new Date(verifiedAtMs + 30 * 60 * 1000).toISOString();
    await writeFile(preflightPath, `${JSON.stringify({
      ok: true,
      action: 'promote_candidate',
      candidateCommit: EXPECTED_COMMIT,
      candidateDeploymentId: 'staging-candidate',
      lastKnownGoodDeploymentId: 'production-known-good',
      stagingEnvironmentId: 'staging-environment',
      stagingServiceId: 'staging-service',
      schemaVersion: 3,
      verifiedAt,
      expiresAt,
    })}\n`, 'utf8');
  } else if (preflight === 'expired') {
    await writeFile(preflightPath, `${JSON.stringify({
      ok: true,
      action: 'promote_candidate',
      candidateCommit: EXPECTED_COMMIT,
      candidateDeploymentId: 'staging-candidate',
      lastKnownGoodDeploymentId: 'production-known-good',
      stagingEnvironmentId: 'staging-environment',
      stagingServiceId: 'staging-service',
      schemaVersion: 3,
      verifiedAt: '2000-01-01T00:00:00.000Z',
      expiresAt: '2000-01-01T00:30:00.000Z',
    })}\n`, 'utf8');
  } else if (preflight === 'failed') {
    await writeFile(preflightPath, '{"ok":false,"action":"stop_release"}\n', 'utf8');
  }

  try {
    const result = spawnSync('bash', [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        DEPLOY_LOG: logPath,
        RAILWAY_RELEASE_PREFLIGHT_PATH: preflight === 'missing' ? '' : preflightPath,
      },
    });
    const log = await readFile(logPath, 'utf8').catch(() => '');
    return { result, log };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test('Railway deploy script redeploys only the verified Agent Calendar source with fixed selectors', async () => {
  const { result, log } = await runDeployScript();

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(log, new RegExp(`service list --project ${PROJECT_ID} --environment ${ENVIRONMENT_ID} --json`));
  assert.match(
    log,
    new RegExp(`redeploy --from-source --yes --json --project ${PROJECT_ID} --environment ${ENVIRONMENT_ID} --service ${SERVICE_ID}`),
  );
  assert.doesNotMatch(log, /(?:^|\s)up(?:\s|$)/m);
  assert.doesNotMatch(log, /variable set/);
});

test('Railway deploy script rejects a service still sourced from Hermes OS', async () => {
  const { result, log } = await runDeployScript({ sourceRepo: 'kysk2295/hermes-os' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source.*kysk2295\/agent-calendar/i);
  assert.doesNotMatch(log, /redeploy/);
});

test('Railway deploy script refuses production without a matching successful staging preflight', async () => {
  for (const preflight of ['missing', 'failed', 'expired']) {
    const { result, log } = await runDeployScript({ preflight });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /preflight|staging/i);
    assert.doesNotMatch(log, /redeploy/);
  }
});
