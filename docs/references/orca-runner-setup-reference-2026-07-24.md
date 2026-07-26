# Orca Runner Setup Reference — Agent Calendar Phase 0 Story 4

- Capture date: **2026-07-24**
- Locally observed Orca version: **1.4.152**
  (`/Applications/Orca.app` `CFBundleShortVersionString` / `kMDItemVersion`)
- Status: Durable reference packet for Phase 2 Runner Setup UI (implementation not started)
- Parent roadmap: `docs/plans/2026-07-24-production-development-roadmap.md`
- Parent design: `docs/plans/2026-07-24-production-agent-calendar-platform.md`
- Child plan: `docs/plans/2026-07-24-phase0-provider-auth-signing-orca-decisions.md`
- ADRs: `docs/adr/0008-bind-runners-to-authenticated-workspaces.md`, `docs/adr/0009-provider-auth-calendar-signing-distribution.md`

## Purpose

Record what Orca publicly documents and what this machine showed on **2026-07-24**, then define exactly what Agent Calendar **adopts** (UX progressive disclosure) versus **deviates** from (multi-tenant control plane, account-first enrollment, no permission-bypass defaults, no raw reusable pairing-link authority).

This packet is a **design input**, not a license to copy Orca’s security model.

## Source URLs and capture metadata

| Source | URL | Role in this packet | Capture date |
| --- | --- | --- | --- |
| Remote Orca Servers | https://www.onorca.dev/docs/remote-servers | Exact advertise / add / connect order; grants; Connected/Disconnected | 2026-07-24 |
| Ways to run Orca | https://www.onorca.dev/docs/ways-to-run | Local vs SSH vs Remote Server vs per-workspace env map | 2026-07-24 |
| SSH worktrees | https://www.onorca.dev/docs/ssh | Contrast: laptop-owned runtime vs remote-owned runtime | 2026-07-24 |
| Supported agents | https://www.onorca.dev/docs/agents/supported | Built-in agents; **permission-bypass defaults** called out | 2026-07-24 |
| Codex in Orca | https://www.onorca.dev/docs/agents/codex | Engine-specific integration notes | 2026-07-24 |
| First session | https://www.onorca.dev/docs/first-session | Workspace / agent onboarding progressive disclosure | 2026-07-24 |
| Official X video | https://x.com/orca_build/status/2048192633688997940 | Create-workspace modal progressive disclosure only | Published **2026-04-26**; noted **2026-07-24** |
| Local Orca app | `/Applications/Orca.app` | Version **1.4.152**; `orca status --json` runtime ready | 2026-07-24 |

### X video honesty note

