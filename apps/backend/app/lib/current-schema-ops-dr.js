'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  extractCurrentTableNamesFromMigrations,
} = require('./phase10-disaster-recovery');
const {
  runWithCleanup,
} = require('./local-postgres-lifecycle');

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const REQUIRED_PROBES = Object.freeze([
  'web_availability',
  'web_download',
  'runner_heartbeat',
  'runner_update_failure',
]);
const REQUIRED_ALERT_RECEIPTS = Object.freeze([
  'raised',
  'local_owner_delivered',
  'acknowledged',
  'resolved',
]);
const CRITICAL_DOMAINS = Object.freeze([
  'calendar',
  'delegatedWork',
  'automation',
  'runner',
]);
const DEFAULT_MAX_AGE_MS = 15 * 60 * 1_000;
const MAX_RECEIPT_SPAN_MS = 10 * 60 * 1_000;
const MAX_EVIDENCE_BYTES = 128 * 1_024;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isoTimestamp(value, field) {
  const text = String(value || '');
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== text) {
    throw new Error(`${field} is invalid`);
  }
  return { text, timestamp };
}

function repositorySourceSha(repositoryRoot) {
  const value = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
  }).trim().toLowerCase();
  if (!SOURCE_SHA.test(value)) throw new Error('repository source SHA is invalid');
  return value;
}

function discoverRepositoryOpsDrContract({
  repositoryRoot,
  generatedAt = new Date().toISOString(),
  fsModule = fs,
} = {}) {
  const root = path.resolve(String(repositoryRoot || ''));
  const migrationsDir = path.join(root, 'apps/backend/app/db/migrations');
  const timestamp = isoTimestamp(generatedAt, 'generatedAt').text;
  const migrationNames = fsModule.readdirSync(migrationsDir)
    .filter((name) => MIGRATION_NAME.test(name))
    .sort();
  if (migrationNames.length === 0) throw new Error('repository has no migrations');
  const migrations = migrationNames.map((name) => ({
    name,
    sha256: sha256(fsModule.readFileSync(path.join(migrationsDir, name))),
  }));
  const tables = extractCurrentTableNamesFromMigrations(migrationsDir, fsModule);
  if (tables.length === 0) throw new Error('repository has no persisted tables');
  return {
    schemaVersion: 1,
    sourceSha: repositorySourceSha(root),
    generatedAt: timestamp,
    latestMigration: migrationNames.at(-1),
    migrations,
    migrationInventorySha256: sha256(JSON.stringify(migrations)),
    tables,
    tableInventorySha256: sha256(JSON.stringify(tables)),
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function receiptTimes(receipts, failures, prefix, generatedAtMs) {
  const times = [];
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      failures.push(`${prefix}_malformed`);
      continue;
    }
    try {
      const observedAt = isoTimestamp(receipt.observedAt, `${prefix}.observedAt`).timestamp;
      if (
        observedAt < generatedAtMs
        || observedAt - generatedAtMs > MAX_RECEIPT_SPAN_MS
      ) {
        failures.push(`${prefix}_stale:${String(receipt.kind || 'unknown')}`);
      }
      times.push(observedAt);
    } catch {
      failures.push(`${prefix}_malformed:${String(receipt.kind || 'unknown')}`);
    }
  }
  return times;
}

function uniqueByKind(receipts, required, failures, prefix) {
  const byKind = new Map();
  for (const receipt of receipts) {
    const kind = String(receipt?.kind || '');
    if (!required.includes(kind)) continue;
    if (byKind.has(kind)) failures.push(`${prefix}_duplicate:${kind}`);
    byKind.set(kind, receipt);
  }
  for (const kind of required) {
    if (!byKind.has(kind)) failures.push(`${prefix}_missing:${kind}`);
  }
  return byKind;
}

