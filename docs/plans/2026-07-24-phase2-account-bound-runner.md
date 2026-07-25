# Plan: Phase 2 Account-bound Runner Enrollment + Connection

- Date: 2026-07-24
- Owner: Codex
- Work size: Large | Boundary
- Status: Verified

## Goal

A signed-in Workspace **owner** can enroll a customer-controlled host as an
account-bound Runner: short-lived one-use challenge + scannable QR → real local
`apps/runner` presents Ed25519 device key → Desktop shows human-comparable
fingerprint → owner confirm → credential delivered **only** to the Runner client →
protocol negotiate, capability report, connection test → calendar-first ready;
reconnect with same credential; owner revoke/rotate rejects the old credential
immediately. ADR 0008 deviations over Orca pairing are enforced.

## Non-Goals

- Durable job leasing / execution offers (Phase 3).
- Live WorkOS production credentials/dashboard (still external).
- Notarized production installer / Apple Developer signing accounts (Phase 8 gate).
- Device public-key rotation with owner confirm (deferred honestly if not shipped).
- Replacing legacy `/api/relay` as production device auth.
- Silent fallback to another Workspace's Runner.

## Touched Boundaries

- Backend gateway: `railway-gateway-server.js` (composition only via production dispatch)
- Backend library: `runner-control.js`, `runner-device-auth.js`, `production-runner-routes.js`,
  `production-route-registry.js`, `production-gateway-dispatch.js`, `phase1-auth-routes.js`,
  `production-product-routes.js` (agent-ops remains `runner_required` for work)
- DB/migrations: `0017_runner_enrollment_connection.sql`
- Runner package: new `apps/runner` workspace (CLI/daemon)
- Electron bridge: minimal if needed for open-local-runner handoff only
- React UI: Runner Setup progressive disclosure (settings + dedicated surface)
- Tests: hostile PG matrix, runner unit tests, Desktop typecheck/tests, Electron+Runner E2E
- Docs: this plan, roadmap Phase 2, evidence JSON, Orca worktree comment

## Architecture (normative)

### State machine

```
LoggedOut → AuthenticatedUser → WorkspaceReady
  → RunnerInstallOffered → ChallengeIssued
  → PendingDevice (fingerprint) → ActiveRunner
  → CapabilitiesReported → ConnectionTested → CalendarFirstReady
Any → Revoked | ExpiredChallenge | Disconnected | Error
```

### Identity separation

| Principal | Authority |
| --- | --- |
| User session (app access token) | Desktop/product APIs; owner-only enroll/confirm/reject/revoke/test |
| Device credential (hashed) + Ed25519 | Device channel only: claim/connect/heartbeat/capabilities/rotate/disconnect |
| Challenge code | One-use proof of proximity; never ongoing credential; never User login |

Workspace authority is **always** server membership (`WorkspaceScope`), never body/query
`workspaceId`.

### Crypto transcripts

**Enrollment present (device → control plane):**

```
enroll-v1\n
challengeId={id}\n
challengeCode={code}\n
devicePublicKey={spki-or-raw-b64url}\n
protocolVersion={n}\n
hostName={...}\n
hostOs={...}\n
runnerVersion={...}\n
```

Signed with device Ed25519 private key. Server verifies against challenge secret hash,
consumes challenge atomically, creates **PendingDevice** only + one-use claim handle.

**Device-authenticated request:**

```
device-v1\n
{method}\n
{path}\n
{bodySha256Hex}\n
{unixTimestampMs}\n
{nonce}\n
{runnerId}\n
{sessionIdOrEmpty}\n
{cursorOrEmpty}\n
```

Headers: `X-Runner-Id`, `X-Runner-Timestamp`, `X-Runner-Nonce`, `X-Runner-Session`,
`X-Runner-Cursor`, `X-Runner-Credential`, `X-Runner-Signature` (base64url).

