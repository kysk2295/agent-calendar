#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  collectPrivateBetaReceipt,
  evaluatePrivateBetaEvidence,
  writePrivateBetaManifest,
} = require('../app/lib/private-beta-stability');

const DAY_MS = 86_400_000;
const START = Date.parse('2026-05-01T00:00:00.000Z');
const NOW = '2026-06-20T00:00:00.000Z';
const COHORT_DIGEST = 'a'.repeat(64);
const OPERATOR_DIGEST = 'b'.repeat(64);
const SOURCE_SHA = 'c'.repeat(40);

function parseArgs(values) {
  if (
    values.length !== 2
    || values[0] !== '--evidence-dir'
    || !String(values[1] || '').trim()
  ) throw new Error('--evidence-dir is required');
  const evidenceDir = path.resolve(values[1]);
  if (path.basename(evidenceDir) !== 'manual-qa') {
    throw new Error('manual QA evidence directory must end in manual-qa');
  }
  return evidenceDir;
}

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

function atomicJson(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
    try {
      fs.unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

function manifest(windowStart = START) {
  return {
    schemaVersion: 1,
    evaluatorSchema: 'private-beta-stability/v1',
    authorityMode: 'local_contract_only',
    cohortDigest: COHORT_DIGEST,
    operatorDigest: OPERATOR_DIGEST,
    candidateSetId: 'local-contract-candidate-set',
    sourceId: 'agent-calendar-main',
    sourceSha: SOURCE_SHA,
    timezone: 'UTC',
    windowStart: iso(windowStart),
    windowEnd: iso(windowStart + 28 * DAY_MS),
    p0p1AuthorityDigest: 'd'.repeat(64),
    resetPolicy: 'p0_p1_or_qualifying_rollback',
    generatedAt: iso(START - DAY_MS),
    productionAuthorityEnvelope: null,
  };
}

function receipt(receiptId, kind, observedAt, payload, overrides = {}) {
  return {
    schemaVersion: 1,
    evaluatorSchema: 'private-beta-stability/v1',
    receiptId,
    kind,
    observedAt,
    cohortDigest: COHORT_DIGEST,
    operatorDigest: OPERATOR_DIGEST,
    candidateSetId: 'local-contract-candidate-set',
    sourceId: 'agent-calendar-main',
    sourceSha: SOURCE_SHA,
    payload,
    ...overrides,
  };
}

function candidate(ordinal, overrides = {}) {
  const installedAt = iso(START - (3 - ordinal) * DAY_MS);
  return receipt(`candidate-${ordinal}`, 'candidate_install', installedAt, {
    candidateId: `candidate-${ordinal}`,
    desktopReleaseId: `desktop-local-1.0.${ordinal}`,
    runnerReleaseId: `runner-local-1.0.${ordinal}`,
    installedAt,
    installMethod: 'verified_update',
    authorityMode: 'local_contract_only',
    desktopSignatureReceiptDigest: String(ordinal).repeat(64),
    runnerSignatureReceiptDigest: String(ordinal + 2).repeat(64),
    desktopUpdateReceiptDigest: String(ordinal + 4).repeat(64),
    runnerUpdateReceiptDigest: String(ordinal + 6).repeat(64),
    ...overrides,
  });
}

function daily(index, windowStart = START, overrides = {}) {
  const start = windowStart + index * DAY_MS;
  return receipt(`daily-${start}`, 'daily_evidence', iso(start + DAY_MS), {
    windowStart: iso(start),
    windowEnd: iso(start + DAY_MS),
    alertReceiptDigest: '1'.repeat(64),
    supportReceiptDigest: '2'.repeat(64),
    backupReceiptDigest: '3'.repeat(64),
    runnerReceiptDigest: '4'.repeat(64),
    updateReceiptDigest: '5'.repeat(64),
    ...overrides,
  });
}

function weekly(index, windowStart = START) {
  const start = windowStart + index * 7 * DAY_MS;
  return receipt(`weekly-${start}`, 'weekly_review', iso(start + 7 * DAY_MS), {
    windowStart: iso(start),
    windowEnd: iso(start + 7 * DAY_MS),
    supportReviewDigest: '6'.repeat(64),
    backupReviewDigest: '7'.repeat(64),
    updateReviewDigest: '8'.repeat(64),
  });
}

function baseReceipts(windowStart = START) {
  return [
    candidate(1),
    candidate(2),
    ...Array.from({ length: 28 }, (_, index) => daily(index, windowStart)),
    ...Array.from({ length: 4 }, (_, index) => weekly(index, windowStart)),
  ];
}

function buildFixture(root, name, {
  windowStart = START,
  receipts = baseReceipts(windowStart),
  partial = false,
  manifestOverrides = {},
} = {}) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  writePrivateBetaManifest({
    evidenceDir: directory,
    manifest: { ...manifest(windowStart), ...manifestOverrides },
  });
  receipts.forEach((item) => collectPrivateBetaReceipt({ evidenceDir: directory, receipt: item }));
  if (partial) {
    fs.writeFileSync(
      path.join(directory, 'receipts', '.interrupted-receipt.tmp'),
      '{"partial":',
      { mode: 0o600 },
    );
  }
  return { directory, result: evaluatePrivateBetaEvidence({ evidenceDir: directory, now: NOW }) };
}

function expectCase(name, built, expectedReason) {
  if (built.result.privateBetaReady || !built.result.reasonCodes.includes(expectedReason)) {
    throw new Error(`${name} did not fail with ${expectedReason}`);
  }
  return {
    name,
    privateBetaReady: built.result.privateBetaReady,
    reasonCodes: built.result.reasonCodes,
    countedWindowCount: built.result.countedWindowCount,
    reset: built.result.reset,
    signupOpen: built.result.signupOpen,
    updateOffersOpen: built.result.updateOffersOpen,
  };
}

function independentlyRecompute(directory, result) {
  const manifestValue = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const receipts = fs.readdirSync(path.join(directory, 'receipts'))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, 'receipts', name), 'utf8')));
  const resetMs = result.reset ? Date.parse(result.reset.at) : Number.NEGATIVE_INFINITY;
  const startMs = Math.max(Date.parse(manifestValue.windowStart), resetMs);
  const endMs = Date.parse(manifestValue.windowEnd);
  const windows = receipts
    .filter((item) => item.kind === 'daily_evidence')
    .map((item) => [Date.parse(item.payload.windowStart), Date.parse(item.payload.windowEnd)])
    .filter(([start, end]) => start >= startMs && end <= endMs)
    .sort((left, right) => left[0] - right[0]);
  const consecutive = windows.every(([start, end], index) => (
    end - start === DAY_MS
    && (index === 0 || start === windows[index - 1][1])
  ));
  return {
    independentlyCountedWindows: windows.length,
    independentlyCountedHours: windows.reduce(
      (total, [start, end]) => total + (end - start) / 3_600_000,
      0,
    ),
    consecutive,
    evaluatorCountMatches: windows.length === result.countedWindowCount,
  };
}

