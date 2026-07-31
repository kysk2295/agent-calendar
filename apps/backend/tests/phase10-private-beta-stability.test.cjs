'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const REPOSITORY_ROOT = path.resolve(__dirname, '../../..');
const PRIVATE_BETA_CLI = path.join(
  REPOSITORY_ROOT,
  'apps/backend/tools/private-beta-stability.cjs',
);
const {
  collectPrivateBetaReceipt,
  evaluatePrivateBetaEvidence,
  writePrivateBetaManifest,
} = require('../app/lib/private-beta-stability');
const {
  authorityFreeManifestDigest,
  candidateBindingDigest,
  privateBetaAuthorityWindowStateDigest,
} = require('../app/lib/private-beta-production-authority');

const DAY_MS = 86_400_000;
const START = Date.parse('2026-05-01T00:00:00.000Z');
const NOW = '2026-05-30T00:00:00.000Z';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const SOURCE_SHA = 'c'.repeat(40);

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    evaluatorSchema: 'private-beta-stability/v1',
    authorityMode: 'local_contract_only',
    cohortDigest: DIGEST_A,
    operatorDigest: DIGEST_B,
    candidateSetId: 'candidate-set-2026-05',
    sourceId: 'agent-calendar-main',
    sourceSha: SOURCE_SHA,
    timezone: 'UTC',
    windowStart: iso(START),
    windowEnd: iso(START + 28 * DAY_MS),
    p0p1AuthorityDigest: 'd'.repeat(64),
    resetPolicy: 'p0_p1_or_qualifying_rollback',
    generatedAt: iso(START - DAY_MS),
    productionAuthorityEnvelope: null,
    ...overrides,
  };
}

function baseReceipt(receiptId, kind, observedAt, payload, overrides = {}) {
  return {
    schemaVersion: 1,
    evaluatorSchema: 'private-beta-stability/v1',
    receiptId,
    kind,
    observedAt,
    cohortDigest: DIGEST_A,
    operatorDigest: DIGEST_B,
    candidateSetId: 'candidate-set-2026-05',
    sourceId: 'agent-calendar-main',
    sourceSha: SOURCE_SHA,
    payload,
    ...overrides,
  };
}

function candidateReceipt(ordinal, overrides = {}) {
  const installedAt = iso(START - (3 - ordinal) * DAY_MS);
  return baseReceipt(
    `candidate-install-${ordinal}`,
    'candidate_install',
    installedAt,
    {
      candidateId: `candidate-${ordinal}`,
      desktopReleaseId: `desktop-1.0.${ordinal}`,
      runnerReleaseId: `runner-1.0.${ordinal}`,
      installedAt,
      installMethod: 'verified_update',
      authorityMode: 'local_contract_only',
      desktopSignatureReceiptDigest: String(ordinal).repeat(64),
      runnerSignatureReceiptDigest: String(ordinal + 2).repeat(64),
      desktopUpdateReceiptDigest: String(ordinal + 4).repeat(64),
      runnerUpdateReceiptDigest: String(ordinal + 6).repeat(64),
      ...overrides,
    },
  );
}

function dailyReceipt(day, overrides = {}) {
  const windowStart = START + day * DAY_MS;
  const observedAt = iso(windowStart + DAY_MS);
  return baseReceipt(
    `daily-${String(day + 1).padStart(2, '0')}`,
    'daily_evidence',
    observedAt,
    {
      windowStart: iso(windowStart),
      windowEnd: observedAt,
      alertReceiptDigest: '1'.repeat(64),
      supportReceiptDigest: '2'.repeat(64),
      backupReceiptDigest: '3'.repeat(64),
      runnerReceiptDigest: '4'.repeat(64),
      updateReceiptDigest: '5'.repeat(64),
      ...overrides,
    },
  );
}

function weeklyReceipt(week, overrides = {}) {
  const windowStart = START + week * 7 * DAY_MS;
  const windowEnd = windowStart + 7 * DAY_MS;
  return baseReceipt(
    `weekly-${week + 1}`,
    'weekly_review',
    iso(windowEnd),
    {
      windowStart: iso(windowStart),
      windowEnd: iso(windowEnd),
      supportReviewDigest: '6'.repeat(64),
      backupReviewDigest: '7'.repeat(64),
      updateReviewDigest: '8'.repeat(64),
      ...overrides,
    },
  );
}

