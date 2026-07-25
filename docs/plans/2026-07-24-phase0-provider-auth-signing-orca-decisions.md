# Plan: Phase 0 Story 4 — Provider, Auth, Calendar, Signing, Distribution, and Orca Runner Reference

- Date: 2026-07-24
- Owner: Grok
- Work size: Medium (documentation / decision artifacts only)
- Status: Verified — decision packet complete; product implementation not started
- Parent design: `docs/plans/2026-07-24-production-agent-calendar-platform.md`
- Parent roadmap: `docs/plans/2026-07-24-production-development-roadmap.md`
- Runner ownership ADR: `docs/adr/0008-bind-runners-to-authenticated-workspaces.md`
- Decision ADR: `docs/adr/0009-provider-auth-calendar-signing-distribution.md`
- Orca reference: `docs/references/orca-runner-setup-reference-2026-07-24.md`
- Roadmap story: Phase 0 committed story 4 — record provider, auth, first calendar, signing, and distribution decisions plus the latest Orca GUI video/docs Runner-setup sequence required by Phase 1–4

## Goal

Lock durable, implementation-ready decisions for control-plane hosting, user identity, first external calendar, Desktop/Runner signing and distribution, and a dated Orca GUI/docs reference packet so Phase 1–4 work does not invent auth, enrollment, or release shape under pressure.

## Non-Goals

- Do not change product code, gateway behavior, DB schema, Electron, or UI.
- Do not implement WorkOS, Google Calendar, signing pipelines, or Runner Enrollment.
- Do not store vendor secrets, API keys, certificates, or pairing tokens in the repository.
- Do not rotate production credentials (separate operations task; leave explicit if incomplete).
- Do not claim full Mac mini live reconstruction when Story 2 blockers remain open.
- Do not stage or commit.
- Do not spawn agents or expand into Phase 1 implementation.

## Touched Boundaries

- Backend gateway: none
- Backend library: none
- DB/migrations: none
- Electron bridge: none
- React UI: none
- Tests: none (docs-only story)
- Docs: this plan; `docs/adr/0009-provider-auth-calendar-signing-distribution.md`; `docs/references/orca-runner-setup-reference-2026-07-24.md`; parent roadmap Story 4 / Phase 0 checklist updates only where evidence passes

## Decision Summary (implementation binding)

| Area | Decision |
| --- | --- |
| Control plane | Keep Railway control plane + Railway PostgreSQL through private beta |
| Environments | Separate staging and production Railway projects/databases |
| User identity | WorkOS AuthKit as the identity adapter |
| Desktop login | Hosted system-browser login; OAuth 2.0 Authorization Code + PKCE |
| First login methods | Google OAuth + email magic authentication |
| Account mapping | Backend maps provider subject → Agent Calendar User / Workspace / Membership |
| Runner auth | Separate device protocol; never WorkOS user/device login |
| First calendar | Google Calendar as first external calendar connector |
| Desktop target | macOS Apple Silicon first |
| Desktop signing | Apple Developer ID Application signing + notarization |
| Desktop artifacts | electron-builder DMG + ZIP via GitHub Actions → draft GitHub Releases |
| Supply chain | SHA-256, SBOM, provenance; staged stable manifests |
| Desktop rollback | Halt rollout; ship prior known-good commit as a higher patch |
| Runner package | Signed and notarized separately from Desktop |
| Secrets | Vendor/account credentials are external prerequisites, never committed |

Full rationale and constraints: `docs/adr/0009-provider-auth-calendar-signing-distribution.md`.

Orca capture (official docs + local app 1.4.152 + public X video), adopt/deviate table, state machine, and UI checklist: `docs/references/orca-runner-setup-reference-2026-07-24.md`.

## Success Criteria

- [x] Child plan exists with required AGENTS.md sections.
- [x] Durable ADR records provider, auth, calendar, signing, and distribution decisions.
- [x] Orca reference packet records source URLs, capture date, local version, exact Remote Server order, connection states, X video honesty note, adopt/deviate table, rejections, state machine, error recovery, and implementation UI test checklist.
- [x] Explicitly reject Orca permission-bypass defaults and raw reusable pairing-link authority.
- [x] Parent roadmap Story 4 / Phase 0 checklist updated only where evidence actually passes; credential rotation and live Mac mini reconstruction blockers remain explicit.
- [x] No product code, stage, commit, or unrelated dirty-worktree edits.
- [x] Markdown/link/path sanity checks pass for new and updated docs.

## Edge Cases