Constraints: clock skew ≤ 120s; nonce one-use per runner; credential hashed server-side
(SHA-256); revoked/pending/rejected fail closed; foreign workspace runner id rejected.

### Credential lifecycle

1. Owner starts enrollment → challenge (hashed) + human code + QR payload.
2. Device enrolls → PendingDevice + claim token (hashed; returned only on device channel).
3. Owner confirms fingerprint → claim becomes redeemable.
4. Device claims with claim token + signature → **device credential** (plaintext once to device).
5. Connect/heartbeat/capabilities require device auth.
6. Rotate: new credential to device only; old hash invalid immediately.
7. Owner revoke: status=revoked, sessions fenced, credential rejected.

Desktop user APIs **never** return `deviceCredential`, `claimToken`, or challenge secret.

### HTTP registry (exact paths)

**User-scoped (session; owner for mutations):**

| Method | Path | Role | Action |
| --- | --- | --- | --- |
| GET | `/api/runners` | member | list (no secrets) |
| GET | `/api/runners/release-manifest` | member | signed/dev/unavailable handoff |
| POST | `/api/runners/enrollments` | owner | start challenge |
| GET | `/api/runners/enrollments/:id` | owner | poll enrollment |
| POST | `/api/runners/enrollments/:id/confirm` | owner | confirm pending |
| POST | `/api/runners/enrollments/:id/reject` | owner | reject pending |
| POST | `/api/runners/:id/test` | owner | connection test |
| POST | `/api/runners/:id/revoke` | owner | revoke |

**Device-auth (no user session):**

| Method | Path | Action |
| --- | --- | --- |
| POST | `/api/runner/device/enroll` | present challenge + device proof |
| POST | `/api/runner/device/claim` | redeem claim → credential |
| POST | `/api/runner/device/connect` | protocol negotiate + session |
| POST | `/api/runner/device/heartbeat` | lastSeen / connected |
| POST | `/api/runner/device/capabilities` | engine probe report |
| POST | `/api/runner/device/rotate` | rotate credential |
| POST | `/api/runner/device/disconnect` | graceful disconnect |

Class: user routes = `scoped_product` (owner-gated where role=owner);
device routes = new class `runner_device` (device auth middleware, not session).

Replace `runner_future` placeholders. Legacy `/api/relay/*` stays provider_webhook /
legacy rollback only.

### DB migration 0017

Tables (composite same-Workspace FKs where applicable; FORCE RLS for user/control reads):

- `runner_enrollment_challenges` — workspace_id, owner_user_id, challenge_hash, human_code_display,
  expires_at, consumed_at, replaced_by, status
- `runners` — workspace_id, status (pending|active|rejected|revoked), device_public_key,
  fingerprint_sha256, host_metadata jsonb, protocol_version, credential_hash, credential_version,
  enrollment_challenge_id, last_seen_at, connected_at, connection_state, capabilities jsonb,
  last_test_at, last_test_ok, revoked_at, created_at, updated_at
- `runner_pending_claims` — runner_id, workspace_id, claim_token_hash, expires_at, claimed_at, status
- `runner_sessions` — runner_id, workspace_id, session_token_hash, cursor bigint, fenced_at,
  connected_at, last_heartbeat_at, protocol_version
- `runner_request_nonces` — runner_id, nonce, used_at (TTL index)
- `runner_connection_events` — workspace_id, runner_id, event_type, actor, payload, created_at
- Indexes + cleanup TTL helpers for challenges/nonces/claims
- Audit continues via `audit_events` for owner confirm/reject/revoke

RLS: FORCE RLS on all runner tables with `workspace_id = current_setting('app.workspace_id')`
for `agent_calendar_app`. Device-auth path uses elevated service queries with explicit
runner_id + credential verification (not user RLS session) — same pattern as auth session
lookup before scope is known.

### apps/runner

Real workspace package:

