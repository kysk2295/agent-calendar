# Phase 10 Mobile entry gate

The repository-local evaluator is:

```sh
node apps/backend/tools/phase10-mobile-entry.cjs --evidence-dir <directory>
```

It reads `manifest.json` plus nine digest-bound criterion files. `contractComplete`
means only that the bounded schema and every criterion parser passed.
`mobileEntryReady` and `platformDecisionEligible` additionally require every
criterion to carry externally authorized evidence and a final unexpired Ed25519
envelope signed by the pinned production public root in
`apps/backend/app/lib/phase10-mobile-entry.js`.

The final envelope binds the manifest contract digest, all criterion evidence
digests and authority-receipt digests, source SHA, staging/production deployment
IDs, two Desktop and two Runner candidate IDs, evaluation/expiry timestamps,
private-beta chain root/reset state, evaluator schema, and legacy decision.
Caller keys, environment variables, command-line trust roots, manual booleans,
narrative sign-off, local receipts, tests, builds, and local contract fixtures
cannot grant production authority.

The evidence directory itself must be a real directory. The evaluator rejects a
symlinked root, any symlinked path component, terminal symlinks, lexical path
escape, canonical realpath escape, non-regular/oversized files, and detectable
rename or inode/size changes during a read. Criterion entries must appear once
in the schema-defined order.

The evaluator also pins the root device/inode/canonical path, intermediate
directory identities, and every file already read. It revalidates them before
and after each bounded read and immediately before returning. Root, criterion
parent, criterion file, symlink-substitution, and embedded-authority manifest
replacement fail without retrying onto the replacement state.

The evaluator is intentionally repository-local and read-only. It does not
contact services, create Mobile code, choose a platform, deploy, sign, publish,
or mutate production.

Manual QA uses exactly:

```sh
node apps/backend/tools/local-phase10-mobile-entry-qa.cjs --evidence-dir .omo/evidence/production-readiness-completion/task-20/repository-mobile-entry/manual-qa
```

The QA output is contract evidence only. It must always retain
`mobileEntryReady=false` and `platformDecisionEligible=false`.
It executes malformed/schema/oversize/path/symlink/order/duplicate/delete
cases, four evidence mutations for each of nine criteria, caller override and
authority-negative matrices, plus real SIGTERM/resume boundaries for manifest,
criterion, authority, root replacement, and final output.
