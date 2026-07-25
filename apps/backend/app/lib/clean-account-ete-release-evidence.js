'use strict';

const FULL_COMMIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BOUNDED_IDENTIFIER = /^[A-Za-z0-9._:-]{1,160}$/;
const LIVE_ENGINES = new Set(['codex', 'claude', 'grok', 'hermes']);
const SCREENSHOT_STATES = ['queued', 'live', 'completed', 'calendar', 'rehydrated'];

function exactIsoTime(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

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
    throw new Error('release evidence binding is invalid');
  }
  return { deploymentId, commit, environmentId, serviceId };
}

function assertScreenshotEvidence(report) {
  const hashes = report?.screenshotHashes;
  if (!hashes || typeof hashes !== 'object') {
    throw new Error('clean-account ETE screenshot evidence is missing');
  }
  const values = SCREENSHOT_STATES.map((state) => String(hashes[state] || '').toLowerCase());
  if (values.some((value) => !SHA256.test(value)) || new Set(values).size !== values.length) {
    throw new Error('clean-account ETE screenshot evidence is invalid');
  }
}

function createCleanAccountEteEvidence({
  report = {},
  binding = {},
  capturedAt = '',
} = {}) {
  if (report?.ok !== true || report?.mode !== 'single-account') {
    throw new Error('successful single-account ETE report is required');
  }
  if (!LIVE_ENGINES.has(String(report.selectedEngine || '').toLowerCase())) {
    throw new Error('a live execution engine is required for release evidence');
  }
  if (
    report.identityProvider !== 'workos_authkit'
    || report.identityProviderLive !== true
    || report.authAdapterInjected !== false
  ) {
    throw new Error('live WorkOS AuthKit identity evidence is required');
  }
  if (!exactIsoTime(capturedAt)) {
    throw new Error('release evidence timestamp is invalid');
  }
  const requiredTruth = [
    report.backendRestart,
    report.desktopRestart,
    report.runnerEnrolled,
    report.engineAuthenticated,
    report.delegatedWorkCompleted,
    report.realtimeCheckpointObserved,
    report.calendarResultVisible,
    report.runnerReconnected,
    report.sessionRestoredWithoutLogin,
  ];
  if (
    requiredTruth.some((value) => value !== true)
    || report.completeCount !== 1
    || report.completedAttempts !== 1
    || report.failedAttempts !== 0
    || report.calendarEvents !== 1
  ) {
    throw new Error('clean-account ETE report is incomplete');
  }
  assertScreenshotEvidence(report);
  return {
    schemaVersion: 2,
    kind: 'clean_account_ete',
    capturedAt,
    binding: normalizeBinding(binding),
    identity: {
      provider: 'workos_authkit',
      liveTenant: true,
      injectedAdapter: false,
    },
    checks: {
      workspaceLogin: true,
      runnerEnrollment: true,
      engineAuthentication: true,
      delegatedWork: true,
      realtimeCheckpoints: true,
      calendarResult: true,
      reconnectRecovery: true,
    },
  };
}

module.exports = {
  createCleanAccountEteEvidence,
};
