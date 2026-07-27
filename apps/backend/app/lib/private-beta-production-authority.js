'use strict';

const crypto = require('node:crypto');

const PRODUCTION_AUTHORITY_KEY_ID = 'private-beta-production-2026-01';
const PRODUCTION_AUTHORITY_PUBLIC_KEY_PEM = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEAJrX9LYS8q2eWalAl+t0crhXUx5Fh52/7mqaNqwVB1j0=',
  '-----END PUBLIC KEY-----',
  '',
].join('\n');

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/;
const MAX_AUTHORITY_LIFETIME_MS = 60 * 60 * 1000;
const ENVELOPE_KEYS = [
  'schemaVersion',
  'algorithm',
  'keyId',
  'issuedAt',
  'expiresAt',
  'manifestDigest',
  'receiptChainRoot',
  'candidateBindingDigest',
  'cohortDigest',
  'operatorDigest',
  'windowStateDigest',
  'evaluatorSchema',
  'sourceId',
  'sourceSha',
  'signature',
];

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

function authorityFreeManifestDigest(manifest) {
  const projected = { ...manifest, productionAuthorityEnvelope: null };
  delete projected.windowStartMs;
  delete projected.windowEndMs;
  return digest(projected);
}

function candidateBindingDigest(candidates) {
  return digest(candidates
    .map((receipt) => ({
      receiptId: receipt.receiptId,
      receiptDigest: receipt.receiptDigest,
      candidateId: receipt.payload.candidateId,
      desktopReleaseId: receipt.payload.desktopReleaseId,
      runnerReleaseId: receipt.payload.runnerReleaseId,
      installedAt: receipt.payload.installedAt,
      desktopSignatureReceiptDigest: receipt.payload.desktopSignatureReceiptDigest,
      runnerSignatureReceiptDigest: receipt.payload.runnerSignatureReceiptDigest,
      desktopUpdateReceiptDigest: receipt.payload.desktopUpdateReceiptDigest,
      runnerUpdateReceiptDigest: receipt.payload.runnerUpdateReceiptDigest,
    }))
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId)));
}

function windowStateDigest({ manifest, reset, countedWindowCount, countedDurationHours }) {
  return digest({
    timezone: manifest.timezone,
    windowStart: manifest.windowStart,
    windowEnd: manifest.windowEnd,
    reset,
    countedWindowCount,
    countedDurationHours,
  });
}

function signedPayload(envelope) {
  return Object.fromEntries(
    Object.entries(envelope).filter(([key]) => key !== 'signature'),
  );
}

function verifyPrivateBetaProductionAuthority({
  envelope,
  manifest,
  receiptChainRoot,
  candidates,
  reset,
  countedWindowCount,
  countedDurationHours,
  nowMs,
}) {
  if (envelope === null || envelope === undefined) {
    return { valid: false, reasonCode: 'production_authority_missing' };
  }
  if (
    !exactKeys(envelope, ENVELOPE_KEYS)
    || envelope.schemaVersion !== 1
    || envelope.algorithm !== 'Ed25519'
    || envelope.keyId !== PRODUCTION_AUTHORITY_KEY_ID
    || !DIGEST_PATTERN.test(envelope.manifestDigest)
    || !DIGEST_PATTERN.test(envelope.receiptChainRoot)
    || !DIGEST_PATTERN.test(envelope.candidateBindingDigest)
    || !DIGEST_PATTERN.test(envelope.cohortDigest)
    || !DIGEST_PATTERN.test(envelope.operatorDigest)
    || !DIGEST_PATTERN.test(envelope.windowStateDigest)
    || envelope.evaluatorSchema !== manifest.evaluatorSchema
    || envelope.sourceId !== manifest.sourceId
    || envelope.sourceSha !== manifest.sourceSha
    || !BASE64_PATTERN.test(envelope.signature)
  ) {
    return { valid: false, reasonCode: 'production_authority_invalid' };
  }
  const issuedAt = canonicalTimestamp(envelope.issuedAt);
  const expiresAt = canonicalTimestamp(envelope.expiresAt);
  if (
    issuedAt === null
    || expiresAt === null
    || issuedAt > nowMs
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > MAX_AUTHORITY_LIFETIME_MS
  ) {
    return { valid: false, reasonCode: 'production_authority_invalid' };
  }
  if (expiresAt <= nowMs) {
    return { valid: false, reasonCode: 'production_authority_expired' };
  }

  const bindings = {
    manifestDigest: authorityFreeManifestDigest(manifest),
    receiptChainRoot,
    candidateBindingDigest: candidateBindingDigest(candidates),
    cohortDigest: manifest.cohortDigest,
    operatorDigest: manifest.operatorDigest,
    windowStateDigest: windowStateDigest({
      manifest,
      reset,
      countedWindowCount,
      countedDurationHours,
    }),
  };
  if (Object.entries(bindings).some(([key, value]) => envelope[key] !== value)) {
    return { valid: false, reasonCode: 'production_authority_binding_mismatch' };
  }

  const signature = Buffer.from(envelope.signature, 'base64');
  const canonicalSignature = signature.toString('base64');
  if (
    signature.length !== 64
    || canonicalSignature !== envelope.signature
    || !crypto.verify(
      null,
      Buffer.from(canonicalJson(signedPayload(envelope)), 'utf8'),
      PRODUCTION_AUTHORITY_PUBLIC_KEY_PEM,
      signature,
    )
  ) {
    return { valid: false, reasonCode: 'production_authority_signature_invalid' };
  }
  return {
    valid: true,
    reasonCode: null,
    keyId: PRODUCTION_AUTHORITY_KEY_ID,
    expiresAt: envelope.expiresAt,
  };
}

module.exports = {
  authorityFreeManifestDigest,
  candidateBindingDigest,
  privateBetaAuthorityWindowStateDigest: windowStateDigest,
  verifyPrivateBetaProductionAuthority,
};
