# Plan: Live Keychain receipt consistency

- Date: 2026-07-26
- Work size: Small
- Status: Verified

## Goal

Ensure a successful real-Electron Keychain receipt cannot contradict its detailed encryption
flags.

## Boundary and non-goals

Only the Keychain source-smoke receipt schema and its focused regression are changed. Native
storage, normal session behavior, and production defaults are unchanged.

## Checklist

- [x] PIN a coherent receipt shape and capture a failing contradictory legacy receipt.
- [x] Remove the obsolete aggregate field and reject its reappearance before `ok` is set.
- [x] Run focused consistency and persistence tests plus three real Electron save/relaunch runs.

## Acceptance

- [x] `ok: true` receipts contain only `encryptedFiles.session` and
  `encryptedFiles.snapshot`, both true.
- [x] All three no-QA current-source runs retain zero empty-boot native calls, native
  encryption/decryption, both restores, zero diagnostics, and cleanup.
