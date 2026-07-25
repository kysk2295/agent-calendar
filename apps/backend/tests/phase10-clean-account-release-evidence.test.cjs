'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createCleanAccountEteEvidence,
} = require('../app/lib/clean-account-ete-release-evidence');

const COMMIT = 'c'.repeat(40);
const CAPTURED_AT = '2026-07-25T12:00:00.000Z';

function validBinding() {
  return {
    deploymentId: 'local-candidate-codex',
    commit: COMMIT,
    environmentId: 'local-ephemeral',
    serviceId: 'local-gateway',
  };
}

function validReport() {
  return {
    ok: true,
    mode: 'single-account',
    selectedEngine: 'codex',
    backendRestart: true,
    desktopRestart: true,
    runnerEnrolled: true,
    engineAuthenticated: true,
    delegatedWorkCompleted: true,
    realtimeCheckpointObserved: true,
    calendarResultVisible: true,
    runnerReconnected: true,
    sessionRestoredWithoutLogin: true,
    completeCount: 1,
    completedAttempts: 1,
    failedAttempts: 0,
    calendarEvents: 1,
    screenshotHashes: {
      queued: '1'.repeat(64),
      live: '2'.repeat(64),
      completed: '3'.repeat(64),
      calendar: '4'.repeat(64),
      rehydrated: '5'.repeat(64),
    },
  };
}

test('live clean-account report becomes bounded candidate-bound release evidence', () => {
  const report = validReport();
  report.workspaceId = 'workspace-must-not-leak';
  report.hostPath = '/Users/private';
  const evidence = createCleanAccountEteEvidence({
    report,
    binding: validBinding(),
    capturedAt: CAPTURED_AT,
  });

  assert.deepEqual(evidence, {
    schemaVersion: 1,
    kind: 'clean_account_ete',
    capturedAt: CAPTURED_AT,
    binding: validBinding(),
    checks: {
      workspaceLogin: true,
      runnerEnrollment: true,
      engineAuthentication: true,
      delegatedWork: true,
      realtimeCheckpoints: true,
      calendarResult: true,
      reconnectRecovery: true,
    },
  });
  assert.doesNotMatch(JSON.stringify(evidence), /workspace-must-not-leak|\/Users\/private/);
});

test('Fake Engine and terminal failure reports cannot become release success evidence', () => {
  const fake = validReport();
  fake.selectedEngine = 'fake';
  assert.throws(
    () => createCleanAccountEteEvidence({
      report: fake,
      binding: validBinding(),
      capturedAt: CAPTURED_AT,
    }),
    /live execution engine/i,
  );

  const failed = validReport();
  failed.ok = false;
  failed.completedAttempts = 0;
  failed.failedAttempts = 1;
  failed.calendarEvents = 0;
  assert.throws(
    () => createCleanAccountEteEvidence({
      report: failed,
      binding: validBinding(),
      capturedAt: CAPTURED_AT,
    }),
    /successful single-account/i,
  );
});

test('incomplete journey, login replay, and duplicate screenshots fail closed', () => {
  for (const mutate of [
    (report) => { report.realtimeCheckpointObserved = false; },
    (report) => { report.runnerReconnected = false; },
    (report) => { report.calendarEvents = 0; },
    (report) => { report.completeCount = 2; },
    (report) => { report.screenshotHashes.rehydrated = report.screenshotHashes.completed; },
    (report) => { report.screenshotHashes.live = 'not-a-sha'; },
  ]) {
    const report = validReport();
    mutate(report);
    assert.throws(
      () => createCleanAccountEteEvidence({
        report,
        binding: validBinding(),
        capturedAt: CAPTURED_AT,
      }),
      /clean-account ETE|screenshot/i,
    );
  }
});

test('release binding and capture timestamp require exact reproducible values', () => {
  const binding = validBinding();
  binding.commit = COMMIT.slice(0, 12);
  assert.throws(
    () => createCleanAccountEteEvidence({
      report: validReport(),
      binding,
      capturedAt: CAPTURED_AT,
    }),
    /binding/i,
  );
  assert.throws(
    () => createCleanAccountEteEvidence({
      report: validReport(),
      binding: validBinding(),
      capturedAt: 'now',
    }),
    /timestamp/i,
  );
});
