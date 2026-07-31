# Desktop and Widget Verified Release Candidate

- Date: 2026-07-26
- Work size: Large / Boundary
- Status: Repository complete / external credential gate retained
- Parent: `.omo/plans/production-readiness-completion.md` Todo 14

## Goal

Produce a fail-closed Desktop and companion Widget release-candidate pipeline
that binds an exact signed tag, commit, version, package bytes, notarization and
stapling evidence, checksums, SBOM, provenance, packaged runtime smoke, Widget
app-group behavior, and a controlled N-1→N update plus manual rollback.

The repository-side and unsigned local gates must be executable without release
credentials. Actual Developer ID signing, notarization, GitHub draft
publication, and external clean-host installation remain approval-bound.

## Non-goals

- Obtaining, reading, storing, or testing real Apple/GitHub credentials.
- Creating or publishing a GitHub release.
- Installing into `/Applications` or modifying the user's Keychain.
- Automatic downgrade.
- Runner release work owned by Todo 13.
- Treating QA AES storage as evidence for ordinary production safe storage.

## Touched boundaries

- GitHub release workflow: `.github/workflows/desktop-release.yml`
- Desktop release contracts/tools: `apps/desktop/tools/**`
- Desktop packaging and smoke: `apps/desktop/package.json`,
  `apps/desktop/tests/packaged-deep-link-smoke.cjs`
- Native companion: `apps/widget/macos/HermesWidgetHost/**`
- Contracts and tests: focused Desktop release/updater/widget tests
- Operations: `docs/operations/personal-beta-release.md`,
  `docs/operations/schemas/**`

## Success criteria

- [x] Exact signed tag, commit, package version, and staging percentage are
      validated before candidate work.
- [x] Missing signing/notary credentials and local unsigned evidence cannot
      reach attestation or draft publication.
- [x] Candidate evidence binds Developer ID authority/team, bundle identifiers,
      hardened entitlements, app-group entitlements, strict codesign,
      Gatekeeper, notarization, and staples for Desktop, Widget host, extension,
      and DMG.
- [x] Checksums cover every release artifact; CycloneDX SBOM and provenance
      requirements are immutable manifest inputs.
- [x] DMG places the separately built `Agents Calendar Widgets.app` beside the
      Desktop app and preserves the embedded extension.
- [x] Current-source packaged Desktop boots its production renderer, exercises
      cold/running deep links, rejects a hostile URL, visits intended surfaces,
      hydrates the Widget snapshot, and persists a Widget toggle.
- [x] Four WidgetKit configurations share the same app-group snapshot contract.
- [x] A local controlled updater producer verifies feed/candidate integrity,
      performs an atomic N-1→N replacement in a task-owned root, preserves
      user data, rehearses manual rollback, and proves interrupted/post-update
      failure rollback.
- [x] QA removes package roots, DerivedData, archives, processes, user data,
      feed servers/ports, and temporary metadata.

## Edge cases

- Missing/wrong Developer ID authority, team identifier, entitlements, app
  group, companion app, extension, staple, or Gatekeeper acceptance.
- Wrong tag, commit SHA, package version, feed version, SHA-256, SHA-512, SBOM,
  provenance subject, or updater candidate.
- A hand-authored `verified=true` flag without primary evidence.
- Malformed or hostile deep-link/update metadata and prompt-shaped release notes.
- Existing stale package/feed/evidence in a dirty worktree.
- Interrupted download, replacement, relaunch, promotion, and manual rollback.
- Hung Electron, xcodebuild, mount, feed server, or update command.

## Test plan

Follow PIN→RED→GREEN→SURFACE for each behavioral addition.

- PIN existing unsigned widget build, DMG layout contract, release finalizer
  rejection matrix, production renderer smoke, and existing updater policy.
- RED updater-producer tests for candidate mismatch, malformed feed,
  interrupted replacement, post-update validation failure, user-data mutation,
  and automatic downgrade.
- GREEN the smallest task-owned local updater/rollback producer.
- Run focused release artifact/contract/updater/widget tests only; do not run
  the shared full npm suite.
- Build Widget Release with signing disabled and temporary DerivedData.
- Build a current-source unsigned Desktop/Widget package in a task-owned root,
  mount it, and run the packaged smoke.
- Run truthful local `codesign`, `spctl`, and `stapler` checks and require
  publication preflight rejection because Developer ID/notary evidence is
  absent.

## Acceptance gates

- [x] Focused release/updater/widget tests pass.
- [x] Desktop typecheck and build pass.
- [x] Widget unsigned Release build passes.
- [x] Current-source unsigned DMG contains both apps.
- [x] Packaged deep-link/widget smoke emits an exact JSON receipt.
- [x] Local N-1→N, interrupted-update recovery, post-update rollback, and
      manual rollback emit bounded evidence.
- [x] Local unsigned candidate is rejected for publication.
- [x] Cleanup receipt proves no task-owned process, mount, user-data, feed
      server, package root, DerivedData, or archive remains.
- [x] External credential boundary report explicitly lists the unavailable
      Developer ID/notary/GitHub/clean-host gates without claiming them.

## Step-by-step checklist

- [x] Audit current release workflow, finalizer, package config, Widget project,
      smoke, schemas, and retained evidence.
- [x] PIN current behavior and add updater-producer RED tests.
- [x] Implement the controlled local updater/rollback producer.
- [x] Strengthen release request/evidence/publication fail-closed contracts.
- [x] Build and exercise the current-source unsigned Desktop + Widget package.
- [x] Run focused automated, adversarial, and cleanup gates.
- [x] Produce Todo 14 DoneClaim and external-boundary receipt.

## Rollback and fallback

The controlled local producer works only inside an explicit task-owned root and
never touches `/Applications`. If candidate validation or post-update launch
validation fails, restore the retained N-1 directory atomically and leave a
failure receipt. The public updater remains disabled until signed/notarized
clean-host evidence is attached to the exact candidate.

## Remaining risks

- Actual Developer ID authority, Apple notarization, stapling, Gatekeeper
  acceptance on downloaded bytes, GitHub attestation/draft publication, and a
  clean-host system install cannot be completed locally without credentials and
  explicit external-write authority.
- The local updater producer proves replacement/rollback mechanics and evidence
  binding, but it does not substitute for the credentialed electron-updater
  clean-host gate.
