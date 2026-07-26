# Plan: Clean-account ETE current UI revalidation

- Date: 2026-07-25
- Owner: Codex
- Work size: Large | Boundary
- Status: Complete

## Goal

Revalidate the production clean-account path on the current Orca-style Desktop:
login → first-run guide → account-bound Runner enrollment → Engine capability →
Delegated Work → live checkpoint → Calendar result → backend/Desktop restart →
Runner reconnect, with no duplicate terminal result.

## Non-goals

- Claiming a live WorkOS tenant, public signing account, or remote Mac mini that was not observed.
- Replacing the existing Phase 2/3 production protocol or test Engine.
- Starting Mobile before Phase 10 entry gates.

## Work size

Large and Boundary. The work exercises Desktop, Electron, PostgreSQL, Runner device
authentication, durable execution, Calendar projection, and restart recovery.

## Touched boundaries

- Backend Runner status copy: `apps/backend/app/lib/runner-control.js`
- Desktop Runner setup and presentation
- Phase 2 and Phase 3 Electron ETE workflows
- Production roadmap and current-revision evidence

## Success criteria

- [x] Clean account reaches Runner Setup through the current first-run guide.
- [x] Rendered QR is physically decodable and equals the server payload.
- [x] Disconnected state never presents current readiness.
- [x] Reconnect, credential rotation, revoke, and old-credential denial pass.
- [x] One Delegated Work produces live checkpoints and one Calendar projection.
- [x] Backend/Desktop restart and Runner reconnect preserve exactly one terminal result.
- [x] Full Backend, Desktop, and Runner tests pass.

## Edge cases

- Stale UI locator after navigation redesign.
- Dense enrollment payload becoming unreadable after QR downscaling.
- Historical success copy implying a disconnected Runner is currently ready.
- Retry after restart creating a duplicate terminal or Calendar projection.

## Test plan

- RED: run Phase 3 golden ETE and observe the retired `Runner Setup` locator failure.
- GREEN: follow the visible first-run guide Runner step.
- RED: run Phase 2 ETE and observe physical QR decode failure at 197×197.
- GREEN: render a stable 256px QR and preserve quiet-zone padding.
- RED/GREEN: keep disconnected copy free of current-success language.
- REFACTOR: update only the existing Phase 2/3 workflows and current status copy.

## Acceptance gates

- [x] Phase 2 Runner enrollment Electron ETE
- [x] Phase 3 clean-account golden Electron ETE
- [x] Phase 2 hostile PostgreSQL matrix
- [x] Backend check
- [x] Backend 457/457
- [x] Desktop 260/260
- [x] Runner 23/23
- [x] Desktop production build through both ETE runs
- [x] Manual screenshot QA
- [x] `git diff --check`

## Step-by-step checklist

- [x] Compare Phase 2 and Phase 3 user journeys.
- [x] Reproduce the current UI navigation failure.
- [x] Update both ETEs to follow the first-run guide.
- [x] Fix and verify physical QR decoding.
- [x] Correct connected and disconnected status truth.
- [x] Run the clean-account ETE and complete regression gates.
- [x] Record current-revision evidence and remaining external gates.

## Rollback

Revert the Runner QR size, status copy, and ETE navigation changes. No schema,
credential, or persisted-data rollback is required.

## Remaining risks

- The local golden ETE uses the real Runner protocol with a bounded Fake Engine; an
  authenticated live Codex/Claude/Grok/Hermes run remains host-specific release evidence.
- The current Mac mini was not enrolled during this revalidation.
- Live WorkOS, Apple signing/notarization, and public distribution remain external gates.
