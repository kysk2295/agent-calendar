const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const {
  UNSAFE_RUNTIME_CAPABILITY_BLOCKER_ID,
  buildUnsafeRuntimeCapabilityBlocker,
  containsSecretShapedValue,
  findForbiddenRuntimeCapabilities,
  findSecretShapedValues,
  formatFixtureCheckResult,
  isForbiddenRuntimeCapability,
  redactProbeText,
  sanitizeRuntimeHealth,
  toSafeDisplayPath,
  validateMacminiRuntimeInventory,
} = require('../app/lib/macmini-runtime-inventory');

const FIXTURE_PATH = path.join(
  __dirname,
  '../../../docs/operations/fixtures/macmini-runtime-inventory.fixture.json',
);
const CLI_PATH = path.join(__dirname, '../tools/macmini-runtime-inventory-check.cjs');
// Assembled from fragments so this test file never stores literal personal usernames.
const PERSONAL_NAME_PATTERN = new RegExp(
  [
    ['go', 'yun', 'seo'].join(''),
    ['ko', 'yun', 'seo'].join(''),
  ].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'i',
);
const RAW_USER_PATH_PATTERN = /\/Users\/[A-Za-z0-9._-]+/;

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

function assertNoUserPathLeak(text, label = 'output') {
  assert.doesNotMatch(String(text), /\/Users\/[^/\s"']+/, `${label} must not leak absolute user paths`);
  assert.doesNotMatch(String(text), PERSONAL_NAME_PATTERN, `${label} must not hard-code host usernames`);
}

test('sanitized Mac mini inventory fixture passes redaction-safe validation', () => {
  const inventory = loadFixture();
  const result = validateMacminiRuntimeInventory(inventory);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.officialProfiles, [
    'default',
    'bizconsultant',
    'stockagent',
    'uniportpm',
    'wikicurator',
  ]);
  assert.equal(findSecretShapedValues(inventory).length, 0);
  assert.equal(
    inventory.secretRegistry.every((entry) => !Object.hasOwn(entry, 'value')),
    true,
  );
});

test('inventory validation fails when an official profile or secret name is missing', () => {
  const inventory = loadFixture();
  inventory.officialProfiles = inventory.officialProfiles.filter((name) => name !== 'wikicurator');
  inventory.secretRegistry = inventory.secretRegistry.filter((entry) => entry.name !== 'HERMES_RELAY_TOKEN');
  const result = validateMacminiRuntimeInventory(inventory);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.includes('wikicurator')), true);
  assert.equal(result.errors.some((error) => error.includes('HERMES_RELAY_TOKEN')), true);
});

test('inventory validation fails closed on secret-shaped values and unsafe runner templates', () => {
  const inventory = loadFixture();
  inventory.deploymentInputs.notes = 'Authorization: Bearer supersecrettokenvalue';
  inventory.safeRunnerCommandTemplate = 'hermes --yolo -z "$HERMES_GOAL"';
  inventory.secretRegistry.push({
    name: 'HERMES_RUNTIME_TOKEN',
    storage: 'railway-variables',
    value: 'sk-this-must-not-be-stored',
  });
  const result = validateMacminiRuntimeInventory(inventory);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => /secret|redaction|value/i.test(error)), true);
  assert.equal(result.errors.some((error) => /safeRunnerCommandTemplate|yolo/i.test(error)), true);
});

test('probe redaction strips absolute user paths and secret-shaped fragments', () => {
  const redacted = redactProbeText(
    'cwd=/Users/example/.hermes token=sk-abcdefghijklmnop Bearer abcdefghijklmnop',
  );
  assert.doesNotMatch(redacted, /\/Users\/example/);
  assert.match(redacted, /\$HOME\//);
  assert.doesNotMatch(redacted, /sk-abcdefghijklmnop|Bearer abcdefghijklmnop/);
});

test('secret-shaped detection and redaction cover xAI and GitHub PAT prefixes', () => {
  // Synthetic shapes only — never use real credentials in tests.
  const synthetic = {
    xai: 'xai-syntheticfixturekeyvalue01',
    githubPat: 'github_pat_syntheticfixturevalue01',
    ghp: 'ghp_syntheticfixturevalue012345',
  };
  assert.equal(containsSecretShapedValue(synthetic.xai), true);
  assert.equal(containsSecretShapedValue(synthetic.githubPat), true);
  assert.equal(containsSecretShapedValue(synthetic.ghp), true);
  assert.equal(containsSecretShapedValue('chat-stream'), false);

  const inventory = {
    deploymentInputs: {
      notes: `provider=${synthetic.xai} deploy=${synthetic.githubPat} ci=${synthetic.ghp}`,
    },
  };
  const findings = findSecretShapedValues(inventory);
  assert.equal(findings.some((finding) => finding.path === 'deploymentInputs.notes'), true);

  const redacted = redactProbeText(inventory.deploymentInputs.notes);
  assert.doesNotMatch(redacted, /xai-syntheticfixturekeyvalue01/);
  assert.doesNotMatch(redacted, /github_pat_syntheticfixturevalue01/);
  assert.doesNotMatch(redacted, /ghp_syntheticfixturevalue012345/);
  assert.match(redacted, /\[redacted-secret-shaped\]/);

  const rejected = loadFixture();
  rejected.deploymentInputs.notes = inventory.deploymentInputs.notes;
  const result = validateMacminiRuntimeInventory(rejected);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => /secret-shaped-string|redaction/i.test(error)), true);
});

