# Signed Runner release

This runbook covers repository-side candidate production only. It does not
authorize Developer ID credential access, Apple notarization, release upload,
or installation into a user's Runner root.

## Deterministic candidate

Use a clean, task-owned output directory. The archive contains only normalized
`package/package.json`, `package/bin/**`, and `package/lib/**` records. Paths,
ordering, uid/gid, modes, mtimes, tar headers, and gzip metadata are fixed.

```sh
node apps/runner/tools/runner-release-artifacts.cjs build \
  --source apps/runner \
  --output-dir "$TASK_OUTPUT" \
  --version 0.1.0 \
  --commit-sha 0123456789abcdef0123456789abcdef01234567 \
  --platform darwin-arm64
```

Run that command in two fresh output directories and require equal
`archiveSha256` and `sourceSha256`.

## Manifest and supply-chain evidence

The Ed25519 private key path must be an external ephemeral or managed secret. It
must never be committed or copied into evidence.

```sh
node apps/runner/tools/runner-release-artifacts.cjs finalize \
  --artifact "$TASK_OUTPUT/agent-calendar-runner-0.1.0-darwin-arm64.tgz" \
  --private-key "$EXTERNAL_RUNNER_RELEASE_PRIVATE_KEY" \
  --version 0.1.0 \
  --commit-sha 0123456789abcdef0123456789abcdef01234567 \
  --protocol-version 1 \
  --state-schema-version 1 \
  --platform darwin-arm64 \
  --staging-percentage 10 \
  --output-dir "$TASK_OUTPUT"
```

The command emits the signed canonical manifest, `SHA256SUMS`, CycloneDX SBOM,
and SLSA-style provenance. The signed `publicKeyId` is the first 16 hex
characters of the SHA-256 of the Ed25519 SPKI, prefixed with
`runner-ed25519-`.

Finalize also emits `<publicKeyId>.public.pem`; this is public material, not a
trust decision. The updater's `--trusted-public-key` path must be provisioned
independently of the manifest/archive transport after its key ID is reviewed. It
derives the same key ID locally and refuses an unknown or mismatched signer.
There is intentionally no production public key in this repository until
release authority provisions and reviews it.

## Backend trusted publication boundary

The Backend is the only authority that may construct the Desktop
`verified_signed` response. Configure it with server-owned values:

- `RUNNER_RELEASE_MANIFEST_JSON`: the signed manifest wrapper containing
  `downloadUrl`, `manifestUrl`, and the canonical signed `manifest`;
- `RUNNER_RELEASE_TRUSTED_PUBLIC_KEYS_JSON`: a JSON map from the reviewed
  `runner-ed25519-<id>` to an Ed25519 public SPKI PEM;
- `RUNNER_RELEASE_MINIMUM_VERSION`: the lowest stable version the Backend may
  offer.

Backend composition derives the key ID from the public SPKI, verifies the
canonical manifest signature, freshness, release floor, platform,
artifact digest/size/name, and exact HTTPS artifact/manifest URL binding. Only
then does it create a `verification.source = "backend_ed25519"` receipt for
Desktop. Caller-provided `status` and `verification` fields are ignored and
provide no authority. Missing, malformed, stale, mismatched, or untrusted
configuration is served as `unavailable`.

## macOS bootstrap candidate and external gates

The repository can create an unsigned, task-owned bootstrap package:

```sh
node apps/runner/tools/runner-release-artifacts.cjs bootstrap-pkg \
  --archive "$TASK_OUTPUT/agent-calendar-runner-0.1.0-darwin-arm64.tgz" \
  --output "$TASK_OUTPUT/AgentCalendarRunner-0.1.0.pkg" \
  --identifier com.agentcalendar.runner \
  --version 0.1.0
```

Before any external release action, run:

```sh
node apps/runner/tools/runner-release-artifacts.cjs release-preflight \
  --pkg "$TASK_OUTPUT/AgentCalendarRunner-0.1.0.pkg"
```

The preflight requires:

- `RUNNER_DEVELOPER_ID_INSTALLER` with a syntactically valid Developer ID
  Installer identity and an already signed package detectable by `pkgutil`;
- `RUNNER_NOTARY_KEYCHAIN_PROFILE` and an already stapled notarization ticket
  detectable by `xcrun stapler validate`;
- `RUNNER_DRAFT_PUBLICATION_TOKEN` representing explicit draft-publication
  authority.

Missing or invalid credentials and unsigned/unstapled packages return non-zero.
Even with syntactically valid inputs, this repository command stops with
`EXTERNAL_RELEASE_ACTION_NOT_AUTHORIZED`; the authorized external release
operator must separately run `productsign`, `notarytool submit --wait`,
`stapler staple`, clean-host validation, and draft upload. Record those receipts
before changing any release status to published.

## Local rollback rehearsal

```sh
EVIDENCE_DIR=.omo/evidence/production-readiness-completion/task-13/manual \
  node apps/runner/tools/phase10-runner-rollback-rehearsal.cjs
```

The rehearsal owns a temporary install root and test-only enrolled identity. It
installs N-1, verifies and temporarily promotes signed N, observes the N
entrypoint, forces the post-promote check to fail, and verifies the atomic
pointer returned to N-1. It also rejects tamper, downgrade, and traversal
fixtures, compares device-state digests, destroys its private-key fixture, and
removes every task-owned temporary path.

Never point this command at an actual Runner state directory or user
installation.