The official X video ([status/2048192633688997940](https://x.com/orca_build/status/2048192633688997940), **11.3s**, published **2026-04-26**) shows approximately:

1. Create workspace modal
2. Repository selection
3. Optional name
4. Agent selection
5. Start-from / PR selection
6. Setup script preview
7. Create → workspace

It is useful for **progressive disclosure** of a multi-step create flow. It does **not** demonstrate Remote Orca Server pairing, Tailscale, access-link generation, Shared Server Access revocation, or Agent Calendar–style Runner enrollment. **Do not** treat this video as Runner pairing guidance.

## What Orca is (for benchmarking)

From official docs (2026-07-24 capture):

- Orca is a worktree / agent / terminal oriented product. Remote modes keep projects, worktrees, terminals, provider accounts, and agent sessions on a **server computer**; clients are UI.
- Recommended remote path: Orca desktop on both machines + **Tailscale** private address (often `100.x`).
- Credentials and agent CLIs are installed and authenticated on the **server**, not automatically carried from the laptop login.
- Each paired client gets a **separate revocable grant**; unused access links can be replaced; already-paired clients keep grants until revoked.
- Built-in agents default to **permission-bypass / yolo-style flags** for disposable worktrees (explicitly documented on Supported agents). Agent Calendar **rejects** that default for product Runners.

Agent Calendar remains **calendar-first operations context**, not an Orca clone (platform plan Non-Goals).

## Exact Orca Remote Server order (official docs)

### A. Server computer — advertise and generate access link

Source: https://www.onorca.dev/docs/remote-servers

1. Open the **Orca desktop app** on the computer that should keep sessions running.
2. Open **Settings → Remote Orca Servers**.
3. Under **Advertise this app as a server**, click **New Link**.
4. For **Connection address**, select the **Tailscale address** (typically `100.x.y.z`).
5. Click **Generate Access Link**.
6. **Copy** the link under **Pair another Orca client**.

If the Tailscale address is missing: confirm Tailscale is connected, then refresh the Connection address control. Do not advertise `127.0.0.1` for another computer.

### B. Client computer — add server and connect

1. Open **Settings → Remote Orca Servers**.
2. Click **Add Server**.
3. Enter a recognizable **name**.
4. **Paste** the access link from the server.
5. Click **Add** / **Add Server**.
6. If the saved server shows **Disconnected**, click **Connect**.

Adding a server saves it without forcing every new project onto it. **Advanced → Active Server** is only for defaulting server-routed work.

### C. Credentials location (official)

- Install and authenticate Codex, Claude Code, other agent CLIs, `git`, and provider CLIs on the **server computer**.
- A login on the laptop does **not** automatically carry over to the server.

### D. Access model (official)

- Separate, **revocable** token/grant per paired client (**Shared Server Access**).
- Revoking a grant disconnects active clients using that grant immediately.
- Generating another link replaces the previous **unused** link; already-paired clients keep their grants until revoked.
- Prefer Tailscale / private network; do not forward Orca’s port naked to the public internet.

### E. Connection states (documented / UI language)

| State | Meaning (Orca) | Operator action |
| --- | --- | --- |
| **Connected** | Client has a live path to the remote runtime | Use projects/agents on that server |
| **Disconnected** | Saved server not currently reachable / not connected | Click **Connect**; check awake host, Orca running, Tailscale, ACLs |
| **Reconnect** | Return client to server-owned state after sleep/network loss | Connect again; sessions remain server-owned when server stayed up |
| **Revoked** | Grant removed under Shared Server Access | Client loses access; generate a new link only for intended client |

Troubleshooting themes from docs: missing Tailscale address, incompatible protocol version after uneven upgrades, wrong person received access link → revoke grant, agent CLI missing on server PATH/home.

### F. Alternative headless path (documented, not Agent Calendar default)

```text
orca serve --pairing-address <server-tailscale-ip-or-hostname>
```

Paste the printed pairing URL into the client Add Server flow. Agent Calendar’s product Runner is **not** “paste a long-lived Orca pairing URL as account authority.”

## Adopt / deviate table (Agent Calendar vs Orca)

| Step / concern | Orca behavior (captured) | Agent Calendar decision | Adopt or deviate |
| --- | --- | --- | --- |
| 1. Product entry | Open Orca; local or remote runtime | **Agent Calendar login first** (WorkOS AuthKit; ADR 0009) | **Deviate** — account before any Runner surface |
| 2. Tenancy | Single-user / self-hosted runtime ownership | **Workspace resolution** from membership after login | **Deviate** — multi-tenant control plane |
| 3. Host software | Install Orca desktop / `orca serve` | **Signed Runner install** (separate notarized package, ADR 0009) | **Adopt intent** (install host agent) / **Deviate packaging** |
| 4. Pairing material | Access link / pairing URL (revocable per client; unused link replaceable) | **Short-lived one-use challenge / QR** bound to authenticated owner session | **Deviate** — no raw reusable pairing-link authority |
| 5. Device identity | Server-side runtime + client grant token | **Runner local device key** generated on host; public proof to control plane | **Deviate** (cryptographic device identity owned by AC protocol) |
| 6. Pre-activation | Link paste may be enough to join runtime | **Pending identity** until owner confirms | **Deviate** — pending state mandatory |
| 7. Owner confirmation | Grant list / revoke after the fact | **Owner fingerprint confirmation** in Desktop before activation (ADR 0008) | **Deviate** — explicit confirm before active credential |
| 8. Long-lived host auth | Revocable client grant to server runtime | **Activation → separately revocable device credential** for control-plane device protocol | **Adopt intent** (revocable) / **Deviate protocol** |
| 9. Engines | Preconfigured agents; server PATH/credentials | **Engine probes** for Codex / Claude / Grok / Hermes (capability report, fail-closed) | **Adopt progressive disclosure** / **Deviate matrix & defaults** |
| 10. Provider auth location | On server host | **Runner-side provider auth** remains on customer host; never control-plane secret store as default | **Adopt** |
| 11. Readiness | Use normally once Connected | Explicit **connection test** + capability readiness before offering work | **Adopt + strengthen** |
| 12. Product completion cue | Workspace/agents usable | **Calendar-first completion**: enrollment success returns user to Unified Calendar / Runner readiness, not a worktree IDE | **Deviate product climax** |
| Permission defaults | Pre-fill **yolo / dangerously-skip / bypass** flags for agents | **Reject** permission-bypass defaults; policy-gated tools and Approval Gates | **Deviate — explicit reject** |
| Pairing as login | Pairing enables client UI against server | Pairing/challenge **never** substitutes User login or recovers User account | **Deviate — explicit reject** |

### Explicit rejections (normative)

1. **Reject Orca permission-bypass defaults** as Agent Calendar Runner launch policy. Documented Orca defaults include flags such as `--dangerously-skip-permissions` (Claude), `--dangerously-bypass-approvals-and-sandbox` (Codex), and `--yolo` (including Hermes and others). Agent Calendar Work and Automation stay behind product policy and Approval Gates.
2. **Reject raw reusable pairing-link authority.** An access link that can be pasted by anyone who obtains it must not enroll a Runner into a Workspace without an authenticated owner session, one-use challenge consumption, and fingerprint confirmation.

## Agent Calendar Runner enrollment state machine

```text
[LoggedOut]
    | WorkOS AuthKit (system browser, Auth Code + PKCE)
    v
[AuthenticatedUser]
    | resolve Workspace + Membership
    v
[WorkspaceReady]
    | open Runner Setup; download signed Runner if needed
    v
[RunnerInstallOffered]
    | install / open local Runner app
    v
[ChallengeIssued]  ---- short-lived, one-use code/QR (TTL bound)
    | Runner presents code + device public key proof
    v
[PendingDevice]  ---- visible fingerprint; not yet authorized to execute
    | owner confirms fingerprint in Desktop
    v
[ActiveRunner]  ---- device credential issued; revocable
    | engine probes (Codex, Claude, Grok, Hermes, …)
    v
[CapabilitiesReported]
    | runner-side provider auth as needed (host local)
    v
[ConnectionTested]
    | success
    v
[CalendarFirstReady]  ---- enrollment complete; Calendar / control surfaces enabled

Any state may transition to:
  [Revoked] | [ExpiredChallenge] | [ProbeFailed] | [Disconnected] | [Error]
```

### State notes

| State | Allowed product actions | Forbidden |
| --- | --- | --- |
| LoggedOut | Login only | Enrollment, calendar mutations under user identity |
| WorkspaceReady | Start enrollment; view revoked devices | Execute work on unbound host |
| ChallengeIssued | Show code/QR once; poll pending | Reuse challenge after consume/expiry |
| PendingDevice | Owner confirm or reject | Job lease, secret sync |
| ActiveRunner | Heartbeat, capability report, accept Workspace-scoped work | Cross-Workspace execution |
| CalendarFirstReady | Normal product use with that Runner | Silent fallback to another customer’s Runner |
| Revoked | Re-enroll with new challenge | Reuse old device credential |

## Error recovery

| Failure | Detection | Recovery |
| --- | --- | --- |
| Login cancelled / IdP error | AuthKit callback error | Stay LoggedOut; show honest error; retry login |
| Challenge expired | TTL / single-use consume | Issue new challenge; invalidate old QR |
| Challenge reused | Second present after consume | Reject; alert owner; new challenge |
| Fingerprint mismatch / owner reject | Owner action | Leave PendingDevice → rejected; no credential |
| Device credential stolen suspicion | Owner report / anomaly | **Revoke** device; force re-enroll |
| Runner disconnected | Heartbeat timeout | Show Disconnected; queue policy fail-closed; reconnect with same device credential if not revoked |
| Engine missing / unauthenticated | Probe result | Capability = unavailable; UI offers host-side fix; no silent engine swap |
| Provider rate limit / auth required | Probe or job evidence | Surface provider error; credentials stay on host |
| Protocol version skew | Negotiation failure | Block work; require Runner/Desktop update path |
| Wrong person saw challenge | Owner awareness | Revoke pending; rotate challenge; never rely on secrecy of a long-lived link |

## Implementation UI test checklist (Phase 2 Desktop)

Use when building Runner Setup against this packet. Tests are not implemented in Story 4.

### Progressive disclosure (inspired by Orca create flow + Remote Server steps)

- [ ] Login wall appears before any Runner Setup CTA
- [ ] Workspace label visible before enrollment starts
- [ ] Signed Runner download / open instructions shown before challenge
- [ ] Challenge/QR step is single-purpose (no calendar noise)
- [ ] Pending fingerprint screen shows human-comparable device fingerprint
- [ ] Confirm and Reject are both available and audited
- [ ] Capability list appears only after ActiveRunner
- [ ] Connection test is explicit with pass/fail
- [ ] Success returns to **Calendar-first** shell, not a terminal IDE

### Security / negative

- [ ] Logged-out client cannot create enrollment challenge
- [ ] Challenge cannot be reused
- [ ] Expired challenge fails closed
- [ ] Pending device cannot receive job leases
- [ ] Revoked device cannot reconnect with old credential
- [ ] Cross-Workspace Runner ID rejected
- [ ] No default launch args inject yolo / dangerously-skip / bypass flags
- [ ] Pairing material is never stored as the User session

### Connection states

- [ ] Connected / Disconnected / Reconnecting / Revoked copy is honest
- [ ] Reconnect after laptop sleep restores session without re-login when User session valid and device still Active
- [ ] Server/host offline shows fail-closed work creation, not silent queue to another Runner

### Engines

- [ ] Probe results for Codex, Claude, Grok, Hermes independently
- [ ] Unavailable engine cannot be selected for new work without remediation
- [ ] Provider auth fix deep-links to host-side instructions only (no control-plane secret paste)

## Mapping Orca Remote Server order → Agent Calendar Setup UI (side-by-side)

| Orca Remote Server | Agent Calendar Runner Setup |
| --- | --- |
| Settings → Remote Orca Servers → Advertise → New Link | Workspace settings → Runner → **Add Runner** (requires login) |
| Choose Tailscale address | Choose/install on customer host (network is customer-controlled; AC does not require Tailscale specifically) |
| Generate Access Link → copy | Control plane issues **one-use challenge**; Desktop shows code/QR |
| Client Add Server → paste link → Add → Connect | Runner submits challenge + device key → **Pending** → owner confirms → **Connect/test** |
| Shared Server Access revoke | Owner **Revoke Runner** in product settings |
| Credentials on server | Provider CLIs/auth on **Runner host** |

## Version drift policy

If Orca releases change Settings labels or pairing UX after **2026-07-24 / 1.4.152**:

1. Create a new dated reference file (do not silently rewrite history of this packet).
2. Diff adopt/deviate rows.
3. Update Phase 2 UI checklist only after product owner accepts the new capture.

## What this packet does not authorize

- Copying Orca trademarks, assets, or proprietary UI chrome wholesale
- Treating Orca pairing URLs as Agent Calendar production credentials
- Skipping ADR 0008 owner confirmation
- Claiming Phase 0 Mac mini reconstruction or credential rotation complete

## Appendix — local observation notes (2026-07-24)

- `defaults read /Applications/Orca.app/Contents/Info.plist CFBundleShortVersionString` → `1.4.152`
- `orca` CLI resolves to `/Applications/Orca.app/Contents/Resources/bin/orca` via `/usr/local/bin/orca`
- `orca status --json` reported local app running and runtime `ready` (no secrets recorded)
- No production Agent Calendar Runner package was installed or enrolled as part of this documentation story