test('secret-shaped detection is stateless across multiple strings', () => {
  const inventory = {
    first: 'Bearer firstsecrettokenvalue',
    second: 'sk-secondsecretvaluehere',
    nested: {
      third: 'xoxb-1234567890abcdef',
      fourth: 'Bearer fourthsecrettokenvalue',
      fifth: 'xai-syntheticstatelesskey01',
      sixth: 'github_pat_syntheticstateless01',
      seventh: 'ghp_syntheticstateless01234',
    },
  };
  const findings = findSecretShapedValues(inventory);
  const paths = findings.map((finding) => finding.path).sort();
  assert.deepEqual(paths, [
    'first',
    'nested.fifth',
    'nested.fourth',
    'nested.seventh',
    'nested.sixth',
    'nested.third',
    'second',
  ]);
  // Repeated scans must remain stable (global RegExp lastIndex must not skip hits).
  assert.deepEqual(
    findSecretShapedValues(inventory).map((finding) => finding.path).sort(),
    paths,
  );
});

test('fixture display paths and CLI output never leak absolute user paths', () => {
  const display = toSafeDisplayPath(FIXTURE_PATH);
  assertNoUserPathLeak(display, 'toSafeDisplayPath');
  assert.match(display, /docs\/operations\/fixtures\/macmini-runtime-inventory\.fixture\.json$/);

  const formatted = formatFixtureCheckResult({
    fixturePath: FIXTURE_PATH,
    officialProfiles: ['default', 'bizconsultant', 'stockagent', 'uniportpm', 'wikicurator'],
    secretRegistryCount: 12,
    blockerCount: 1,
  });
  assertNoUserPathLeak(JSON.stringify(formatted), 'formatFixtureCheckResult');
  assert.equal(formatted.fixture, display);

  const result = spawnSync(process.execPath, [CLI_PATH, '--fixture', FIXTURE_PATH], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assertNoUserPathLeak(result.stdout, 'fixture CLI stdout');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, 'fixture');
  assert.equal(payload.officialProfiles.length, 5);
  assert.equal(payload.fixture.includes(path.basename(FIXTURE_PATH)), true);
});

test('runtime health identity strings are redacted or omitted before probe output', () => {
  const sanitized = sanitizeRuntimeHealth({
    status: 200,
    name: 'Hermes OS Runtime',
    runtimeVersion: {
      name: 'hermes-os-runtime',
      version: '0.1.0',
      capabilities: ['chat-stream'],
    },
    capabilities: ['chat-stream'],
    machineName: 'MacBook Pro',
    hostname: 'MacBook-Pro.local',
    cwd: `/Users/${path.basename(os.homedir())}/.hermes/os-runtime`,
    nodeVersion: 'v22.17.0',
    wikiRoot: `/Users/${path.basename(os.homedir())}/Library/Mobile Documents/com~apple~CloudDocs/LLM-Wiki`,
  });
  const serialized = JSON.stringify(sanitized);
  assertNoUserPathLeak(serialized, 'sanitizeRuntimeHealth');
  assert.equal(Object.hasOwn(sanitized, 'machineName'), false);
  assert.equal(Object.hasOwn(sanitized, 'hostname'), false);
  assert.equal(Object.hasOwn(sanitized, 'cwd'), false);
  assert.equal(Object.hasOwn(sanitized, 'wikiRoot'), false);
  assert.equal(sanitized.status, 200);
  assert.equal(sanitized.name, 'Hermes OS Runtime');
  assert.equal(sanitized.nodeVersion, 'v22.17.0');
  assert.deepEqual(sanitized.capabilities, ['chat-stream']);
});

test('probe CLI output never hard-codes usernames or absolute user paths', () => {
  const result = spawnSync(process.execPath, [CLI_PATH, '--probe'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // Ensure no accidental documented-home override injects absolute paths into output.
      HERMES_DOCUMENTED_MACMINI_HOME: '',
    },
  });
  // Exit 0 when fully healthy, 2 when blockers are reported; either is acceptable for leak checks.
  assert.equal([0, 2].includes(result.status), true, result.stderr || result.stdout);
  assertNoUserPathLeak(result.stdout, 'probe CLI stdout');
  assertNoUserPathLeak(result.stderr || '', 'probe CLI stderr');
  const payload = JSON.parse(result.stdout);
  if (payload.runtimeHealth) {
    assert.equal(Object.hasOwn(payload.runtimeHealth, 'machineName'), false);
    assert.equal(Object.hasOwn(payload.runtimeHealth, 'hostname'), false);
    assert.equal(Object.hasOwn(payload.runtimeHealth, 'cwd'), false);
  }
});

