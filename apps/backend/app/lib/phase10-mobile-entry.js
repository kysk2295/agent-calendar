'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EVALUATOR_SCHEMA = 'phase10-mobile-entry/v1';
const AUTHORITY_SCHEMA = 'phase10-mobile-entry-authority/v1';
const PRODUCTION_AUTHORITY_KEY_ID = 'phase10-mobile-entry-production-2026-01';
const PRODUCTION_AUTHORITY_PUBLIC_KEY_PEM = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEAXeNdpDkctCNZKY6TMvybIth1OTU9ItFVe/ayPwtqOLw=',
  '-----END PUBLIC KEY-----',
  '',
].join('\n');
const CRITERION_IDS = Object.freeze([
  'signed_candidates',
  'private_beta',
  'workos_readiness',
  'hostile_isolation',
  'telegram_continuity',
  'web_handoff',
  'observability_slo',
  'managed_dr_rollback',
  'legacy_lifecycle',
]);
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function manifestContractDigest(manifest) {
  const bounded = { ...manifest };
  delete bounded.productionAuthorityEnvelope;
  return sha256(canonicalJson(bounded));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactIso(value) {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : null;
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function validIds(value, expectedCount) {
  return Array.isArray(value)
    && value.length === expectedCount
    && new Set(value).size === value.length
    && value.every((item) => SAFE_ID.test(String(item || '')));
}

function validDeploymentIds(value) {
  return isRecord(value)
    && SAFE_ID.test(String(value.staging || ''))
    && SAFE_ID.test(String(value.production || ''));
}

function validateCriterionDetails(criterionId, evidence, manifest) {
  const detail = isRecord(evidence.details) ? evidence.details : {};
  const fail = (name) => `criterion_invalid:${criterionId}:${name}`;
  if (criterionId === 'signed_candidates') {
    if (detail.actual !== true) return fail('actual_candidates');
    if (!sameJson(detail.desktop, manifest.candidateIds.desktop)
      || !sameJson(detail.runner, manifest.candidateIds.runner)) return fail('candidate_ids');
    if (!Array.isArray(detail.signedArtifactDigests)
      || detail.signedArtifactDigests.length !== 4
      || detail.signedArtifactDigests.some((value) => !SHA256.test(String(value)))) {
      return fail('signed_artifacts');
    }
  } else if (criterionId === 'private_beta') {
    if (detail.consecutiveDays !== 28) return fail('window');
    if (detail.externallyAuthorizedClock !== true) return fail('external_clock');
    if (detail.chainRoot !== manifest.privateBeta.chainRoot) return fail('chain_root');
    if (detail.resetState !== 'clean' || manifest.privateBeta.resetState !== 'clean') {
      return fail('reset_state');
    }
  } else if (criterionId === 'workos_readiness') {
    for (const field of ['liveWorkos', 'cleanAccount', 'stagingReady', 'productionReady', 'authenticatedReads']) {
      if (detail[field] !== true) return fail(field);
    }
  } else if (criterionId === 'hostile_isolation') {
    for (const field of ['workspace', 'runner', 'provider', 'hostileAttemptsRejected']) {
      if (detail[field] !== true) return fail(field);
    }
  } else if (criterionId === 'telegram_continuity') {
    for (const field of ['exclusiveOwnership', 'canonicalParity', 'restartSafe']) {
      if (detail[field] !== true) return fail(field);
    }
  } else if (criterionId === 'web_handoff') {
    for (const field of ['signed', 'support', 'signup', 'download']) {
      if (detail[field] !== true) return fail(field);
    }
    if (detail.exactSourceSha !== manifest.sourceSha) return fail('source_sha');
  } else if (criterionId === 'observability_slo') {
    for (const field of ['externalObservability', 'externalOnCall', 'sloApproved']) {
      if (detail[field] !== true) return fail(field);
    }
  } else if (criterionId === 'managed_dr_rollback') {
    for (const field of ['currentSchema', 'managedDr', 'managedPitr', 'gatewayRollback', 'runnerRollback']) {
      if (detail[field] !== true) return fail(field);
    }
  } else if (criterionId === 'legacy_lifecycle') {
    if (detail.eligible !== true) return fail('eligible');
    if (!Number.isInteger(detail.zeroTrafficDays) || detail.zeroTrafficDays < 28) {
      return fail('zero_traffic_window');
    }
    if (detail.decision !== manifest.legacyDecision) return fail('decision');
  }
  return null;
}

function canonicalEvidenceRoot(evidenceDir) {
  const requested = path.resolve(String(evidenceDir || ''));
  const requestedStats = fs.lstatSync(requested);
  if (!requestedStats.isDirectory() || requestedStats.isSymbolicLink()) {
    throw new Error('root_bounds');
  }
  const canonical = fs.realpathSync(requested);
  const canonicalStats = fs.lstatSync(canonical);
  if (
    !canonicalStats.isDirectory()
    || canonicalStats.isSymbolicLink()
    || requestedStats.dev !== canonicalStats.dev
    || requestedStats.ino !== canonicalStats.ino
  ) throw new Error('root_changed');
  return {
    requested,
    canonical,
    dev: canonicalStats.dev,
    ino: canonicalStats.ino,
    componentIdentities: new Map(),
    fileIdentities: new Map(),
  };
}

function assertEvidenceRootUnchanged(root) {
  let stats;
  let canonical;
  try {
    stats = fs.lstatSync(root.requested);
    canonical = fs.realpathSync(root.requested);
  } catch {
    throw new Error('evidence_root_changed');
  }
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || stats.dev !== root.dev
    || stats.ino !== root.ino
    || canonical !== root.canonical
  ) throw new Error('evidence_root_changed');
}

function assertOrPinComponent(root, componentPath, stats) {
  const relative = path.relative(root.requested, componentPath);
  const pinned = root.componentIdentities.get(relative);
  if (!pinned) {
    root.componentIdentities.set(relative, { dev: stats.dev, ino: stats.ino });
  } else if (pinned.dev !== stats.dev || pinned.ino !== stats.ino) {
    throw new Error('evidence_path_race');
  }
}

function revalidateComponents(root, segments) {
  let current = root.requested;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = path.join(current, segments[index]);
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch {
      throw new Error('evidence_path_race');
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('evidence_path_race');
    }
    assertOrPinComponent(root, current, stats);
  }
}