- `generateKeypair` / persist under `~/.agent-calendar-runner/` (0600/0700)
- Commands: `enroll`, `claim-wait`/`daemon`, `connect`, `heartbeat`, `capabilities`, `rotate`, `disconnect`
- Capability probes: Codex, Claude, Grok, Hermes — injected probe in tests; production
  `spawn` fixed argv, `shell: false`, time/output limits
- **Banned argv never used:** `--yolo`, `--dangerously-skip-permissions`,
  `--dangerously-bypass-approvals-and-sandbox`, Hermes one-shot/bypass flags
- Report installed/version/auth status only; never upload provider secrets

### Desktop Runner Setup UI

Progressive disclosure (Orca-inspired, ADR deviations in copy):

1. Login wall
2. Visible Workspace
3. Installer handoff: verified signed / local development / unavailable (no arbitrary URL)
4. One-use code + real QR (payload: control-plane base + challenge id + code + protocol)
5. Pending fingerprint Confirm/Reject
6. Capabilities only after Active
7. Explicit connection test
8. Connected / Disconnected / Reconnecting / Revoked
9. Success → calendar-first

Copy deviations: account-bound, owner-confirmed, provider credentials stay on host,
no bypass defaults.

### Release manifest contract

`GET /api/runners/release-manifest` returns:

```json
{
  "ok": true,
  "artifact": {
    "status": "verified_signed" | "local_development" | "unavailable",
    "version": "...",
    "platform": "darwin-arm64",
    "downloadUrl": null | "https://…",
    "sha256": null | "…",
    "signature": null | "…",
    "publicKeyId": null | "…",
    "notes": "…"
  }
}
```

Dev/test uses a fixture signed with a test Ed25519 key. No claim of notarized production
without signing credentials.

## Success Criteria

- [x] Hostile two-user / two-Workspace / two-Runner matrix green on real PostgreSQL
- [x] No device credential/claim/challenge secret in any user API response
- [x] Member cannot start/confirm/reject/revoke/rotate; logged-out cannot see setup state
- [x] Challenge replace/reissue expires prior unused challenge
- [x] Pending/rejected cannot connect/heartbeat/capabilities
- [x] Replay/nonce/clock-skew/wrong signature/body substitution/foreign runner rejected
- [x] Protocol mismatch fail-closed
- [x] Reconnect with monotonic cursor; stale cursor cannot overwrite live session
- [x] Revoke/rotate immediately rejects old credential
- [x] Capability probes never use banned args
- [x] Electron + real `apps/runner` E2E: enroll → confirm → claim → connect → caps → test →
      reconnect → revoke; reject path covered at backend; screenshots clean
- [x] Full gates green; evidence JSON + roadmap update

## Edge Cases

- Concurrent enroll present on same challenge: exactly one wins
- Claim replay after success: rejected
- Heartbeat timeout → Disconnected without credential loss
- Multiple Runners same Workspace: list/select independently; no cross-swap
- Body `workspaceId` spoof: ignored
- Stale reconnect after fence: rejected

## Test Plan

- RED:
  - [ ] `phase2-account-bound-runner.test.cjs` fails before implementation
  - [ ] `apps/runner` unit tests fail without package
- GREEN:
  - [ ] Migration + RunnerControl + routes + runner CLI + Desktop UI
- REFACTOR:
  - [ ] Only while green; no assertion weakening

## Acceptance Gates