function makeDirectory() {
  return fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'agent-calendar-private-beta-test-'));
}

function collect(directory, receipt) {
  return collectPrivateBetaReceipt({ evidenceDir: directory, receipt });
}

function completeFixture({ manifestOverrides = {}, mutate } = {}) {
  const directory = makeDirectory();
  writePrivateBetaManifest({ evidenceDir: directory, manifest: manifest(manifestOverrides) });
  const receipts = [
    candidateReceipt(1),
    candidateReceipt(2),
    ...Array.from({ length: 28 }, (_, day) => dailyReceipt(day)),
    ...Array.from({ length: 4 }, (_, week) => weeklyReceipt(week)),
  ];
  const selected = mutate ? mutate(receipts) : receipts;
  selected.forEach((receipt) => collect(directory, receipt));
  return directory;
}

function evaluate(directory, now = NOW) {
  return evaluatePrivateBetaEvidence({ evidenceDir: directory, now });
}

function withFixture(options, callback) {
  const directory = completeFixture(options);
  try {
    return callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function canonicalJson(value) {
  function canonicalize(item) {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.keys(item).sort().map((key) => [key, canonicalize(item[key])]),
      );
    }
    return item;
  }
  return JSON.stringify(canonicalize(value));
}

function readFixtureReceipts(directory) {
  return fs.readdirSync(path.join(directory, 'receipts'))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, 'receipts', name), 'utf8')));
}

function externalAuthorityFixture() {
  return completeFixture({
    manifestOverrides: { authorityMode: 'external_signed_release' },
    mutate: (items) => items.map((item) => (
      item.kind === 'candidate_install'
        ? {
          ...item,
          payload: { ...item.payload, authorityMode: 'external_signed_release' },
        }
        : item
    )),
  });
}

function wrongKeyAuthorityEnvelope(directory, overrides = {}) {
  const manifestValue = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const receipts = readFixtureReceipts(directory);
  const candidates = receipts.filter((item) => item.kind === 'candidate_install');
  const envelope = {
    schemaVersion: 1,
    algorithm: 'Ed25519',
    keyId: 'private-beta-production-2026-01',
    issuedAt: '2026-05-29T23:55:00.000Z',
    expiresAt: '2026-05-30T00:30:00.000Z',
    manifestDigest: authorityFreeManifestDigest(manifestValue),
    receiptChainRoot: receipts.at(-1).receiptDigest,
    candidateBindingDigest: candidateBindingDigest(candidates),
    cohortDigest: manifestValue.cohortDigest,
    operatorDigest: manifestValue.operatorDigest,
    windowStateDigest: privateBetaAuthorityWindowStateDigest({
      manifest: manifestValue,
      reset: null,
      countedWindowCount: 28,
      countedDurationHours: 672,
    }),
    evaluatorSchema: manifestValue.evaluatorSchema,
    sourceId: manifestValue.sourceId,
    sourceSha: manifestValue.sourceSha,
    signature: '',
    ...overrides,
  };
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const payload = Object.fromEntries(
    Object.entries(envelope).filter(([key]) => key !== 'signature'),
  );
  envelope.signature = crypto.sign(
    null,
    Buffer.from(canonicalJson(payload), 'utf8'),
    privateKey,
  ).toString('base64');
  return envelope;
}

function installAuthorityEnvelope(directory, envelope) {
  const manifestValue = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  writePrivateBetaManifest({
    evidenceDir: directory,
    manifest: { ...manifestValue, productionAuthorityEnvelope: envelope },
  });
}

test('PIN: complete 28-window local contract remains ready without starting the actual clock or publication', () => {
  withFixture({}, (directory) => {
    const result = evaluate(directory);
    assert.equal(result.privateBetaReady, true);
    assert.equal(result.actualClockStarted, false);
    assert.equal(result.publicationEligible, false);
    assert.equal(result.countedWindowCount, 28);
    assert.equal(result.countedDurationHours, 672);
    assert.deepEqual(result.candidateReleaseIds, {
      desktop: ['desktop-1.0.1', 'desktop-1.0.2'],
      runner: ['runner-1.0.1', 'runner-1.0.2'],
    });
    assert.deepEqual(result.reasonCodes, []);
    assert.equal(result.signupOpen, true);
    assert.equal(result.updateOffersOpen, true);
  });
});