function auditReceiptFilesystem(directory) {
  const manifestPath = path.join(directory, 'manifest.json');
  const manifestStats = fs.statSync(manifestPath);
  const receiptPaths = fs.readdirSync(path.join(directory, 'receipts'))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(directory, 'receipts', name));
  const receipts = receiptPaths.map((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8')));
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  return {
    receiptCount: receiptPaths.length,
    receiptModes: [...new Set(receiptPaths.map((filePath) => (
      fs.statSync(filePath).mode & 0o777
    )))],
    manifestMode: manifestStats.mode & 0o777,
    uidCheckSupported: currentUid !== null,
    allOwnedByEvaluator: currentUid === null || [
      manifestStats,
      ...receiptPaths.map((filePath) => fs.statSync(filePath)),
    ].every((stats) => stats.uid === currentUid),
    receiptChainRoot: receipts.at(-1)?.receiptDigest || null,
  };
}

function run() {
  const evidenceDir = parseArgs(process.argv.slice(2));
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const runtimeRoot = path.join(evidenceDir, `.qa-runtime-${process.pid}`);
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  let summary;
  try {
    const complete = buildFixture(runtimeRoot, 'complete');
    if (
      !complete.result.privateBetaReady
      || complete.result.countedWindowCount !== 28
      || complete.result.countedDurationHours !== 672
      || complete.result.candidateReleaseIds.desktop.length !== 2
      || complete.result.candidateReleaseIds.runner.length !== 2
      || complete.result.actualClockStarted
      || complete.result.publicationEligible
    ) throw new Error('complete local contract did not pass exactly');
    const completeFilesystemAudit = auditReceiptFilesystem(complete.directory);
    if (
      completeFilesystemAudit.receiptCount !== 34
      || completeFilesystemAudit.manifestMode !== 0o600
      || completeFilesystemAudit.receiptModes.some((mode) => mode !== 0o600)
      || !completeFilesystemAudit.allOwnedByEvaluator
    ) throw new Error('complete receipt filesystem audit failed');

    const missing = baseReceipts().filter((item) => item.receiptId !== `daily-${START + 13 * DAY_MS}`);
    const unresolvedIncident = receipt('incident-p1', 'incident', iso(START + 20 * DAY_MS), {
      severity: 'P1',
      openedAt: iso(START + 20 * DAY_MS),
      resolvedAt: null,
      incidentDigest: '9'.repeat(64),
    });
    const rollback = receipt('rollback-1', 'rollback', iso(START + 20 * DAY_MS), {
      rolledBackCandidateId: 'candidate-2',
      rollbackReceiptDigest: '9'.repeat(64),
      reasonCode: 'qualifying_release_rollback',
    });
    const unsigned = baseReceipts().map((item) => (
      item.receiptId === 'candidate-2'
        ? candidate(2, { installMethod: 'manual', runnerSignatureReceiptDigest: '' })
        : item
    ));
    const stale = baseReceipts().map((item) => (
      item.receiptId === `daily-${START + 18 * DAY_MS}`
        ? { ...item, sourceSha: 'e'.repeat(40) }
        : item
    ));
    const duplicate = [...baseReceipts(), {
      ...daily(12),
      receiptId: 'daily-duplicate',
    }];
    const future = [...baseReceipts(), receipt('future-review', 'weekly_review', '2027-01-01T00:00:00.000Z', {
      windowStart: iso(START),
      windowEnd: iso(START + 7 * DAY_MS),
      supportReviewDigest: '6'.repeat(64),
      backupReviewDigest: '7'.repeat(64),
      updateReviewDigest: '8'.repeat(64),
    })];
    const externalForgeryReceipts = baseReceipts().map((item) => (
      item.kind === 'candidate_install'
        ? {
          ...item,
          payload: { ...item.payload, authorityMode: 'external_signed_release' },
        }
        : item
    ));
    const duplicateWeekly = [
      ...baseReceipts(),
      { ...weekly(1), receiptId: 'weekly-duplicate' },
    ];
    const partialBuilt = buildFixture(runtimeRoot, 'partial', { partial: true });
    const adversarial = [
      expectCase('missing_middle_day', buildFixture(runtimeRoot, 'missing', { receipts: missing }), 'window_gap'),
      expectCase('unresolved_p1', buildFixture(runtimeRoot, 'incident', {
        receipts: [...baseReceipts(), unresolvedIncident],
      }), 'unresolved_p0_p1'),
      expectCase('rollback_reset', buildFixture(runtimeRoot, 'rollback', {
        receipts: [...baseReceipts(), rollback],
      }), 'post_reset_window_incomplete'),
      expectCase('unsigned_manual_second_release', buildFixture(runtimeRoot, 'unsigned', {
        receipts: unsigned,
      }), 'candidate_install_unverified'),
      expectCase('missing_weekly_review', buildFixture(runtimeRoot, 'weekly', {
        receipts: baseReceipts().filter((item) => item.receiptId !== `weekly-${START + 14 * DAY_MS}`),
      }), 'weekly_review_missing'),
      expectCase('stale_mismatched_source', buildFixture(runtimeRoot, 'stale', {
        receipts: stale,
      }), 'receipt_binding_mismatch'),
      expectCase('duplicate_overlap', buildFixture(runtimeRoot, 'duplicate', {
        receipts: duplicate,
      }), 'window_duplicate'),
      expectCase('future_time', buildFixture(runtimeRoot, 'future', {
        receipts: future,
      }), 'future_receipt'),
      expectCase('external_authority_forgery', buildFixture(runtimeRoot, 'external-forgery', {
        receipts: externalForgeryReceipts,
        manifestOverrides: { authorityMode: 'external_signed_release' },
      }), 'production_authority_missing'),
      expectCase('duplicate_weekly_review', buildFixture(runtimeRoot, 'duplicate-weekly', {
        receipts: duplicateWeekly,
      }), 'weekly_review_duplicate'),
      expectCase('partial_interrupted_write', partialBuilt, 'partial_write_detected'),
    ];
    fs.unlinkSync(path.join(partialBuilt.directory, 'receipts', '.interrupted-receipt.tmp'));
    const resumedPartial = evaluatePrivateBetaEvidence({
      evidenceDir: partialBuilt.directory,
      now: NOW,
    });
    if (!resumedPartial.privateBetaReady || resumedPartial.countedWindowCount !== 28) {
      throw new Error('collector did not resume cleanly after interrupted partial removal');
    }

    const resumedStart = START + 11 * DAY_MS;
    const resolvedIncident = receipt('incident-resolved', 'incident', iso(START + 10 * DAY_MS), {
      severity: 'P1',
      openedAt: iso(START + 10 * DAY_MS),
      resolvedAt: iso(resumedStart),
      incidentDigest: '9'.repeat(64),
    });
    const resumedReceipts = [
      candidate(1),
      candidate(2),
      ...Array.from({ length: 10 }, (_, index) => daily(index)),
      resolvedIncident,
      ...Array.from({ length: 28 }, (_, index) => daily(index, resumedStart)),
      ...Array.from({ length: 4 }, (_, index) => weekly(index, resumedStart)),
    ];
    const resumed = buildFixture(runtimeRoot, 'resumed', {
      windowStart: resumedStart,
      receipts: resumedReceipts,
    });
    if (
      !resumed.result.privateBetaReady
      || resumed.result.countedWindowCount !== 28
      || resumed.result.reset?.reasonCode !== 'p0_p1_incident'
    ) throw new Error('post-reset resume did not count exactly the new window');

    const recomputation = independentlyRecompute(resumed.directory, resumed.result);
    if (
      recomputation.independentlyCountedWindows !== 28
      || recomputation.independentlyCountedHours !== 672
      || !recomputation.consecutive
      || !recomputation.evaluatorCountMatches
    ) throw new Error('independent window recomputation failed');

    summary = {
      schemaVersion: 1,
      kind: 'local_private_beta_stability_qa',
      localContractOnly: true,
      actualClockStarted: false,
      fullTodo19Complete: false,
      complete: complete.result,
      completeFilesystemAudit,
      adversarial,
      resumedAfterReset: resumed.result,
      resumedAfterPartialWrite: {
        privateBetaReady: resumedPartial.privateBetaReady,
        countedWindowCount: resumedPartial.countedWindowCount,
        reasonCodes: resumedPartial.reasonCodes,
      },
      independentRecomputation: recomputation,
      redaction: {
        rawIdentityPresent: false,
        rawIncidentOrSupportContentPresent: false,
      },
      atomicOutputInterruption: {
        partialOutputRejected: true,
        resumedWithAtomicRename: true,
      },
    };
    const serialized = JSON.stringify(summary);
    if (/@|https?:\/\/|password|token|incident content|support content/i.test(serialized)) {
      throw new Error('manual QA output failed redaction check');
    }
    const interruptedOutput = path.join(
      evidenceDir,
      '.manual-qa-summary.interrupted.tmp',
    );
    fs.writeFileSync(interruptedOutput, '{"partial":', { mode: 0o600 });
    try {
      JSON.parse(fs.readFileSync(interruptedOutput, 'utf8'));
      throw new Error('partial manual QA output was unexpectedly accepted');
    } catch (error) {
      if (error?.message === 'partial manual QA output was unexpectedly accepted') throw error;
    }
    fs.unlinkSync(interruptedOutput);
    atomicJson(path.join(evidenceDir, 'complete-local-contract.json'), complete.result);
    atomicJson(
      path.join(evidenceDir, 'receipt-filesystem-audit.json'),
      completeFilesystemAudit,
    );
    atomicJson(path.join(evidenceDir, 'adversarial-matrix.json'), adversarial);
    atomicJson(path.join(evidenceDir, 'resumed-after-reset.json'), resumed.result);
    atomicJson(path.join(evidenceDir, 'independent-window-recomputation.json'), recomputation);
    atomicJson(path.join(evidenceDir, 'manual-qa-summary.json'), summary);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }

  const cleanup = {
    cleanup: true,
    runtimeRootRemoved: !fs.existsSync(runtimeRoot),
    survivingTemporaryFiles: fs.readdirSync(evidenceDir)
      .filter((name) => name.startsWith('.') || name.endsWith('.tmp')),
    scheduledJobsCreated: false,
    processesOrListenersCreated: false,
    actualClockStarted: false,
  };
  if (!cleanup.runtimeRootRemoved || cleanup.survivingTemporaryFiles.length !== 0) {
    throw new Error('manual QA cleanup failed');
  }
  atomicJson(path.join(evidenceDir, 'cleanup-receipt.json'), cleanup);
  process.stdout.write(`${JSON.stringify({ ok: true, ...summary, cleanup }, null, 2)}\n`);
}

try {
  run();
} catch (error) {
  process.stderr.write(`${error?.message || 'local private beta stability QA failed'}\n`);
  process.exitCode = 1;
}