- [x] `npm run backend:check`
- [x] `npm run test:backend` (350/350 including Phase 2 matrix)
- [x] Runner package tests + check (4/4)
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test` (167/167)
- [x] `npm run build:desktop`
- [x] Single Electron+Runner E2E (~11.5s)
- [x] `git diff --check`
- [x] Evidence JSON + roadmap + plan verification notes

## Implementation Checklist

- [x] Step 1: Plan (this file)
- [x] Step 2: Migration 0017 + RLS
- [x] Step 3: RunnerControl module (crypto, enrollment, claim, session, revoke)
- [x] Step 4: Registry classes + user/device routes + dispatch (`runner_future` removed)
- [x] Step 5: `apps/runner` package
- [x] Step 6: Desktop Runner Setup UI + hermesApi + release manifest
- [x] Step 7: Hostile PG tests TDD
- [x] Step 8: Electron+Runner E2E + screenshots
- [x] Step 9: Full gates + evidence + roadmap

## Verification Notes

### Gap-fix round (Manual QA + security) — 2026-07-24

1. **Standards-compliant QR** — `qrcode` library (ISO 18004 ECC-M); unit round-trip
   `runner-qr-roundtrip.test.mjs` 2/2; E2E `jsQR` decode of `qr-element.png` equals
   `qrPayload` exactly. Custom compact matrix **removed**. Optional-RS risk **closed**.
2. **Disconnected screenshot** — real CLI `disconnect` → UI `data-state=disconnected` /
   label `Disconnected` → `disconnected.png` (visually confirmed).
3. **Credential rotation** — real CLI `rotate`; old credential denied; new reconnects with
   heartbeat+capabilities → `rotated-reconnected.png`. Device Ed25519 pubkey rotation remains
   revoke+re-enroll.
4. **Revoked UI** — stay on Runner Setup; `runner-step-revoked` + banner → `revoked-setup.png`;
   separate calendar → `revoked-calendar.png`.
5. **Secret tables** — hashes only in service-only tables (no SELECT grant to
   `agent_calendar_app`); hostile app-role test green.
6. **Disconnected ≠ ready UX** — when `connection_state !== connected`, do not render
   ready/connected card or green current pass; show **다시 연결 필요** + historical
   `마지막 연결 테스트 통과` only. Presentation unit 5/5; E2E asserts body copy.

### Commands / counts

- `node --test apps/backend/tests/phase2-account-bound-runner.test.cjs` → **4/4**
- `npm run test:backend` → **351/351**
- `npm --workspace apps/runner run test` → **4/4**
- `npm --workspace apps/desktop run test` → **174/174** (QR + connection presentation)
- E2E `playwright-phase2-runner-enrollment-e2e.cjs` → **pass** (~13.8s; disconnected UX fixed)
- typecheck / build:desktop / git diff --check → **pass** (backend/runner gates not re-run on this UI-only fix)
- Route inventory: **107** (scoped 70, runner_device 7, disabled 15, webhook 7, auth+infra 8)
- Evidence: `docs/operations/evidence/2026-07-24-phase2-account-bound-runner.json`
- Artifacts: `apps/desktop/test-results/phase2-runner-enrollment/`

### Current UI revalidation — 2026-07-25

- The clean-account E2E now enters Runner Setup through the first-run guide's
  `Runner와 실행 엔진` step instead of the retired `Runner Setup` button.
- The rendered enrollment QR is fixed at 256px plus quiet-zone padding. The captured
  273×273 PNG decodes back to the exact enrollment payload.
- Connected success copy no longer refers to future Phase 3 work. Disconnected state never
  repeats a current-success sentence inside historical status.
- `playwright-phase2-runner-enrollment-e2e.cjs` passed in 13.8s with enrollment,
  fingerprint confirmation, decode, disconnect, reconnect, credential rotation, revoke,
  and old-credential denial.
- Evidence:
  `docs/operations/evidence/2026-07-25-clean-account-runner-ete-revalidation.md`.

## Remaining Risks

- Risk: Apple signing/notarization accounts still external
  - Mitigation: manifest statuses honest (`local_development` / `unavailable`); Phase 8 gate
- Risk: Live WorkOS not exercised
  - Mitigation: fake AuthKit E2E + production mode PG
- Risk: Live installed provider execution still depends on each customer's authenticated CLI
  - Mitigation: capability probing is fail-closed; current clean-account ETE uses the real Runner
    protocol with the Fake test Engine while live provider execution remains a release-host gate
- Risk: Device pubkey rotation deferred
  - Mitigation: documented non-goal; revoke + re-enroll path works
