# Plan: Desktop QA Keychain isolation

- Date: 2026-07-26
- Owner: Codex
- Work size: Boundary
- Status: Verified

## Goal

Allow explicitly configured desktop QA runs to persist encrypted session and Workspace
snapshot state without invoking macOS Keychain, while retaining Electron `safeStorage`
as the only production/default backend.

## Non-Goals

- Changing production secure-storage behavior or its persisted-file format.
- Adding a general development-only credential store.
- Modifying non-AuthKit desktop QA launchers.

## Touched Boundaries

- Electron bridge: `apps/desktop/electron/main.ts`, a test-only secure-storage selector.
- Tests: AuthKit and packaged deep-link smoke launch contracts plus focused unit tests.
- Docs: this plan and recorded evidence.

## Success Criteria

- [x] QA mode selects a non-Keychain AES-256-GCM backend only when E2E mode, explicit
  allowance, a valid ephemeral 32-byte key, and a PID-scoped QA user-data name all match.
- [x] Missing or malformed QA inputs fail closed; ordinary and production selection remains
  the Electron `safeStorage` adapter.
- [x] Session and Workspace snapshot files remain encrypted and restore on relaunch.
- [x] AuthKit and packaged deep-link QA no longer call native `safeStorage` directly.

## Edge Cases

- Malformed base64url/base64 key, incorrect decoded length, absent E2E flag, absent allow
  flag, or non-PID-scoped user-data name must not enable the QA backend.
- Ciphertext tampering and a different key must fail decryption without returning plaintext.
- The single QA backend instance must be shared by session and snapshot store composition.

## Test Plan

Product-code behavior is preceded by a RED source-composition regression, then focused
storage behavior tests.

- RED:
  - [x] Verify the old default store construction and direct AuthKit `safeStorage` probe are
    rejected by `keychain-qa-composition.test.mjs`.
- GREEN:
  - [x] Verify selection, fail-closed gates, native fallback identity, encryption/tamper
    handling, and a session/snapshot encrypted relaunch restore with the selected backend.
- REFACTOR:
  - [x] Keep gate parsing and cipher implementation isolated from production storage defaults.

## Acceptance Gates

- [x] Focused Node tests
- [x] `npm run typecheck`
- [x] Narrow AuthKit smoke (once)
- [ ] Packaged deep-link smoke (requires a newly built package containing this change)

Skipped gate:

- `npm test`
  - Reason: shared full suite is expressly out of scope for this focused QA fix.
- Packaged deep-link smoke
  - Reason: the locally available `.app` predates this main-process change; source launch
    configuration is covered by the focused test instead of claiming a stale-binary result.

## Implementation Checklist

- [x] Step 1: Locate all QA-time Keychain entry points and write the RED composition test.
- [x] Step 2: Add explicitly gated AES-GCM QA storage and inject it into both stores.
- [x] Step 3: Update QA launchers and receipt assertions without direct `safeStorage` calls.
- [x] Step 4: Run focused verification and capture a DoneClaim.

## Remaining Risks

- A fresh signed or unsigned macOS package still needs the packaged deep-link smoke run.
  - Mitigation: rebuild the package, then run `node apps/desktop/tests/packaged-deep-link-smoke.cjs`.