function evaluateRepositoryOpsDrEvidence({
  expected,
  evidence,
  now = new Date().toISOString(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  const failures = [];
  if (!expected || typeof expected !== 'object' || !evidence || typeof evidence !== 'object') {
    return { ok: false, failures: ['evidence_malformed'] };
  }
  let serialized = '';
  try {
    serialized = JSON.stringify(evidence);
  } catch {
    return { ok: false, failures: ['evidence_malformed'] };
  }
  if (Buffer.byteLength(serialized) > MAX_EVIDENCE_BYTES) {
    failures.push('evidence_oversized');
  }
  if (evidence.schemaVersion !== 1 || evidence.kind !== 'repository_current_schema_ops_dr') {
    failures.push('evidence_schema_invalid');
  }
  if (!SOURCE_SHA.test(String(evidence.sourceSha || ''))
    || evidence.sourceSha !== expected.sourceSha) {
    failures.push('source_sha_mismatch');
  }
  if (!sameJson(evidence.migrations, expected.migrations)) {
    failures.push('migration_inventory_mismatch');
  }
  if (!sameJson(evidence.tables, expected.tables)) {
    failures.push('table_inventory_mismatch');
  }

  let generatedAtMs = Number.NaN;
  let nowMs = Number.NaN;
  try {
    generatedAtMs = isoTimestamp(evidence.generatedAt, 'evidence.generatedAt').timestamp;
    nowMs = isoTimestamp(now, 'now').timestamp;
    const age = nowMs - generatedAtMs;
    if (age < 0 || age > Math.max(1, Number(maxAgeMs) || DEFAULT_MAX_AGE_MS)) {
      failures.push('evidence_stale');
    }
  } catch {
    failures.push('evidence_timestamp_invalid');
  }

  const probes = Array.isArray(evidence.probes) ? evidence.probes : [];
  if (!Array.isArray(evidence.probes)) failures.push('probes_malformed');
  const probeByKind = uniqueByKind(probes, REQUIRED_PROBES, failures, 'probe');
  receiptTimes(probes, failures, 'probe', generatedAtMs);
  for (const kind of REQUIRED_PROBES) {
    const receipt = probeByKind.get(kind);
    if (!receipt) continue;
    if (
      receipt.schemaVersion !== 1
      || receipt.durable !== true
      || receipt.ok !== true
      || !Number.isInteger(receipt.httpStatus)
      || receipt.httpStatus < 200
      || receipt.httpStatus > 299
    ) {
      failures.push(`probe_invalid:${kind}`);
    }
    if (kind === 'web_download'
      && (!Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1 || receipt.bytes > 10 * 1_024 * 1_024)) {
      failures.push('probe_invalid:web_download');
    }
    if (kind === 'runner_update_failure' && receipt.failureVisible !== true) {
      failures.push('probe_invalid:runner_update_failure');
    }
  }

  const lifecycle = Array.isArray(evidence.alertLifecycle) ? evidence.alertLifecycle : [];
  if (!Array.isArray(evidence.alertLifecycle)) failures.push('alert_lifecycle_malformed');
  const alertByKind = uniqueByKind(
    lifecycle,
    REQUIRED_ALERT_RECEIPTS,
    failures,
    'alert_receipt',
  );
  const alertTimes = receiptTimes(lifecycle, failures, 'alert_receipt', generatedAtMs);
  for (let index = 1; index < alertTimes.length; index += 1) {
    if (alertTimes[index] <= alertTimes[index - 1]) {
      failures.push('alert_receipts_out_of_order');
      break;
    }
  }
  for (const kind of REQUIRED_ALERT_RECEIPTS) {
    const receipt = alertByKind.get(kind);
    if (!receipt) continue;
    if (receipt.schemaVersion !== 1 || receipt.durable !== true) {
      failures.push(`alert_receipt_not_durable:${kind}`);
    }
    if (
      receipt.alertId !== 'synthetic-p1-local'
      || (kind === 'raised' && receipt.severity !== 'P1')
      || (
        kind === 'local_owner_delivered'
        && receipt.sink !== 'loopback_non_production'
      )
    ) {
      failures.push(`alert_receipt_invalid:${kind}`);
    }
  }

  const restore = evidence.restore;
  if (!restore || typeof restore !== 'object' || Array.isArray(restore)) {
    failures.push('restore_evidence_malformed');
  } else {
    if (restore.logical !== true) failures.push('logical_restore_not_proven');
    if (restore.pitr !== true) failures.push('pitr_restore_not_proven');
    const fingerprints = Array.isArray(restore.workspaceFingerprints)
      ? restore.workspaceFingerprints
      : [];
    if (
      fingerprints.length !== 2
      || new Set(fingerprints).size !== 2
      || fingerprints.some((value) => !SHA256.test(String(value)))
    ) {
      failures.push('workspace_isolation_not_proven');
    }
    for (const domain of CRITICAL_DOMAINS) {
      if (restore.criticalDomains?.[domain] !== true) {
        failures.push(`restored_domain_missing:${domain}`);
      }
    }
    if (
      restore.measurementScope !== 'local_only'
      || !Number.isFinite(restore.rpoMs)
      || restore.rpoMs < 0
      || !Number.isFinite(restore.rtoMs)
      || restore.rtoMs < 0
    ) {
      failures.push('local_rpo_rto_invalid');
    }
  }

  if (
    evidence.rollback?.gateway?.rollbackObserved !== true
    || evidence.rollback?.gateway?.readinessRestored !== true
  ) {
    failures.push('gateway_rollback_readiness_not_restored');
  }
  if (
    evidence.rollback?.runner?.rollbackObserved !== true
    || evidence.rollback?.runner?.knownGoodRestored !== true
    || evidence.rollback?.runner?.identityPreserved !== true
  ) {
    failures.push('runner_rollback_readiness_not_restored');
  }
  if (
    evidence.cleanup?.postmasterPidsGone !== true
    || evidence.cleanup?.portsRefused !== true
    || evidence.cleanup?.tempDirsRemoved !== true
    || evidence.cleanup?.serversStopped !== true
  ) {
    failures.push('cleanup_incomplete');
  }

  const uniqueFailures = [...new Set(failures)];
  return {
    ok: uniqueFailures.length === 0,
    failures: uniqueFailures,
    latestMigration: expected.latestMigration,
    sourceSha: expected.sourceSha,
  };
}

async function runRepositoryOpsDrScenario(body, cleanup) {
  if (typeof body !== 'function' || typeof cleanup !== 'function') {
    throw new TypeError('repository ops/DR scenario requires body and cleanup');
  }
  return runWithCleanup(body, cleanup);
}

module.exports = {
  CRITICAL_DOMAINS,
  REQUIRED_ALERT_RECEIPTS,
  REQUIRED_PROBES,
  discoverRepositoryOpsDrContract,
  evaluateRepositoryOpsDrEvidence,
  runRepositoryOpsDrScenario,
};