test('fixture CLI accepts the durable sanitized inventory fixture', () => {
  const result = spawnSync(process.execPath, [CLI_PATH, '--fixture', FIXTURE_PATH], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, 'fixture');
  assert.equal(payload.officialProfiles.length, 5);
});

test('Story 2 runbook, fixture, and child plan stay path-template and redaction-safe', () => {
  const story2Artifacts = [
    path.join(__dirname, '../../../docs/operations/macmini-runtime-inventory.md'),
    path.join(__dirname, '../../../docs/operations/fixtures/macmini-runtime-inventory.fixture.json'),
    path.join(__dirname, '../../../docs/plans/2026-07-24-phase0-macmini-runtime-inventory.md'),
  ];

  for (const artifactPath of story2Artifacts) {
    const text = fs.readFileSync(artifactPath, 'utf8');
    const label = path.relative(path.join(__dirname, '../../..'), artifactPath);
    assert.equal(RAW_USER_PATH_PATTERN.test(text), false, `${label} must not contain raw /Users/<segment> paths`);
    assert.equal(PERSONAL_NAME_PATTERN.test(text), false, `${label} must not contain personal-name fragments`);
  }
});

test('forbidden runtime capabilities are classified as P0-S2-UNSAFE-RUNTIME-CAPABILITY', () => {
  assert.equal(isForbiddenRuntimeCapability('no-approval-runner'), true);
  assert.equal(isForbiddenRuntimeCapability('approval-bypass'), true);
  assert.equal(isForbiddenRuntimeCapability('yolo-runner'), true);
  assert.equal(isForbiddenRuntimeCapability('chat-stream'), false);
  assert.equal(isForbiddenRuntimeCapability('streaming-runner-logs'), false);

  const capabilities = [
    'chat-stream',
    'no-approval-runner',
    'tools-registry',
    'approval-bypass',
    'yolo-mode',
  ];
  assert.deepEqual(
    findForbiddenRuntimeCapabilities(capabilities),
    ['no-approval-runner', 'approval-bypass', 'yolo-mode'],
  );

  const blocker = buildUnsafeRuntimeCapabilityBlocker({ capabilities });
  assert.ok(blocker);
  assert.equal(blocker.id, UNSAFE_RUNTIME_CAPABILITY_BLOCKER_ID);
  assert.deepEqual(blocker.forbiddenCapabilities, ['no-approval-runner', 'approval-bypass', 'yolo-mode']);
  // Preserve the full redacted capability list for evidence.
  assert.deepEqual(blocker.evidence.capabilities, capabilities);
  assert.equal(buildUnsafeRuntimeCapabilityBlocker({ capabilities: ['chat-stream'] }), null);
});

test('fixture validation models unsafe runtime capabilities only with the required blocker', () => {
  const inventory = loadFixture();
  inventory.runtimeCapabilities = [
    'chat-stream',
    'no-approval-runner',
    'streaming-runner-logs',
  ];
  const missingBlocker = validateMacminiRuntimeInventory(inventory);
  assert.equal(missingBlocker.ok, false);
  assert.equal(
    missingBlocker.errors.some((error) => error.includes(UNSAFE_RUNTIME_CAPABILITY_BLOCKER_ID)),
    true,
  );

  inventory.blockers = [
    ...inventory.blockers,
    buildUnsafeRuntimeCapabilityBlocker({ capabilities: inventory.runtimeCapabilities }),
  ];
  const modeled = validateMacminiRuntimeInventory(inventory);
  assert.equal(modeled.ok, true, modeled.errors.join('\n'));
});

test('probe reports P0-S2-UNSAFE-RUNTIME-CAPABILITY when health advertises no-approval-runner', () => {
  const result = spawnSync(process.execPath, [CLI_PATH, '--probe'], {
    encoding: 'utf8',
  });
  assert.equal([0, 2].includes(result.status), true, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(Array.isArray(payload.blockers), true);
  const unsafe = payload.blockers.find((entry) => entry.id === UNSAFE_RUNTIME_CAPABILITY_BLOCKER_ID);
  if (Array.isArray(payload.runtimeHealth?.capabilities)
    && payload.runtimeHealth.capabilities.some((item) => isForbiddenRuntimeCapability(item))) {
    assert.ok(unsafe, 'probe must emit the unsafe capability blocker when health advertises forbidden markers');
    assert.equal(Array.isArray(unsafe.forbiddenCapabilities) && unsafe.forbiddenCapabilities.length > 0, true);
    assert.equal(Array.isArray(unsafe.evidence?.capabilities) && unsafe.evidence.capabilities.length > 0, true);
    assert.equal(
      unsafe.evidence.capabilities.includes('no-approval-runner')
        || unsafe.forbiddenCapabilities.includes('no-approval-runner'),
      true,
    );
  }
});
