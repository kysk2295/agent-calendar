# Plan: Desktop Keychain runtime instrumentation remediation

- Date: 2026-07-26
- Owner: Codex
- Work size: Boundary
- Status: Verified

## Goal

Prove on a current-source, ordinary Electron launch that the app itself makes no native
Keychain calls before encrypted data exists, then uses native storage to save and restore
both the session and Workspace snapshot.

## Non-Goals

- Replacing production `safeStorage`, changing normal authentication, or exposing plaintext
  tokens in a diagnostic receipt.
- Enabling the QA AES backend in this scenario.

## Touched Boundaries

- Electron secure-storage adapter and its test-only receipt.
- Main-process diagnostic bridge, secure session, and Workspace snapshot persistence.
- Current-source Electron smoke and focused desktop tests.

## Success Criteria

- [x] An explicit diagnostic-only launch reports zero app-owned availability, encryption,
  and decryption calls before any encrypted file exists.
- [x] The same native-backed app saves an encrypted fixture session and Workspace snapshot,
  then restores both after an ordinary relaunch.
- [x] The receipt contains operation counts only; it contains no encrypted data or tokens.
- [x] Focused regression tests, desktop typecheck/build, and three no-flag source runs pass.

## Edge Cases

- Missing encrypted files must not be mistaken for native availability calls.
- The diagnostic flag must not select the QA AES backend.
- Snapshot restoration must use the renderer's production IPC read channel.

## Test Plan

- PIN: retain native selection for a no-QA environment.
- RED: require operation-level counts in the storage receipt and a current-source bridge
  visible only under the diagnostic flag.
- GREEN: instrument the existing native wrapper and expose a narrowly gated, secretless
  action surface for the current-source smoke.

## Acceptance Gates

- [x] Focused receipt, session, snapshot, and live-path tests.
- [x] `npm run typecheck`
- [x] `npm run build:desktop`
- [x] Three ordinary source Electron save/relaunch restores with cleanup receipts.

## Implementation Checklist

- [x] Read the independent verifier's failed criteria and locate the existing source smoke.
- [x] Add operation-level native-storage receipt counts with a failing-first test.
- [x] Add the diagnostic-only app-owned save surface and update the smoke.
- [x] Run focused and live verification; capture artifacts and cleanup receipt.

## Remaining Risks

- The live diagnostic is intentionally opt-in through a process environment flag; it must
  never be available during ordinary production launches.