- WorkOS or Google Cloud project not yet provisioned → decisions stand; implementation waits on external prerequisites listed in ADR 0009.
- Apple Developer Program not enrolled → no public signed Desktop/Runner artifacts; Phase 8/9 blocked, decisions still recorded.
- Orca product UI changes after 2026-07-24 → re-capture reference with new date/version before Phase 2 Runner Setup UI; do not invent newer flows here.
- X video does not show Runner pairing → document progressive disclosure only; do not treat it as enrollment authority.
- Story 2 Mac mini host unreachable → Phase 0 exit gate remains incomplete; Story 4 does not clear that blocker.
- Credential rotation incomplete → leave explicit in roadmap; never paste secrets into these docs.

## Test Plan

This story is documentation-only. Verification is structural and path/link sanity, not product RED/GREEN.

### RED

- [x] Parent roadmap Definition of Ready requires dated Orca GUI reference with adopt/deviate table before Runner Setup UI work.

### GREEN

- [x] Produce ADR + Orca reference + this plan satisfying Definition of Ready for Phase 1–4 decision prerequisites.
- [x] Link checks from plan → ADR → reference → parent roadmap/ADR 0008.

### REFACTOR

- [x] Keep secrets out; mark external prerequisites only by account/capability name.

## Acceptance Gates

- [x] Docs exist at the paths named above
- [x] Relative links resolve inside the repository
- [x] Orca local version captured as 1.4.152 on 2026-07-24
- [x] No product-code verification required for this story
- [ ] Credential rotation (Phase 0 exit gate item) — **not claimed complete**
- [ ] Live Mac mini full reconstruction (Story 2 blocker) — **not claimed complete**

Skipped product gates:

- Gate: `npm run backend:check` / `npm test` / desktop build
  - Reason: documentation/decision artifacts only; no product code changed

## Implementation Checklist

- [x] Read AGENTS.md, CONTEXT.md, parent platform plan, parent roadmap, ADR 0008
- [x] Draft child plan with required sections
- [x] Write ADR 0009 (provider/auth/calendar/signing/distribution)
- [x] Write Orca runner setup reference (docs, Remote Server order, X video, adopt/deviate, state machine)
- [x] Update parent roadmap Story 4 / Phase 0 progress only for verified evidence
- [x] Run markdown/link/path sanity checks
- [x] Final report of files and results (no stage/commit)

## Verification Notes

- Command: `defaults read /Applications/Orca.app/Contents/Info.plist CFBundleShortVersionString`
  - Result: `1.4.152` (capture date 2026-07-24)
- Command: `orca status --json`
  - Result: local app running, runtime ready (no secrets recorded)
- Command: browse official Orca docs (`/docs/remote-servers`, `/ways-to-run`, `/ssh`, `/agents/supported`, `/agents/codex`, `/first-session`)
  - Result: Remote Server order, security model, permission-bypass defaults, and agent matrix captured
- Command: relative path existence checks for new docs and parent links
  - Result: see final report in session; all new paths present
- Product code:
  - Result: intentionally unchanged

## Remaining Risks

- Risk: External vendor accounts not provisioned before Phase 1 starts.
  - Mitigation: ADR 0009 external prerequisites checklist; Phase 1 may use fake Adapter only until WorkOS is live.
- Risk: Orca UI drift invalidates the dated reference.
  - Mitigation: re-capture before Phase 2 Runner Setup UI; never treat pairing link as product authority.
- Risk: Apple notarization or GitHub Actions signing secrets misconfigured later.
  - Mitigation: secrets stay in CI secret store; rollback = halt rollout + prior known-good higher patch.
- Risk: Operators confuse WorkOS device concepts with Runner device protocol.
  - Mitigation: ADR 0008 + 0009 + Orca reference all state Runner enrollment is separate.
- Risk: Phase 0 exit gate overstated.
  - Mitigation: roadmap leaves credential rotation and Mac mini live reconstruction open.

## Related Artifacts

| Artifact | Path |
| --- | --- |
| Parent platform design | `docs/plans/2026-07-24-production-agent-calendar-platform.md` |
| Parent roadmap | `docs/plans/2026-07-24-production-development-roadmap.md` |
| Runner ownership ADR | `docs/adr/0008-bind-runners-to-authenticated-workspaces.md` |
| Provider/auth/signing ADR | `docs/adr/0009-provider-auth-calendar-signing-distribution.md` |
| Orca Runner reference | `docs/references/orca-runner-setup-reference-2026-07-24.md` |
| Story 2 inventory (partial) | `docs/operations/macmini-runtime-inventory.md` |
| Story 3 restore evidence | `docs/operations/evidence/2026-07-24-phase0-snapshot-restore-rehearsal.json` |
