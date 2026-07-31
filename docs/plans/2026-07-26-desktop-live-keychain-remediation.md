# Plan: Desktop live Keychain remediation

- Date: 2026-07-26
- Owner: Codex
- Work size: Boundary
- Status: Verified

## Goal

Prevent ordinary desktop startup from accessing macOS Keychain when no encrypted session or
Workspace snapshot exists, while retaining Electron `safeStorage` for every persisted secret.

## Non-Goals

- Replacing production `safeStorage`, weakening encrypted persistence, or exporting Keychain data.
- Changing a real stored-session restore to a non-native backend.
- Modifying user Keychain entries, macOS security settings, or unrelated desktop behavior.

## Touched Boundaries

- Electron session and Workspace snapshot persistence.
- Desktop unit and ordinary Electron launch tests.
- This plan and live-path evidence.

## Success Criteria

- [x] A missing encrypted file returns signed-out/null without invoking the native storage adapter.
- [x] Existing encrypted session data still invokes native storage and restores correctly.
- [x] Ordinary no-flag source Electron launch and relaunch boot without a Keychain error/prompt or renderer failure.
- [x] Native storage remains the production/no-flag backend and no plaintext session is written.

## Edge Cases

- Missing session but stale public profile clears safely.
- Missing snapshot does not require Keychain; stale/corrupt existing ciphertext still fails closed.
- Existing encrypted session must not be skipped merely to avoid Keychain access.

## Test Plan

- PIN:
  - [x] Missing session and snapshot return null on the existing behavior.
- RED:
  - [x] A storage spy proves the missing-file path currently invokes the native-storage seam.
- GREEN:
  - [x] File-existence-first checks preserve reads of existing encrypted data and eliminate empty-store adapter calls.

## Acceptance Gates

- [x] Focused session/snapshot live-path regression tests.
- [x] `npm run typecheck`
- [x] `npm run build:electron`
- [x] Ordinary no-flag source Electron launch/relaunch surface evidence.

## Implementation Checklist

- [x] Locate ordinary launch storage accesses and write the plan.
- [x] Pin normal missing-file behavior and run the RED seam test.
- [x] Implement the smallest file-existence-first change.
- [x] Verify native encrypted restore and ordinary live launch/relaunch; record cleanup.

## Remaining Risks

- A stored encrypted session necessarily asks Electron to use Keychain; an OS-owned prompt cannot be suppressed safely.
- If a macOS-owned Keychain prompt appears during manual QA, do not approve or reject it; record it as the blocker.
