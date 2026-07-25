'use strict';

const FULL_COMMIT_SHA = /^[a-f0-9]{40}$/;
const COMMIT_PREFIX = /^[a-f0-9]{12,40}$/;
const BOUNDED_IDENTIFIER = /^[A-Za-z0-9._:-]{1,160}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;

function normalizeBinding(binding = {}) {
  const deploymentId = String(binding.deploymentId || '').trim();
  const commit = String(binding.commit || '').trim().toLowerCase();
  const environmentId = String(binding.environmentId || '').trim();
  const serviceId = String(binding.serviceId || '').trim();
  if (
    !BOUNDED_IDENTIFIER.test(deploymentId)
    || !FULL_COMMIT_SHA.test(commit)
    || !BOUNDED_IDENTIFIER.test(environmentId)
    || !BOUNDED_IDENTIFIER.test(serviceId)
  ) {
    throw new Error('candidate readiness binding is invalid');
  }
  return { deploymentId, commit, environmentId, serviceId };
}

function normalizeBaseUrl(value, allowLoopbackHttp) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error('candidate readiness base URL is invalid');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(allowLoopbackHttp && parsed.protocol === 'http:' && loopback)) {
    throw new Error('candidate readiness base URL must use HTTPS');
  }
  if (
    parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    throw new Error('candidate readiness base URL is invalid');
  }
  return parsed.origin;
}

async function fetchProbe(origin, pathname, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${origin}${pathname}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('candidate readiness probe failed');
  }
  const contentLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error('candidate readiness probe failed');
  }
  let bodyText;
  try {
    bodyText = await response.text();
  } catch {
    throw new Error('candidate readiness probe failed');
  }
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('candidate readiness probe failed');
  }
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error('candidate readiness probe failed');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('candidate readiness probe failed');
  }
  return { status: Number(response.status), body };
}

async function collectCandidateReadinessEvidence({
  baseUrl = '',
  binding = {},
  allowLoopbackHttp = false,
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
} = {}) {
  const normalizedBinding = normalizeBinding(binding);
  const origin = normalizeBaseUrl(baseUrl, allowLoopbackHttp);
  if (typeof fetchImpl !== 'function') {
    throw new Error('candidate readiness probe requires fetch');
  }
  let status;
  let health;
  let ready;
  try {
    [status, health, ready] = await Promise.all([
      fetchProbe(origin, '/api/gateway-status', fetchImpl),
      fetchProbe(origin, '/api/health', fetchImpl),
      fetchProbe(origin, '/api/ready', fetchImpl),
    ]);
  } catch {
    throw new Error('candidate readiness probe failed');
  }
  const buildCommitPrefix = String(status.body.buildCommit || '').trim().toLowerCase();
  const deploymentId = String(status.body.deploymentId || '').trim();
  if (
    status.status !== 200
    || !COMMIT_PREFIX.test(buildCommitPrefix)
    || !normalizedBinding.commit.startsWith(buildCommitPrefix)
    || deploymentId !== normalizedBinding.deploymentId
    || health.status !== 200
    || health.body.ok !== true
    || ready.status !== 200
    || ready.body.ok !== true
  ) {
    throw new Error('candidate readiness probe failed');
  }
  const captured = clock();
  if (!(captured instanceof Date) || !Number.isFinite(captured.getTime())) {
    throw new Error('candidate readiness capture time is invalid');
  }
  return {
    schemaVersion: 1,
    kind: 'gateway_readiness',
    capturedAt: captured.toISOString(),
    binding: normalizedBinding,
    probe: { path: '/api/ready', httpStatus: ready.status, ok: true },
    health: { path: '/api/health', httpStatus: health.status, ok: true },
    provenance: {
      path: '/api/gateway-status',
      httpStatus: status.status,
      deploymentId,
      buildCommitPrefix,
    },
  };
}

module.exports = {
  collectCandidateReadinessEvidence,
};