function revalidatePinnedFiles(root) {
  for (const [relative, pinned] of root.fileIdentities) {
    const filePath = path.join(root.requested, relative);
    let stats;
    try {
      stats = fs.lstatSync(filePath);
    } catch {
      throw new Error(`evidence_path_race:${pinned.label}`);
    }
    if (
      !stats.isFile()
      || stats.isSymbolicLink()
      || stats.dev !== pinned.dev
      || stats.ino !== pinned.ino
      || stats.size !== pinned.size
    ) throw new Error(`evidence_path_race:${pinned.label}`);
  }
}

function readBoundedJson(root, relativePath, raceLabel) {
  assertEvidenceRootUnchanged(root);
  revalidatePinnedFiles(root);
  const relative = String(relativePath || '').replaceAll('\\', '/');
  const normalized = path.posix.normalize(relative);
  if (!relative || normalized === '.' || normalized.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error('path_bounds');
  }
  const segments = normalized.split('/');
  let current = root.requested;
  let terminalStats;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink()) throw new Error('path_symlink');
    if (index < segments.length - 1 && !stats.isDirectory()) throw new Error('path_component');
    if (index < segments.length - 1) assertOrPinComponent(root, current, stats);
    if (index === segments.length - 1) terminalStats = stats;
  }
  if (
    !terminalStats
    || !terminalStats.isFile()
    || terminalStats.size < 2
    || terminalStats.size > MAX_FILE_BYTES
  ) throw new Error('file_bounds');
  const pinnedFile = root.fileIdentities.get(normalized);
  if (pinnedFile && (
    pinnedFile.dev !== terminalStats.dev
    || pinnedFile.ino !== terminalStats.ino
    || pinnedFile.size !== terminalStats.size
  )) throw new Error(`evidence_path_race:${pinnedFile.label}`);
  root.fileIdentities.set(normalized, {
    dev: terminalStats.dev,
    ino: terminalStats.ino,
    size: terminalStats.size,
    label: raceLabel,
  });
  const canonicalPath = fs.realpathSync(current);
  if (!canonicalPath.startsWith(`${root.canonical}${path.sep}`)) throw new Error('path_escape');
  const descriptor = fs.openSync(
    canonicalPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const openStats = fs.fstatSync(descriptor);
    if (
      !openStats.isFile()
      || openStats.dev !== terminalStats.dev
      || openStats.ino !== terminalStats.ino
      || openStats.size !== terminalStats.size
      || openStats.size < 2
      || openStats.size > MAX_FILE_BYTES
    ) throw new Error(`evidence_path_race:${raceLabel}`);
    const raw = fs.readFileSync(descriptor);
    const afterPath = fs.realpathSync(current);
    const afterStats = fs.lstatSync(current);
    if (
      afterPath !== canonicalPath
      || afterStats.isSymbolicLink()
      || afterStats.dev !== openStats.dev
      || afterStats.ino !== openStats.ino
      || afterStats.size !== openStats.size
    ) throw new Error(`evidence_path_race:${raceLabel}`);
    revalidateComponents(root, segments);
    assertEvidenceRootUnchanged(root);
    revalidatePinnedFiles(root);
    return { raw, value: JSON.parse(raw.toString('utf8')) };
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateManifest(manifest, nowMs, reasons) {
  if (!isRecord(manifest)
    || manifest.schemaVersion !== 1
    || manifest.evaluatorSchema !== EVALUATOR_SCHEMA
    || manifest.kind !== 'phase10_mobile_entry_manifest'
    || manifest.authorityMode !== 'repository_contract') {
    reasons.push('manifest_schema_invalid');
    return false;
  }
  if (!SOURCE_SHA.test(String(manifest.sourceSha || ''))) reasons.push('manifest_source_invalid');
  if (!validDeploymentIds(manifest.deploymentIds)) reasons.push('manifest_deployment_invalid');
  if (!isRecord(manifest.candidateIds)
    || !validIds(manifest.candidateIds.desktop, 2)
    || !validIds(manifest.candidateIds.runner, 2)) reasons.push('manifest_candidates_invalid');
  if (manifest.environment !== 'phase10-production') reasons.push('manifest_environment_invalid');
  const generatedAt = exactIso(manifest.generatedAt);
  const expiresAt = exactIso(manifest.expiresAt);
  if (generatedAt === null || expiresAt === null) reasons.push('manifest_timestamp_invalid');
  else if (generatedAt > nowMs || nowMs - generatedAt > MAX_EVIDENCE_AGE_MS || expiresAt <= nowMs) {
    reasons.push('manifest_stale');
  }
  if (!isRecord(manifest.privateBeta)
    || !SHA256.test(String(manifest.privateBeta.chainRoot || ''))
    || !['clean', 'reset'].includes(manifest.privateBeta.resetState)) {
    reasons.push('manifest_private_beta_invalid');
  }
  if (manifest.legacyDecision !== 'remove_eligible_routes') reasons.push('legacy_decision_ineligible');
  if (!Array.isArray(manifest.criteria)) reasons.push('manifest_criteria_invalid');
  return reasons.length === 0;
}

function evaluateAuthorityEnvelope({ manifest, criterionBindings, nowMs, reasons }) {
  const envelope = manifest.productionAuthorityEnvelope;
  if (!isRecord(envelope)) {
    reasons.push('production_authority_envelope_missing');
    return false;
  }
  const payload = envelope.payload;
  if (!isRecord(payload)
    || payload.schemaVersion !== 1
    || payload.evaluatorSchema !== AUTHORITY_SCHEMA
    || envelope.publicKeyId !== PRODUCTION_AUTHORITY_KEY_ID) {
    reasons.push('production_authority_envelope_schema');
    return false;
  }
  const evaluationMs = exactIso(payload.evaluationTimestamp);
  const expiryMs = exactIso(payload.expiresAt);
  if (evaluationMs === null || expiryMs === null || evaluationMs > nowMs || expiryMs <= nowMs) {
    reasons.push('production_authority_envelope_expired');
    return false;
  }
  const expected = {
    manifestDigest: manifestContractDigest(manifest),
    criterionBindings,
    sourceSha: manifest.sourceSha,
    deploymentIds: manifest.deploymentIds,
    candidateIds: manifest.candidateIds,
    privateBeta: manifest.privateBeta,
    legacyDecision: manifest.legacyDecision,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (!sameJson(payload[field], value)) {
      reasons.push(`production_authority_envelope_binding:${field}`);
      return false;
    }
  }
  let signature;
  try {
    signature = Buffer.from(String(envelope.signature || ''), 'base64');
  } catch {
    signature = Buffer.alloc(0);
  }
  if (signature.length !== 64 || !crypto.verify(
    null,
    Buffer.from(canonicalJson(payload)),
    PRODUCTION_AUTHORITY_PUBLIC_KEY_PEM,
    signature,
  )) {
    reasons.push('production_authority_envelope_signature');
    return false;
  }
  return true;
}

function evaluateMobileEntryEvidence({
  evidenceDir,
  now = new Date().toISOString(),
} = {}) {
  const reasons = [];
  let root;
  const nowMs = exactIso(now);
  if (nowMs === null) {
    return {
      schemaVersion: 1,
      evaluatorSchema: EVALUATOR_SCHEMA,
      contractComplete: false,
      productionAuthorityValid: false,
      mobileEntryReady: false,
      platformDecisionEligible: false,
      criterionCount: 0,
      reasonCodes: ['evaluation_time_invalid'],
    };
  }
  let manifest;
  try {
    root = canonicalEvidenceRoot(evidenceDir);
    manifest = readBoundedJson(root, 'manifest.json', 'manifest').value;
  } catch (error) {
    if (error?.message === 'evidence_root_changed') reasons.push('evidence_root_changed');
    else if (error?.message === 'evidence_path_race') reasons.push('evidence_path_race:manifest');
    else if (String(error?.message || '').startsWith('evidence_path_race:')) {
      reasons.push(error.message);
    }
    else reasons.push('manifest_unreadable');
  }
  if (!manifest) {
    return {
      schemaVersion: 1,
      evaluatorSchema: EVALUATOR_SCHEMA,
      contractComplete: false,
      productionAuthorityValid: false,
      mobileEntryReady: false,
      platformDecisionEligible: false,
      criterionCount: 0,
      reasonCodes: reasons,
    };
  }
  const manifestValid = validateManifest(manifest, nowMs, reasons);
  const entries = Array.isArray(manifest.criteria) ? manifest.criteria : [];
  let criterionStructureValid = true;
  if (!sameJson(entries.map((entry) => entry?.criterionId), CRITERION_IDS)) {
    reasons.push('criterion_order_invalid');
    criterionStructureValid = false;
  }
  const byId = new Map();
  for (const entry of entries) {
    const criterionId = String(entry?.criterionId || '');
    if (!CRITERION_IDS.includes(criterionId)) {
      reasons.push('criterion_unknown');
      criterionStructureValid = false;
    } else if (byId.has(criterionId)) {
      reasons.push(`criterion_duplicate:${criterionId}`);
      criterionStructureValid = false;
    } else {
      byId.set(criterionId, entry);
    }
  }
  const criterionResults = [];
  const authorityBindings = [];
  for (const criterionId of CRITERION_IDS) {
    const entry = byId.get(criterionId);
    if (!entry) {
      reasons.push(`criterion_missing:${criterionId}`);
      criterionResults.push({ criterionId, valid: false, authorityMode: 'missing' });
      continue;
    }
    const relative = String(entry.path || '');
    const normalized = path.posix.normalize(relative.replaceAll('\\', '/'));
    if (!relative || normalized.startsWith('../') || path.isAbsolute(relative)) {
      reasons.push(`criterion_path_invalid:${criterionId}`);
      criterionResults.push({ criterionId, valid: false, authorityMode: 'invalid' });
      continue;
    }
    let raw;
    let evidence;
    try {
      const read = readBoundedJson(root, normalized, criterionId);
      raw = read.raw;
      evidence = read.value;
    } catch (error) {
      if (error?.message === 'evidence_root_changed') reasons.push('evidence_root_changed');
      else if (error?.message === 'evidence_path_race') {
        reasons.push(`evidence_path_race:${criterionId}`);
      }
      else if (String(error?.message || '').startsWith('evidence_path_race:')) {
        reasons.push(error.message);
      } else reasons.push(`criterion_unreadable:${criterionId}`);
      criterionResults.push({ criterionId, valid: false, authorityMode: 'invalid' });
      continue;
    }
    let valid = true;
    const evidenceDigest = sha256(raw);
    if (!SHA256.test(String(entry.sha256 || '')) || entry.sha256 !== evidenceDigest) {
      reasons.push(`criterion_digest_mismatch:${criterionId}`);
      valid = false;
    }
    if (!isRecord(evidence)
      || evidence.schemaVersion !== 1
      || evidence.evaluatorSchema !== EVALUATOR_SCHEMA
      || evidence.kind !== 'phase10_mobile_entry_criterion'
      || evidence.criterionId !== criterionId
      || evidence.passed !== true) {
      reasons.push(`criterion_schema_invalid:${criterionId}`);
      valid = false;
    }
    if (evidence.sourceSha !== manifest.sourceSha) {
      reasons.push(`criterion_source_mismatch:${criterionId}`);
      valid = false;
    }
    if (!sameJson(evidence.deploymentIds, manifest.deploymentIds)) {
      reasons.push(`criterion_deployment_mismatch:${criterionId}`);
      valid = false;
    }
    if (!sameJson(evidence.candidateIds, manifest.candidateIds)) {
      reasons.push(`criterion_candidate_mismatch:${criterionId}`);
      valid = false;
    }
    if (evidence.environment !== manifest.environment) {
      reasons.push(`criterion_environment_mismatch:${criterionId}`);
      valid = false;
    }
    if (!SHA256.test(String(evidence.artifactDigest || ''))) {
      reasons.push(`criterion_artifact_invalid:${criterionId}`);
      valid = false;
    } else if (evidence.artifactDigest !== entry.artifactDigest) {
      reasons.push(`criterion_artifact_mismatch:${criterionId}`);
      valid = false;
    }
    if (!SHA256.test(String(evidence.authorityReceiptDigest || ''))
      || evidence.authorityReceiptDigest !== entry.authorityReceiptDigest) {
      reasons.push(`criterion_authority_receipt_mismatch:${criterionId}`);
      valid = false;
    }
    const observedAt = exactIso(evidence.observedAt);
    const expiresAt = exactIso(evidence.expiresAt);
    if (observedAt === null || expiresAt === null) {
      reasons.push(`criterion_timestamp_invalid:${criterionId}`);
      valid = false;
    } else if (
      observedAt > nowMs
      || nowMs - observedAt > MAX_EVIDENCE_AGE_MS
      || expiresAt <= nowMs
    ) {
      reasons.push(`criterion_stale:${criterionId}`);
      valid = false;
    }
    const detailReason = validateCriterionDetails(criterionId, evidence, manifest);
    if (detailReason) {
      reasons.push(detailReason);
      valid = false;
    }
    if (evidence.authorityMode !== 'external_authorized') {
      reasons.push(`production_authority_required:${criterionId}`);
    }
    criterionResults.push({ criterionId, valid, authorityMode: evidence.authorityMode });
    authorityBindings.push({
      criterionId,
      evidenceDigest,
      authorityReceiptDigest: evidence.authorityReceiptDigest,
      artifactDigest: evidence.artifactDigest,
    });
  }
  let rootStable = true;
  try {
    assertEvidenceRootUnchanged(root);
    revalidatePinnedFiles(root);
  } catch (error) {
    reasons.push(String(error?.message || '').startsWith('evidence_path_race:')
      ? error.message
      : 'evidence_root_changed');
    rootStable = false;
  }
  let contractComplete = manifestValid
    && rootStable
    && criterionStructureValid
    && entries.length === CRITERION_IDS.length
    && criterionResults.length === CRITERION_IDS.length
    && criterionResults.every((entry) => entry.valid);
  const allExternallyAuthorized = criterionResults.length === CRITERION_IDS.length
    && criterionResults.every((entry) => entry.authorityMode === 'external_authorized');
  let productionAuthorityValid = contractComplete
    && allExternallyAuthorized
    && evaluateAuthorityEnvelope({
      manifest,
      criterionBindings: authorityBindings,
      nowMs,
      reasons,
    });
  try {
    assertEvidenceRootUnchanged(root);
    revalidatePinnedFiles(root);
  } catch (error) {
    reasons.push(String(error?.message || '').startsWith('evidence_path_race:')
      ? error.message
      : 'evidence_root_changed');
    contractComplete = false;
    productionAuthorityValid = false;
  }
  if (!manifest.productionAuthorityEnvelope && reasons.includes('production_authority_envelope_missing') === false) {
    reasons.push('production_authority_envelope_missing');
  }
  const mobileEntryReady = productionAuthorityValid;
  return {
    schemaVersion: 1,
    evaluatorSchema: EVALUATOR_SCHEMA,
    contractComplete,
    productionAuthorityValid,
    mobileEntryReady,
    platformDecisionEligible: mobileEntryReady,
    criterionCount: criterionResults.filter((entry) => entry.valid).length,
    manifestDigest: manifestContractDigest(manifest),
    criterionResults,
    reasonCodes: [...new Set(reasons)],
  };
}

module.exports = {
  AUTHORITY_SCHEMA,
  CRITERION_IDS,
  EVALUATOR_SCHEMA,
  PRODUCTION_AUTHORITY_KEY_ID,
  PRODUCTION_AUTHORITY_PUBLIC_KEY_PEM,
  canonicalJson,
  evaluateMobileEntryEvidence,
  manifestContractDigest,
  sha256,
};
