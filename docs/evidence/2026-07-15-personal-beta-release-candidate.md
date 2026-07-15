# Personal Beta Release Candidate Evidence

- Evidence time: 2026-07-15T23:49:36+0900
- Scope: single-owner Agent Calendar desktop, Railway control plane, and Mac mini Hermes execution plane
- Result: deployable personal beta candidate; owner Telegram delivery is the only product acceptance gate still requiring external configuration

## Source Identity

- Git base: `6b0397434e73788424d99e6deb3f87e14912873d`
- The release source is a reviewed working-tree snapshot, not a Git commit.
- Deployed backend runtime diff SHA-256, computed from the Git-base binary diff for backend runtime and package boundary files: `a594fa5702711a87002f23b144d7f2c6cd7e48dd8919f4430277c3e8bbb5f715`
- Required runtime: Node `22.x`, npm `>=10`
- `npm ci`: passed; 396 packages audited with zero reported vulnerabilities. The local shell used Node 26 and emitted the expected engine warning, while the repository and CI remain pinned to Node 22.

No credentials, authorization headers, raw prompts, private evidence, private filesystem paths, or Telegram identifiers are included here.

## Automated Gates

`npm run verify:beta` passed as one fail-fast gate:

- backend syntax check: passed
- desktop TypeScript checks: passed
- backend tests: 231 passed, 0 failed
- desktop tests: 133 passed, 0 failed
- production renderer and Electron build: passed
- final `git diff --check`: passed

The CI workflow retains the built renderer and Electron production bundle for 14 days,
fails when either output is absent, and pins every external action to a verified full commit SHA.

The non-fatal Vite test warning about port `24678` being in use did not fail or skip any test.

## Railway Release

- Final deployment: `c9648f94-5086-450f-b24c-4f1f684bb430`
- Status: `SUCCESS`
- Image digest: `sha256:5fa8cbc9a64d0bad3a48d15240a64e57a858de1e91726183a3204a2edc1bec0a`
- Gateway status: HTTP 200
- Effective runtime access: reachable through `relay`
- Relay bridge: online
- Live runtime snapshot: online
- Pending relay jobs: 0
- Active relay jobs: 0

The immediately preceding deployable snapshot is `6923a5b2-016a-4683-b3fb-3cb8ef72cddc`, image digest `sha256:5e534c0addf2d448521efe607b1123f58b1ef1565cf04a89c7926e88ecf160ee`. It passed the same runtime, taskless-resume, Telegram length, and raw-token redaction checks but predates webhook-secret authentication. If this snapshot is used for availability rollback, keep Telegram ingress and delivery disabled until the current forward fix is restored.

## Mac mini Runtime

- Runtime contract: Hermes profile chat with the safe toolset, approval boundary enabled, and no effective `--yolo` path.
- Runtime tests: 28 passed, 0 failed on the Mac mini.
- The runtime and outbound relay services were restarted after applying the cancellation patch and both recovered online.
- Cancellation backup: `work/beta-runtime-cancellation-backup-20260715T213935`
- Earlier safe-runtime backup: `work/beta-safe-runtime-backup-20260715T114303Z`
- Repository-side operational patches:
  - `docs/operations/macmini-runtime-cancellation.patch`
  - `docs/operations/macmini-relay-profile-chat-cancellation.patch`

The live stop smoke created a harmless process group, requested stop through the real runtime API, and observed:

- stop confirmation latency: 209ms
- process group alive after stop: false
- persisted run status: `stopped`
- late completion after the observation window: false

## Product Workflow Evidence

### Asynchronous task execution and report

- `run-now` returned HTTP 202 in 735ms while execution continued independently.
- The task reached `completed` through separate status reads.
- The generated report reached `ready` with five evidence records, four findings, five limitations, and three follow-up proposals.
- Feedback persistence was tested with an explicitly synthetic `useful=false` value; it does not claim an owner usefulness judgment.
- One follow-up was explicitly rejected, so verification caused no external side effect.

### Session persistence repair

- A real terminal task whose Task Session had remained `running` was repaired to `completed` on read.
- The repaired terminal status remained `completed` after store rehydration.
- Session events remained strictly sequence ordered.
- Regression tests cover out-of-order PostgreSQL writes and terminal task/session reconciliation.

### Work Conversation failure and responsive recovery

- A message accepted by the live SSE endpoint now keeps its truthful delivery receipt even when the following persisted conversation refresh fails.
- The saved-but-refresh-failed state exposes a retry notice, preserves any new draft, hides stale controls, and returns to the persisted conversation after recovery.
- Open Work Details and conversation-error states use one in-flow scroll owner on tablet, mobile, and 200% zoom so checkpoints, retry controls, and the composer do not overlap.
- Programmatic focus on the Work Conversation title now has a visible two-pixel focus indicator.
- The focused workspace, verifier, mission, task-session, live SSE, gateway-backed, and final-state Playwright workflows passed, including 20 responsive workspace screenshots and 11 final-state checks.
- The local live SSE workflow retained 213 ordered checkpoints, completed the keyboard-only delegation and approval path, and held both conversation and aggregate request concurrency to one.
- The real local gateway/file-store workflow completed 81 successful API responses and restored the persisted Work Conversation after a gateway and store restart.

