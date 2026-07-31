'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  verifyPrivateBetaProductionAuthority,
} = require('./private-beta-production-authority');

const SCHEMA = 'private-beta-stability/v1';
const DAY_MS = 86_400_000;
const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_RECEIPTS = 512;
const ZERO_DIGEST = '0'.repeat(64);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,95}$/;
const RECEIPT_KINDS = new Set([
  'candidate_install',
  'daily_evidence',
  'incident',
  'rollback',
  'weekly_review',
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !value.endsWith('Z')) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) return null;
  return timestamp;
}

function safeId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function safeDigest(value) {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function ownedByCurrentProcess(stats) {
  return typeof process.getuid !== 'function' || stats.uid === process.getuid();
}

function atomicWrite(filePath, value, errorMessage) {
  const resolved = path.resolve(filePath);
  const directory = path.dirname(resolved);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new Error(errorMessage);
  }
  const temporary = path.join(
    directory,
    `.${path.basename(resolved)}.${process.pid}.${Date.now()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, serialized, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, resolved);
    fs.chmodSync(resolved, 0o600);
  } catch {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
    try {
      fs.unlinkSync(temporary);
    } catch {}
    throw new Error(errorMessage);
  }
}

function writePrivateBetaManifest({ evidenceDir, manifest }) {
  if (!evidenceDir || !manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('private beta manifest is invalid');
  }
  const filePath = path.join(path.resolve(evidenceDir), 'manifest.json');
  atomicWrite(filePath, manifest, 'private beta manifest write failed');
  return { path: filePath };
}

function readReceiptFiles(receiptsDirectory) {
  let names;
  try {
    names = fs.readdirSync(receiptsDirectory).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return { receipts: [], partial: false, readInvalid: false };
    return { receipts: [], partial: false, readInvalid: true };
  }
  const partial = names.some((name) => name.startsWith('.') || name.endsWith('.tmp'));
  const jsonNames = names.filter((name) => /^\d{6}-[a-z0-9][a-z0-9._-]{2,95}\.json$/.test(name));
  if (jsonNames.length > MAX_RECEIPTS || jsonNames.length !== names.filter((name) => name.endsWith('.json')).length) {
    return { receipts: [], partial, readInvalid: true };
  }
  const receipts = [];
  try {
    for (const name of jsonNames) {
      const filePath = path.join(receiptsDirectory, name);
      const stats = fs.lstatSync(filePath);
      if (
        !stats.isFile()
        || stats.isSymbolicLink()
        || stats.size > MAX_DOCUMENT_BYTES
        || (stats.mode & 0o077) !== 0
        || !ownedByCurrentProcess(stats)
      ) {
        return { receipts: [], partial, readInvalid: true };
      }
      const text = fs.readFileSync(filePath, 'utf8');
      receipts.push(JSON.parse(text));
    }
  } catch {
    return { receipts: [], partial, readInvalid: true };
  }
  return { receipts, partial, readInvalid: false };
}

function collectPrivateBetaReceipt({ evidenceDir, receipt }) {
  if (!evidenceDir || !receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('private beta receipt is invalid');
  }
  if (!safeId(receipt.receiptId)) throw new Error('private beta receipt ID is invalid');
  const receiptsDirectory = path.join(path.resolve(evidenceDir), 'receipts');
  fs.mkdirSync(receiptsDirectory, { recursive: true, mode: 0o700 });
  const current = readReceiptFiles(receiptsDirectory);
  if (current.partial || current.readInvalid || !validateChain(current.receipts)) {
    throw new Error('private beta receipt chain is invalid');
  }
  if (current.receipts.some((item) => item.receiptId === receipt.receiptId)) {
    throw new Error('private beta receipt already exists');
  }
  const prior = current.receipts.at(-1);
  const sequence = current.receipts.length + 1;
  const projected = {
    ...receipt,
    sequence,
    previousDigest: prior?.receiptDigest || ZERO_DIGEST,
  };
  projected.receiptDigest = digest(projected);
  const filePath = path.join(
    receiptsDirectory,
    `${String(sequence).padStart(6, '0')}-${receipt.receiptId}.json`,
  );
  atomicWrite(filePath, projected, 'private beta receipt write failed');
  return {
    path: filePath,
    receiptId: receipt.receiptId,
    receiptDigest: projected.receiptDigest,
    sequence,
  };
}

function loadManifest(evidenceDir) {
  const filePath = path.join(path.resolve(evidenceDir), 'manifest.json');
  try {
    const stats = fs.lstatSync(filePath);
    if (
      !stats.isFile()
      || stats.isSymbolicLink()
      || stats.size > MAX_DOCUMENT_BYTES
      || (stats.mode & 0o077) !== 0
      || !ownedByCurrentProcess(stats)
    ) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

const MANIFEST_KEYS = [
  'schemaVersion',
  'evaluatorSchema',
  'authorityMode',
  'cohortDigest',
  'operatorDigest',
  'candidateSetId',
  'sourceId',
  'sourceSha',
  'timezone',
  'windowStart',
  'windowEnd',
  'p0p1AuthorityDigest',
  'resetPolicy',
  'generatedAt',
  'productionAuthorityEnvelope',
];

function validateManifest(value, nowMs) {
  if (!exactKeys(value, MANIFEST_KEYS)) return null;
  const windowStart = canonicalTimestamp(value.windowStart);
  const windowEnd = canonicalTimestamp(value.windowEnd);
  const generatedAt = canonicalTimestamp(value.generatedAt);
  if (
    value.schemaVersion !== 1
    || value.evaluatorSchema !== SCHEMA
    || !['external_signed_release', 'local_contract_only'].includes(value.authorityMode)
    || !safeDigest(value.cohortDigest)
    || !safeDigest(value.operatorDigest)
    || !safeId(value.candidateSetId)
    || !safeId(value.sourceId)
    || !SHA_PATTERN.test(value.sourceSha)
    || value.timezone !== 'UTC'
    || windowStart === null
    || windowEnd === null
    || generatedAt === null
    || windowEnd - windowStart !== 28 * DAY_MS
    || windowStart % DAY_MS !== 0
    || !safeDigest(value.p0p1AuthorityDigest)
    || value.resetPolicy !== 'p0_p1_or_qualifying_rollback'
    || generatedAt > nowMs
    || (
      value.productionAuthorityEnvelope !== null
      && (
        typeof value.productionAuthorityEnvelope !== 'object'
        || Array.isArray(value.productionAuthorityEnvelope)
      )
    )
  ) return null;
  return { ...value, windowStartMs: windowStart, windowEndMs: windowEnd };
}

const BASE_RECEIPT_KEYS = [
  'schemaVersion',
  'evaluatorSchema',
  'receiptId',
  'kind',
  'observedAt',
  'cohortDigest',
  'operatorDigest',
  'candidateSetId',
  'sourceId',
  'sourceSha',
  'payload',
  'sequence',
  'previousDigest',
  'receiptDigest',
];

function bindingMatches(receipt, manifest) {
  return receipt.evaluatorSchema === manifest.evaluatorSchema
    && receipt.cohortDigest === manifest.cohortDigest
    && receipt.operatorDigest === manifest.operatorDigest
    && receipt.candidateSetId === manifest.candidateSetId
    && receipt.sourceId === manifest.sourceId
    && receipt.sourceSha === manifest.sourceSha;
}

function validBaseReceipt(receipt) {
  return exactKeys(receipt, BASE_RECEIPT_KEYS)
    && receipt.schemaVersion === 1
    && receipt.evaluatorSchema === SCHEMA
    && safeId(receipt.receiptId)
    && RECEIPT_KINDS.has(receipt.kind)
    && canonicalTimestamp(receipt.observedAt) !== null
    && safeDigest(receipt.cohortDigest)
    && safeDigest(receipt.operatorDigest)
    && safeId(receipt.candidateSetId)
    && safeId(receipt.sourceId)
    && SHA_PATTERN.test(receipt.sourceSha)
    && Number.isSafeInteger(receipt.sequence)
    && receipt.sequence >= 1
    && safeDigest(receipt.previousDigest)
    && safeDigest(receipt.receiptDigest);
}

function validateChain(receipts) {
  let previousDigest = ZERO_DIGEST;
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index];
    if (
      receipt.sequence !== index + 1
      || receipt.previousDigest !== previousDigest
      || digest(Object.fromEntries(
        Object.entries(receipt).filter(([key]) => key !== 'receiptDigest'),
      )) !== receipt.receiptDigest
    ) return false;
    previousDigest = receipt.receiptDigest;
  }
  return true;
}

function validCandidatePayload(payload, manifest) {
  const keys = [
    'candidateId',
    'desktopReleaseId',
    'runnerReleaseId',
    'installedAt',
    'installMethod',
    'authorityMode',
    'desktopSignatureReceiptDigest',
    'runnerSignatureReceiptDigest',
    'desktopUpdateReceiptDigest',
    'runnerUpdateReceiptDigest',
  ];
  return exactKeys(payload, keys)
    && safeId(payload.candidateId)
    && safeId(payload.desktopReleaseId)
    && safeId(payload.runnerReleaseId)
    && canonicalTimestamp(payload.installedAt) !== null
    && payload.installMethod === 'verified_update'
    && payload.authorityMode === manifest.authorityMode
    && [
      payload.desktopSignatureReceiptDigest,
      payload.runnerSignatureReceiptDigest,
      payload.desktopUpdateReceiptDigest,
      payload.runnerUpdateReceiptDigest,
    ].every(safeDigest);
}

function validDailyPayload(payload) {
  const keys = [
    'windowStart',
    'windowEnd',
    'alertReceiptDigest',
    'supportReceiptDigest',
    'backupReceiptDigest',
    'runnerReceiptDigest',
    'updateReceiptDigest',
  ];
  const start = canonicalTimestamp(payload?.windowStart);
  const end = canonicalTimestamp(payload?.windowEnd);
  return exactKeys(payload, keys)
    && start !== null
    && end !== null
    && end - start === DAY_MS
    && [
      payload.alertReceiptDigest,
      payload.supportReceiptDigest,
      payload.backupReceiptDigest,
      payload.runnerReceiptDigest,
      payload.updateReceiptDigest,
    ].every(safeDigest);
}

function validWeeklyPayload(payload) {
  const keys = [
    'windowStart',
    'windowEnd',
    'supportReviewDigest',
    'backupReviewDigest',
    'updateReviewDigest',
  ];
  const start = canonicalTimestamp(payload?.windowStart);
  const end = canonicalTimestamp(payload?.windowEnd);
  return exactKeys(payload, keys)
    && start !== null
    && end !== null
    && end - start === 7 * DAY_MS
    && start % DAY_MS === 0
    && [
      payload.supportReviewDigest,
      payload.backupReviewDigest,
      payload.updateReviewDigest,
    ].every(safeDigest);
}

function validIncidentPayload(payload) {
  const keys = ['severity', 'openedAt', 'resolvedAt', 'incidentDigest'];
  const openedAt = canonicalTimestamp(payload?.openedAt);
  const resolvedAt = payload?.resolvedAt === null ? null : canonicalTimestamp(payload?.resolvedAt);
  return exactKeys(payload, keys)
    && ['P0', 'P1'].includes(payload.severity)
    && openedAt !== null
    && (payload.resolvedAt === null || resolvedAt !== null)
    && (resolvedAt === null || resolvedAt >= openedAt)
    && safeDigest(payload.incidentDigest);
}

function validRollbackPayload(payload) {
  return exactKeys(payload, [
    'rolledBackCandidateId',
    'rollbackReceiptDigest',
    'reasonCode',
  ])
    && safeId(payload.rolledBackCandidateId)
    && safeDigest(payload.rollbackReceiptDigest)
    && payload.reasonCode === 'qualifying_release_rollback';
}

function baseResult(authorityMode = null) {
  return {
    schemaVersion: 1,
    evaluatorSchema: SCHEMA,
    privateBetaReady: false,
    actualClockStarted: false,
    publicationEligible: false,
    authorityMode,
    productionAuthority: {
      valid: false,
      reasonCode: null,
      keyId: null,
      expiresAt: null,
    },
    countedWindowCount: 0,
    countedDurationHours: 0,
    candidateReleaseIds: { desktop: [], runner: [] },
    reset: null,
    reasonCodes: [],
    signupOpen: false,
    updateOffersOpen: false,
  };
}

function evaluatePrivateBetaEvidence({ evidenceDir, now = new Date().toISOString() }) {
  const nowMs = canonicalTimestamp(now);
  const rawManifest = loadManifest(evidenceDir);
  const manifest = nowMs === null ? null : validateManifest(rawManifest, nowMs);
  const result = baseResult(rawManifest?.authorityMode || null);
  const reasons = new Set();
  if (nowMs === null || !manifest) reasons.add('manifest_invalid');

  const receiptRead = readReceiptFiles(path.join(path.resolve(evidenceDir), 'receipts'));
  if (receiptRead.partial) reasons.add('partial_write_detected');
  if (receiptRead.readInvalid) reasons.add('receipt_read_invalid');
  const receipts = receiptRead.receipts;
  if (!validateChain(receipts)) reasons.add('receipt_chain_invalid');
  if (!manifest) {
    result.reasonCodes = [...reasons].sort();
    return result;
  }

  const seenIds = new Set();
  const candidates = [];
  const daily = [];
  const weekly = [];
  const incidents = [];
  const rollbacks = [];
  for (const receipt of receipts) {
    if (
      canonicalTimestamp(receipt?.observedAt) === null
      || (
        ['daily_evidence', 'weekly_review'].includes(receipt?.kind)
        && (
          canonicalTimestamp(receipt?.payload?.windowStart) === null
          || canonicalTimestamp(receipt?.payload?.windowEnd) === null
        )
      )
    ) reasons.add('timestamp_invalid');
    if (!validBaseReceipt(receipt) || seenIds.has(receipt.receiptId)) {
      reasons.add('receipt_schema_invalid');
      continue;
    }
    seenIds.add(receipt.receiptId);
    if (!bindingMatches(receipt, manifest)) {
      reasons.add('receipt_binding_mismatch');
      continue;
    }
    const observedAt = canonicalTimestamp(receipt.observedAt);
    if (observedAt > nowMs) reasons.add('future_receipt');
    if (receipt.kind === 'candidate_install') {
      if (!validCandidatePayload(receipt.payload, manifest)) {
        reasons.add('candidate_install_unverified');
      } else {
        if (receipt.observedAt !== receipt.payload.installedAt) {
          reasons.add('receipt_schema_invalid');
          continue;
        }
        candidates.push(receipt);
      }
    } else if (receipt.kind === 'daily_evidence') {
      if (!validDailyPayload(receipt.payload)) {
        reasons.add(
          exactKeys(receipt.payload, [
            'windowStart',
            'windowEnd',
            'alertReceiptDigest',
            'supportReceiptDigest',
            'backupReceiptDigest',
            'runnerReceiptDigest',
            'updateReceiptDigest',
          ]) ? 'daily_evidence_incomplete' : 'receipt_schema_invalid',
        );
      } else {
        if (receipt.observedAt !== receipt.payload.windowEnd) {
          reasons.add('receipt_schema_invalid');
          continue;
        }
        daily.push(receipt);
      }
    } else if (receipt.kind === 'weekly_review') {
      if (!validWeeklyPayload(receipt.payload)) {
        reasons.add(
          exactKeys(receipt.payload, [
            'windowStart',
            'windowEnd',
            'supportReviewDigest',
            'backupReviewDigest',
            'updateReviewDigest',
          ]) ? 'weekly_review_incomplete' : 'receipt_schema_invalid',
        );
      } else {
        if (receipt.observedAt !== receipt.payload.windowEnd) {
          reasons.add('receipt_schema_invalid');
          continue;
        }
        weekly.push(receipt);
      }
    } else if (receipt.kind === 'incident') {
      if (!validIncidentPayload(receipt.payload)) reasons.add('receipt_schema_invalid');
      else if (receipt.observedAt !== receipt.payload.openedAt) reasons.add('receipt_schema_invalid');
      else incidents.push(receipt);
    } else if (receipt.kind === 'rollback') {
      if (!validRollbackPayload(receipt.payload)) reasons.add('receipt_schema_invalid');
      else rollbacks.push(receipt);
    }
  }

  const desktopReleaseIds = [...new Set(candidates.map((item) => item.payload.desktopReleaseId))].sort();
  const runnerReleaseIds = [...new Set(candidates.map((item) => item.payload.runnerReleaseId))].sort();
  result.candidateReleaseIds = {
    desktop: desktopReleaseIds,
    runner: runnerReleaseIds,
  };
  if (candidates.length !== 2) reasons.add('candidate_install_count_invalid');
  if (desktopReleaseIds.length !== candidates.length || runnerReleaseIds.length !== candidates.length) {
    reasons.add('candidate_release_not_distinct');
  }
  if (candidates.some((item) => canonicalTimestamp(item.payload.installedAt) > manifest.windowStartMs)) {
    reasons.add('candidate_install_too_late');
  }

  const resetEvents = [
    ...incidents.map((item) => ({
      atMs: canonicalTimestamp(item.payload.openedAt),
      at: item.payload.openedAt,
      reasonCode: 'p0_p1_incident',
      receiptId: item.receiptId,
    })),
    ...rollbacks.map((item) => ({
      atMs: canonicalTimestamp(item.observedAt),
      at: item.observedAt,
      reasonCode: 'qualifying_release_rollback',
      receiptId: item.receiptId,
    })),
  ].sort((a, b) => a.atMs - b.atMs || a.receiptId.localeCompare(b.receiptId));
  const latestReset = resetEvents.at(-1) || null;
  if (latestReset) {
    result.reset = {
      at: latestReset.at,
      reasonCode: latestReset.reasonCode,
      receiptId: latestReset.receiptId,
    };
  }
  if (incidents.some((item) => item.payload.resolvedAt === null)) {
    reasons.add('unresolved_p0_p1');
  }

  const countFrom = Math.max(manifest.windowStartMs, latestReset?.atMs || manifest.windowStartMs);
  const eligibleDaily = daily
    .filter((item) => {
      const start = canonicalTimestamp(item.payload.windowStart);
      const end = canonicalTimestamp(item.payload.windowEnd);
      return start >= countFrom && end <= manifest.windowEndMs;
    })
    .sort((a, b) => Date.parse(a.payload.windowStart) - Date.parse(b.payload.windowStart));
  const startCounts = new Map();
  for (const item of eligibleDaily) {
    startCounts.set(item.payload.windowStart, (startCounts.get(item.payload.windowStart) || 0) + 1);
  }
  if ([...startCounts.values()].some((count) => count > 1)) reasons.add('window_duplicate');
  for (let index = 1; index < eligibleDaily.length; index += 1) {
    const previousEnd = Date.parse(eligibleDaily[index - 1].payload.windowEnd);
    const currentStart = Date.parse(eligibleDaily[index].payload.windowStart);
    if (currentStart < previousEnd) reasons.add('window_overlap');
    if (currentStart > previousEnd) reasons.add('window_gap');
  }
  if (
    eligibleDaily.length > 0
    && Date.parse(eligibleDaily[0].payload.windowStart) > countFrom
  ) reasons.add('window_gap');
  if (eligibleDaily.length !== 28) {
    reasons.add(latestReset ? 'post_reset_window_incomplete' : 'window_count_invalid');
  }
  result.countedWindowCount = eligibleDaily.length;
  result.countedDurationHours = eligibleDaily.length * 24;

  const expectedWeeklyStarts = Array.from(
    { length: 4 },
    (_, index) => countFrom + index * 7 * DAY_MS,
  );
  for (const expectedStart of expectedWeeklyStarts) {
    const matching = weekly.filter((item) => (
      Date.parse(item.payload.windowStart) === expectedStart
      && Date.parse(item.payload.windowEnd) === expectedStart + 7 * DAY_MS
    ));
    if (matching.length === 0) reasons.add('weekly_review_missing');
    if (matching.length > 1) reasons.add('weekly_review_duplicate');
  }
  if (manifest.windowEndMs > nowMs) reasons.add('window_not_elapsed');

  let productionAuthority = {
    valid: false,
    reasonCode: null,
    keyId: null,
    expiresAt: null,
  };
  if (
    manifest.authorityMode === 'external_signed_release'
    || manifest.productionAuthorityEnvelope !== null
  ) {
    productionAuthority = {
      ...productionAuthority,
      ...verifyPrivateBetaProductionAuthority({
        envelope: manifest.productionAuthorityEnvelope,
        manifest,
        receiptChainRoot: receipts.at(-1)?.receiptDigest || ZERO_DIGEST,
        candidates,
        reset: result.reset,
        countedWindowCount: result.countedWindowCount,
        countedDurationHours: result.countedDurationHours,
        nowMs,
      }),
    };
    if (!productionAuthority.valid) reasons.add(productionAuthority.reasonCode);
  }

  result.reasonCodes = [...reasons].sort();
  result.privateBetaReady = result.reasonCodes.length === 0;
  result.productionAuthority = productionAuthority;
  result.actualClockStarted = result.privateBetaReady && productionAuthority.valid;
  result.publicationEligible = result.privateBetaReady && productionAuthority.valid;
  result.signupOpen = result.privateBetaReady;
  result.updateOffersOpen = result.privateBetaReady;
  return result;
}

module.exports = {
  collectPrivateBetaReceipt,
  digestPrivateBetaValue: digest,
  evaluatePrivateBetaEvidence,
  writePrivateBetaManifest,
};