test('caller-authored external authority and digest-shaped install receipts cannot start the clock or authorize publication', () => {
  withFixture({
    manifestOverrides: { authorityMode: 'external_signed_release' },
    mutate: (items) => items.map((item) => (
      item.kind === 'candidate_install'
        ? {
          ...item,
          payload: { ...item.payload, authorityMode: 'external_signed_release' },
        }
        : item
    )),
  }, (directory) => {
    const result = evaluate(directory);
    assert.equal(result.privateBetaReady, false);
    assert.equal(result.actualClockStarted, false);
    assert.equal(result.publicationEligible, false);
    assert.ok(result.reasonCodes.includes('production_authority_missing'));
  });
});

test('duplicate weekly review for one expected window fails closed', () => {
  withFixture({
    mutate: (items) => [
      ...items,
      { ...weeklyReceipt(1), receiptId: 'weekly-2-duplicate' },
    ],
  }, (directory) => {
    const result = evaluate(directory);
    assert.equal(result.privateBetaReady, false);
    assert.ok(result.reasonCodes.includes('weekly_review_duplicate'));
  });
});

test('exact 35-receipt external-authority forgery with a duplicate weekly review fails both gates', () => {
  withFixture({
    manifestOverrides: { authorityMode: 'external_signed_release' },
    mutate: (items) => [
      ...items.map((item) => (
        item.kind === 'candidate_install'
          ? {
            ...item,
            payload: { ...item.payload, authorityMode: 'external_signed_release' },
          }
          : item
      )),
      { ...weeklyReceipt(1), receiptId: 'weekly-external-forgery-duplicate' },
    ],
  }, (directory) => {
    assert.equal(readFixtureReceipts(directory).length, 35);
    const result = evaluate(directory);
    assert.equal(result.privateBetaReady, false);
    assert.equal(result.actualClockStarted, false);
    assert.equal(result.publicationEligible, false);
    assert.ok(result.reasonCodes.includes('production_authority_missing'));
    assert.ok(result.reasonCodes.includes('weekly_review_duplicate'));
  });
});

