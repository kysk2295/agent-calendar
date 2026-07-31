# Private-beta stability evidence

This runbook describes a fail-closed repository contract for evaluating a future
private-beta stability window. It does not start that window, install a release, or
make Agent Calendar release-ready.

## Clock contract

- Timezone is exactly `UTC`.
- One daily window is exactly 86,400,000 milliseconds with canonical ISO `Z`
  boundaries.
- Readiness requires 28 consecutive non-overlapping daily windows, or 672 hours.
- A P0/P1 incident resets the clock at `openedAt`, even if it is later resolved.
- A qualifying release rollback resets the clock at its receipt `observedAt`.
- Pre-reset receipts remain in the integrity chain but never count toward the new
  window.
- Any non-ready result closes both signup and update offers.

This policy deliberately avoids local calendar days. DST-shortened or DST-lengthened
days, numeric offsets, duplicate boundaries, overlaps, gaps, partial days, and future
times fail closed.

## Evidence boundary

`manifest.json` binds the evaluator schema, redaction-safe cohort/operator digests,
candidate set, source ID and full source SHA, exact UTC window, P0/P1 authority
digest, reset policy, and requested authority mode. The requested authority mode is
not authority: caller-authored `external_signed_release` JSON fails closed.

Production authority additionally requires an Ed25519 envelope authenticated by the
repository-pinned public trust root:

- key ID: `private-beta-production-2026-01`;
- public SPKI SHA-256:
  `92eea827c8ff6c73bec344197c9084d569e4575a65020e7328abf62aed237013`;
- algorithm: Ed25519.

The corresponding private key was never stored in this repository, local QA, task
evidence, environment, or CLI input and is unavailable locally. There is no
trust-root, key, callback, environment, or argument override.

The signed envelope has a maximum one-hour lifetime and binds the authority-free manifest digest, final
receipt-chain root, both exact candidate/install identities, cohort/operator
authority digests, UTC window and reset/count state, evaluator schema, source ID,
and source SHA. Missing, malformed, self-signed, wrong-key, expired, or
binding-mismatched envelopes produce bounded `production_authority_*` reason codes.
Digest-shaped candidate fields alone never start the clock or authorize publication.

Receipts are owner-only JSON files in `receipts/`. The collector adds a monotonic
sequence, previous receipt digest, and SHA-256 receipt digest, then writes through an
owner-only temporary file, `fsync`, and atomic rename. A temporary/partial file is
never a receipt and blocks readiness.

Allowed receipt kinds are:

- `candidate_install`: exact candidate, distinct Desktop and Runner release IDs,
  signed-artifact receipt digests, verified-update receipt digests, source SHA, and
  `verified_update` installation path;
- `daily_evidence`: exact 24-hour window plus alert, support, backup, Runner, and
  update receipt digests;
- `weekly_review`: exact seven-day coverage plus support, backup, and update review
  digests;
- `incident`: only severity, timestamps, and a non-sensitive incident digest;
- `rollback`: only candidate ID, timestamp, bounded reason code, and receipt digest.

Narrative approval, `verified=true`, build success, raw identities, email, support or
incident text, URLs, credentials, tokens, and caller summaries are not schema fields
and cannot establish readiness.

## Repository CLI

Inputs are local owner-only JSON files, at most 64 KiB:

```sh
node apps/backend/tools/private-beta-stability.cjs init \
  --evidence-dir "$EVIDENCE_DIR" \
  --manifest-json "$MANIFEST_JSON"

node apps/backend/tools/private-beta-stability.cjs collect \
  --evidence-dir "$EVIDENCE_DIR" \
  --receipt-json "$RECEIPT_JSON"

node apps/backend/tools/private-beta-stability.cjs evaluate \
  --evidence-dir "$EVIDENCE_DIR" \
  --now "2026-06-01T00:00:00.000Z"
```

Evaluation exits 0 only for `privateBetaReady=true`, 2 for a valid but non-ready
evidence set, and 1 for CLI/input failure. Local contract simulations always return
`actualClockStarted=false` and `publicationEligible=false`. A local manifest that
merely requests external authority also returns `privateBetaReady=false`.

## Local contract QA

Run exactly:

```sh
node apps/backend/tools/local-private-beta-stability-qa.cjs \
  --evidence-dir .omo/evidence/production-readiness-completion/task-19/repository-private-beta/manual-qa
```

The QA creates only task-owned temporary receipt directories, evaluates the actual
collector/evaluator, records bounded JSON, and removes all runtime state. Its complete
fixture is explicitly `local_contract_only`; it is not signed release, cohort,
operator, provider, or elapsed-time evidence.

## Production prerequisites still absent

The real clock must not be marked started until all of these exist outside this local
simulation:

1. an exact redaction-safe named cohort and accountable operator;
2. two actual signed Desktop+Runner candidates installed through their verified
   production update paths;
3. independently retained daily alert/support/backup/Runner/update receipts;
4. weekly reviews from the declared authorities;
5. actual incident-free elapsed time covering the complete 28-day UTC window.

Until then, full Todo 19 remains incomplete, signup/update offers remain operationally
closed, and no local `privateBetaReady=true` result authorizes publication.