### Configured desktop flow

The final built renderer/proxy source passed the authenticated configured-runtime browser flow:

- execution engine: Hermes
- persisted Work Conversation status before cleanup: `active`
- first streamed answer delta: 21,950ms
- progressive answer frames: 21
- all observed live frames: 48
- console live frames: 21
- API responses: 92
- follow-up response, reload restoration, narrow layout, and console streaming: passed
- live control cycle: pause, resume, and reload passed after correcting the taskless active-work resume boundary
- browser console errors: 0

The synthetic work `mission-work-1133ff1e257402110aaff2f3` was cancelled after verification, and its persisted Work status was re-read as `cancelled`.

### Telegram delivery boundary

- The minimized owner notification now uses bounded title, finding, limitation, and session-link budgets so the complete message remains below Telegram's 4,096-character `sendMessage` boundary.
- A valid session deep link remains intact at the end of an oversized synthetic report summary.
- Telegram-shaped raw bot credentials are redacted both at central Work Conversation/report sanitization and again at the outbound summary boundary.
- Webhook registration derives a Bot API secret from the configured bot token, and ingress uses a constant-time comparison before parsing or persisting an update.
- Requests with a missing or incorrect webhook secret receive HTTP 401 and cannot create an inbox candidate; only the exact registered secret reaches the allowlist boundary.
- The final Railway deployment returned HTTP 401 for a synthetic unsigned webhook request.
- The regression fixture constructs only a synthetic credential at runtime; the repository contains no bot token value.

### Offline and recovery behavior

- With the relay unavailable, gateway health reported the execution plane offline.
- A run request returned HTTP 503 `runtime_unavailable`; no fabricated run was created.
- Relay and live snapshot recovered after restart.

## macOS Artifacts

Both artifacts were rebuilt after the final desktop UI change at 2026-07-15T23:04:57+0900. The later backend-only taskless-resume correction does not alter the packaged desktop files.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `Agent Calendar-0.1.0-arm64.dmg` | 129,266,205 | `442b0b193acbc7f344096d74160216dbb0f8396a0458714fb6f1927e5e569cb5` |
| `Agent Calendar-0.1.0-arm64.zip` | 126,927,882 | `c29cbd47612b56428b48598aae9fa88da9faea1dd3168d8964830abf9566097a` |

Artifact verification:

- architecture: arm64
- bundle identifier: `com.agents.calendar`
- signing identity class: Apple Development
- Team Identifier: `BU697KN34B`
- hardened runtime flag: present
- entitlements: JIT and unsigned executable memory only
- `codesign --verify --deep --strict`: passed
- packaged deep-link cold launch: passed
- packaged deep-link routing to an already-running app: passed
- malformed deep-link rejection: passed
- notarization: skipped because credentials are absent
- Gatekeeper public assessment: rejected with exit 3, as expected for a non-notarized Apple Development artifact

This is a personal beta artifact, not a notarized public internet distribution build.

## Remaining External Gates

### Telegram owner delivery

The Railway environment does not currently provide the owner bot token or allowed chat ID. Report generation truthfully records `deliveryStatus=not_configured`. Unit and contract coverage for minimization, webhook authentication, allowlisting, delivery state, and deep links passes, but one real owner-only delivery cannot be claimed until those two values are configured externally. All five bot tokens previously exposed in a conversational channel are treated as compromised, were not used by this release, and must be revoked. Configure only a newly generated token directly in Railway, then run the authenticated System Connections bootstrap to register the derived webhook secret.

### Public macOS distribution

A Developer ID Application identity and Apple notarization credentials are absent. This does not block local personal beta use, but it blocks frictionless public distribution through Gatekeeper.

### Release traceability

The release source has not been committed. Before sharing the beta or starting the next milestone, create a reviewed release commit so the deployed backend, desktop artifact, and rollback source can be reproduced from Git.

## Rollback Evidence

- Railway rollback candidate: `6923a5b2-016a-4683-b3fb-3cb8ef72cddc` (Telegram disabled)
- Older pre-notification-hardening deployment: `0c0dc310-68bd-436a-bbdc-6c73b216a2e7`
- Mac mini cancellation rollback backup: `work/beta-runtime-cancellation-backup-20260715T213935`
- Desktop rollback: retain the previous DMG/ZIP and preserve the existing user-data directory; persisted meanings were not migrated by this release.
- Fail-closed fallback: if runtime safety, cancellation, or persistence becomes uncertain, disable execution and expose `blocked` or `unavailable` rather than switching agents or marking work complete.

The executable rollback steps are maintained in `docs/operations/personal-beta-release.md`.