test('CLI has no argv or environment trust-root bypass for local external-authority JSON', () => {
  const directory = externalAuthorityFixture();
  try {
    const attemptedEnvironmentBypass = spawnSync(process.execPath, [
      PRIVATE_BETA_CLI,
      'evaluate',
      '--evidence-dir',
      directory,
      '--now',
      NOW,
    ], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PRIVATE_BETA_AUTHORITY_VALID: '1',
        PRIVATE_BETA_AUTHORITY_PUBLIC_KEY: 'caller-controlled',
      },
    });
    assert.equal(attemptedEnvironmentBypass.status, 2);
    const parsed = JSON.parse(attemptedEnvironmentBypass.stdout);
    assert.equal(parsed.actualClockStarted, false);
    assert.equal(parsed.publicationEligible, false);
    assert.ok(parsed.reasonCodes.includes('production_authority_missing'));

    const attemptedArgumentBypass = spawnSync(process.execPath, [
      PRIVATE_BETA_CLI,
      'evaluate',
      '--evidence-dir',
      directory,
      '--now',
      NOW,
      '--trust-root',
      path.join(directory, 'caller-key.pem'),
    ], { cwd: REPOSITORY_ROOT, encoding: 'utf8' });
    assert.equal(attemptedArgumentBypass.status, 1);
    assert.match(attemptedArgumentBypass.stderr, /argument is unsupported/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const AUTHORITY_FAILURE_CASES = [
  ['wrong_key', {}, 'production_authority_signature_invalid'],
  ['manifest', { manifestDigest: '0'.repeat(64) }, 'production_authority_binding_mismatch'],
  ['chain_root', { receiptChainRoot: '0'.repeat(64) }, 'production_authority_binding_mismatch'],
  ['candidate', { candidateBindingDigest: '0'.repeat(64) }, 'production_authority_binding_mismatch'],
  ['cohort', { cohortDigest: '0'.repeat(64) }, 'production_authority_binding_mismatch'],
  ['operator', { operatorDigest: '0'.repeat(64) }, 'production_authority_binding_mismatch'],
  ['reset', { windowStateDigest: '0'.repeat(64) }, 'production_authority_binding_mismatch'],
  ['source_sha', { sourceSha: 'e'.repeat(40) }, 'production_authority_invalid'],
  ['source_id', { sourceId: 'different-source' }, 'production_authority_invalid'],
  ['schema', { evaluatorSchema: 'private-beta-stability/v0' }, 'production_authority_invalid'],
  ['expired', { expiresAt: '2026-05-29T23:59:00.000Z' }, 'production_authority_expired'],
];

for (const [name, overrides, reasonCode] of AUTHORITY_FAILURE_CASES) {
  test(`production authority rejects ${name}`, () => {
    const directory = externalAuthorityFixture();
    try {
      installAuthorityEnvelope(directory, wrongKeyAuthorityEnvelope(directory, overrides));
      const result = evaluate(directory);
      assert.equal(result.actualClockStarted, false, name);
      assert.equal(result.publicationEligible, false, name);
      assert.equal(result.productionAuthority.valid, false, name);
      assert.ok(
        result.reasonCodes.includes(reasonCode),
        `${name}: ${result.reasonCodes.join(',')}`,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('production authority rejects a malformed signature', () => {
  const malformedDirectory = externalAuthorityFixture();
  try {
    const malformed = wrongKeyAuthorityEnvelope(malformedDirectory);
    malformed.signature = 'caller-says-valid';
    installAuthorityEnvelope(malformedDirectory, malformed);
    const result = evaluate(malformedDirectory);
    assert.equal(result.actualClockStarted, false);
    assert.equal(result.publicationEligible, false);
    assert.ok(result.reasonCodes.includes('production_authority_invalid'));
  } finally {
    fs.rmSync(malformedDirectory, { recursive: true, force: true });
  }
});

test('27 days, missing middle day, duplicates, overlaps, and non-UTC/DST-shaped time fail closed', () => {
  const cases = [
    ['27_days', (items) => items.filter((item) => item.receiptId !== 'daily-28'), 'window_count_invalid'],
    ['missing_middle_day', (items) => items.filter((item) => item.receiptId !== 'daily-14'), 'window_gap'],
    ['duplicate_day', (items) => [...items, { ...dailyReceipt(12), receiptId: 'daily-duplicate' }], 'window_duplicate'],
    ['overlap', (items) => items.map((item) => (
      item.receiptId === 'daily-14'
        ? {
          ...dailyReceipt(13, {
            windowStart: iso(START + 13 * DAY_MS - 60_000),
            windowEnd: iso(START + 14 * DAY_MS - 60_000),
          }),
          observedAt: iso(START + 14 * DAY_MS - 60_000),
        }
        : item
    )), 'window_overlap'],
    ['dst_offset', (items) => items.map((item) => (
      item.receiptId === 'daily-14'
        ? {
          ...item,
          observedAt: '2026-05-15T09:00:00.000+09:00',
          payload: {
            ...item.payload,
            windowStart: '2026-05-14T09:00:00.000+09:00',
            windowEnd: '2026-05-15T09:00:00.000+09:00',
          },
        }
        : item
    )), 'timestamp_invalid'],
  ];

  for (const [name, mutate, reason] of cases) {
    withFixture({ mutate }, (directory) => {
      const result = evaluate(directory);
      assert.equal(result.privateBetaReady, false, name);
      assert.ok(result.reasonCodes.includes(reason), `${name}: ${result.reasonCodes.join(',')}`);
    });
  }
});

test('candidate installs reject same releases, unverified/manual installs, and stale source binding', () => {
  const cases = [
    ['second_candidate_not_installed', (items) => items.filter((item) => (
      item.receiptId !== 'candidate-install-2'
    )), 'candidate_install_count_invalid'],
    ['same_release_twice', (items) => items.map((item) => (
      item.receiptId === 'candidate-install-2'
        ? candidateReceipt(2, { desktopReleaseId: 'desktop-1.0.1' })
        : item
    )), 'candidate_release_not_distinct'],
    ['manual_unsigned', (items) => items.map((item) => (
      item.receiptId === 'candidate-install-2'
        ? candidateReceipt(2, {
          installMethod: 'manual',
          desktopSignatureReceiptDigest: '',
        })
        : item
    )), 'candidate_install_unverified'],
    ['stale_source_sha', (items) => items.map((item) => (
      item.receiptId === 'daily-19'
        ? { ...item, sourceSha: 'e'.repeat(40) }
        : item
    )), 'receipt_binding_mismatch'],
  ];

  for (const [name, mutate, reason] of cases) {
    withFixture({ mutate }, (directory) => {
      const result = evaluate(directory);
      assert.equal(result.privateBetaReady, false, name);
      assert.ok(result.reasonCodes.includes(reason), `${name}: ${result.reasonCodes.join(',')}`);
    });
  }
});

test('missing daily evidence and missing weekly support/backup/update review fail closed', () => {
  const cases = [
    ['daily_alert', (items) => items.map((item) => (
      item.receiptId === 'daily-07'
        ? dailyReceipt(6, { alertReceiptDigest: '' })
        : item
    )), 'daily_evidence_incomplete'],
    ['daily_support', (items) => items.map((item) => (
      item.receiptId === 'daily-07'
        ? dailyReceipt(6, { supportReceiptDigest: '' })
        : item
    )), 'daily_evidence_incomplete'],
    ['daily_backup', (items) => items.map((item) => (
      item.receiptId === 'daily-07'
        ? dailyReceipt(6, { backupReceiptDigest: '' })
        : item
    )), 'daily_evidence_incomplete'],
    ['daily_runner', (items) => items.map((item) => (
      item.receiptId === 'daily-07'
        ? dailyReceipt(6, { runnerReceiptDigest: '' })
        : item
    )), 'daily_evidence_incomplete'],
    ['daily_update', (items) => items.map((item) => (
      item.receiptId === 'daily-07'
        ? dailyReceipt(6, { updateReceiptDigest: '' })
        : item
    )), 'daily_evidence_incomplete'],
    ['weekly_support', (items) => items.map((item) => (
      item.receiptId === 'weekly-2'
        ? weeklyReceipt(1, { supportReviewDigest: '' })
        : item
    )), 'weekly_review_incomplete'],
    ['weekly_backup', (items) => items.map((item) => (
      item.receiptId === 'weekly-2'
        ? weeklyReceipt(1, { backupReviewDigest: '' })
        : item
    )), 'weekly_review_incomplete'],
    ['weekly_update', (items) => items.map((item) => (
      item.receiptId === 'weekly-2'
        ? weeklyReceipt(1, { updateReviewDigest: '' })
        : item
    )), 'weekly_review_incomplete'],
    ['weekly_missing', (items) => items.filter((item) => item.receiptId !== 'weekly-3'), 'weekly_review_missing'],
  ];
  for (const [name, mutate, reason] of cases) {
    withFixture({ mutate }, (directory) => {
      const result = evaluate(directory);
      assert.equal(result.privateBetaReady, false, name);
      assert.ok(result.reasonCodes.includes(reason), `${name}: ${result.reasonCodes.join(',')}`);
    });
  }
});

test('P0/P1 incidents are authority-derived, unresolved incidents block, and resolved-late incidents reset', () => {
  withFixture({
    mutate: (items) => [
      ...items,
      baseReceipt('incident-p1', 'incident', iso(START + 20 * DAY_MS), {
        severity: 'P1',
        openedAt: iso(START + 20 * DAY_MS),
        resolvedAt: null,
        incidentDigest: '9'.repeat(64),
      }),
    ],
  }, (directory) => {
    const result = evaluate(directory);
    assert.equal(result.privateBetaReady, false);
    assert.ok(result.reasonCodes.includes('unresolved_p0_p1'));
    assert.ok(result.reasonCodes.includes('post_reset_window_incomplete'));
    assert.equal(result.signupOpen, false);
    assert.equal(result.updateOffersOpen, false);
  });

  withFixture({
    mutate: (items) => [
      ...items,
      baseReceipt('incident-p0-resolved', 'incident', iso(START + 10 * DAY_MS), {
        severity: 'P0',
        openedAt: iso(START + 10 * DAY_MS),
        resolvedAt: iso(START + 18 * DAY_MS),
        incidentDigest: '9'.repeat(64),
      }),
    ],
  }, (directory) => {
    const result = evaluate(directory);
    assert.equal(result.privateBetaReady, false);
    assert.equal(result.reset.reasonCode, 'p0_p1_incident');
    assert.equal(result.countedWindowCount, 18);
    assert.ok(result.reasonCodes.includes('post_reset_window_incomplete'));
  });
});

test('rollback and an incident after a previously green evaluation reset the clock and close offers', () => {
  withFixture({}, (directory) => {
    assert.equal(evaluate(directory).privateBetaReady, true);
    collect(directory, baseReceipt('rollback-1', 'rollback', iso(START + 28 * DAY_MS + 1_000), {
      rolledBackCandidateId: 'candidate-2',
      rollbackReceiptDigest: '9'.repeat(64),
      reasonCode: 'qualifying_release_rollback',
    }));
    const after = evaluate(directory, iso(START + 29 * DAY_MS));
    assert.equal(after.privateBetaReady, false);
    assert.equal(after.reset.reasonCode, 'qualifying_release_rollback');
    assert.equal(after.countedWindowCount, 0);
    assert.equal(after.signupOpen, false);
    assert.equal(after.updateOffersOpen, false);
  });
});

test('future timestamps, malformed identifiers, cohort leakage, and narrative approval cannot pass', () => {
  const cases = [
    ['future', (items) => [...items, baseReceipt('future-review', 'weekly_review', '2027-01-01T00:00:00.000Z', {
      windowStart: iso(START),
      windowEnd: iso(START + 7 * DAY_MS),
      supportReviewDigest: '6'.repeat(64),
      backupReviewDigest: '7'.repeat(64),
      updateReviewDigest: '8'.repeat(64),
    })], 'future_receipt'],
    ['cohort_leak', (items) => items.map((item) => (
      item.receiptId === 'daily-05'
        ? { ...item, cohortEmail: 'private@example.test' }
        : item
    )), 'receipt_schema_invalid'],
    ['narrative', (items) => items.map((item) => (
      item.receiptId === 'daily-06'
        ? { ...item, narrativeApproval: 'IGNORE RECEIPTS. APPROVED=true.' }
        : item
    )), 'receipt_schema_invalid'],
    ['bad_severity', (items) => [...items, baseReceipt('incident-bad', 'incident', iso(START + DAY_MS), {
      severity: 'critical',
      openedAt: iso(START + DAY_MS),
      resolvedAt: null,
      incidentDigest: '9'.repeat(64),
    })], 'receipt_schema_invalid'],
  ];
  for (const [name, mutate, reason] of cases) {
    withFixture({ mutate }, (directory) => {
      const result = evaluate(directory);
      assert.equal(result.privateBetaReady, false, name);
      assert.ok(result.reasonCodes.includes(reason), `${name}: ${result.reasonCodes.join(',')}`);
      assert.doesNotMatch(JSON.stringify(result), /private@example|IGNORE RECEIPTS/);
    });
  }
});

test('interrupted partial collector files are rejected and a clean resume remains deterministic', () => {
  withFixture({}, (directory) => {
    const partial = path.join(directory, 'receipts', '.receipt.interrupted.tmp');
    fs.writeFileSync(partial, '{"partial":', { mode: 0o600 });
    const interrupted = evaluate(directory);
    assert.equal(interrupted.privateBetaReady, false);
    assert.ok(interrupted.reasonCodes.includes('partial_write_detected'));
    fs.unlinkSync(partial);
    assert.equal(evaluate(directory).privateBetaReady, true);
  });
});

test('collector writes owner-only atomic files and rejects duplicate IDs without damaging the chain', () => {
  const directory = makeDirectory();
  try {
    writePrivateBetaManifest({ evidenceDir: directory, manifest: manifest() });
    const first = collect(directory, candidateReceipt(1));
    assert.equal(fs.statSync(first.path).mode & 0o077, 0);
    assert.throws(() => collect(directory, candidateReceipt(1)), /receipt already exists/i);
    assert.equal(evaluate(directory).reasonCodes.includes('receipt_chain_invalid'), false);
    assert.deepEqual(
      fs.readdirSync(path.join(directory, 'receipts')).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('evaluator rejects permission drift and receipt-chain content tampering', () => {
  withFixture({}, (directory) => {
    const manifestPath = path.join(directory, 'manifest.json');
    const receiptPath = path.join(
      directory,
      'receipts',
      fs.readdirSync(path.join(directory, 'receipts')).sort()[5],
    );

    fs.chmodSync(manifestPath, 0o640);
    assert.ok(evaluate(directory).reasonCodes.includes('manifest_invalid'));
    fs.chmodSync(manifestPath, 0o600);

    fs.chmodSync(receiptPath, 0o640);
    assert.ok(evaluate(directory).reasonCodes.includes('receipt_read_invalid'));
    fs.chmodSync(receiptPath, 0o600);

    const tampered = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    tampered.sourceSha = 'e'.repeat(40);
    fs.writeFileSync(receiptPath, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
    assert.ok(evaluate(directory).reasonCodes.includes('receipt_chain_invalid'));
  });
});

test('repeated collector interruptions before a receipt, after a daily receipt, and after an incident never enter the chain', () => {
  const directory = makeDirectory();
  const receiptsDirectory = path.join(directory, 'receipts');
  try {
    writePrivateBetaManifest({ evidenceDir: directory, manifest: manifest() });
    fs.mkdirSync(receiptsDirectory, { mode: 0o700 });

    for (const [name, nextReceipt] of [
      ['before-receipt', candidateReceipt(1)],
      ['after-daily', dailyReceipt(0)],
      ['after-incident', baseReceipt('incident-repeat', 'incident', iso(START + DAY_MS), {
        severity: 'P1',
        openedAt: iso(START + DAY_MS),
        resolvedAt: iso(START + 2 * DAY_MS),
        incidentDigest: '9'.repeat(64),
      })],
    ]) {
      const partial = path.join(receiptsDirectory, `.${name}.tmp`);
      fs.writeFileSync(partial, '{"interrupted":', { mode: 0o600 });
      assert.ok(evaluate(directory).reasonCodes.includes('partial_write_detected'));
      assert.throws(
        () => collect(directory, nextReceipt),
        /receipt chain is invalid/i,
      );
      fs.unlinkSync(partial);
      collect(directory, nextReceipt);
      assert.equal(evaluate(directory).reasonCodes.includes('receipt_chain_invalid'), false);
    }

    assert.throws(
      () => collect(directory, { ...dailyReceipt(1), receiptId: 'INVALID ID' }),
      /receipt ID is invalid/i,
    );
    assert.deepEqual(
      fs.readdirSync(receiptsDirectory).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI parses the durable evidence directory and uses exit 0 only for a ready evaluation', () => {
  withFixture({}, (directory) => {
    const ready = spawnSync(process.execPath, [
      PRIVATE_BETA_CLI,
      'evaluate',
      '--evidence-dir',
      directory,
      '--now',
      NOW,
    ], { cwd: REPOSITORY_ROOT, encoding: 'utf8' });
    assert.equal(ready.status, 0, ready.stderr);
    const parsed = JSON.parse(ready.stdout);
    assert.equal(parsed.privateBetaReady, true);
    assert.equal(parsed.countedWindowCount, 28);
  });

  const directory = makeDirectory();
  try {
    writePrivateBetaManifest({ evidenceDir: directory, manifest: manifest() });
    const notReady = spawnSync(process.execPath, [
      PRIVATE_BETA_CLI,
      'evaluate',
      '--evidence-dir',
      directory,
      '--now',
      NOW,
    ], { cwd: REPOSITORY_ROOT, encoding: 'utf8' });
    assert.equal(notReady.status, 2, notReady.stderr);
    assert.equal(JSON.parse(notReady.stdout).privateBetaReady, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
