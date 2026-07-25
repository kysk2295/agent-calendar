# Clean-account Runner ETE revalidation evidence

- Date: 2026-07-25
- Result: Pass
- Surface: production-mode Electron + ephemeral PostgreSQL + real Runner process

## Phase 2 Runner enrollment

Command:

`node apps/desktop/tests/playwright-phase2-runner-enrollment-e2e.cjs`

Observed:

- Authenticated clean account entered Runner Setup from the first-run guide.
- The 273×273 captured QR decoded to the exact one-use enrollment payload.
- Owner fingerprint confirmation, capability report, connection test, disconnect,
  reconnect, credential rotation, revoke, old-credential denial, and revoked UI passed.
- Duration: 13.8s.

Artifacts:

- `apps/desktop/test-results/phase2-runner-enrollment/setup-code-qr.png`
- `apps/desktop/test-results/phase2-runner-enrollment/qr-element.png`
- `apps/desktop/test-results/phase2-runner-enrollment/disconnected.png`
- `apps/desktop/test-results/phase2-runner-enrollment/reconnected.png`
- `apps/desktop/test-results/phase2-runner-enrollment/revoked-setup.png`

## Phase 3 golden ETE

Command:

`node apps/desktop/tests/playwright-phase3-golden-ete.cjs`

Observed:

- Login completion count: 1.
- Backend restart: passed.
- Desktop restart: passed without login replay.
- Runner reconnect: passed.
- Completed terminal attempts: exactly 1.
- Agent-work Calendar projections: exactly 1.
- Queued, live, completed, Calendar, and rehydrated screenshots had distinct hashes.
- Duration: 27.8s.

Artifacts:

- `apps/desktop/test-results/phase3-golden-ete/queued-waiting.png`
- `apps/desktop/test-results/phase3-golden-ete/live-checkpoint.png`
- `apps/desktop/test-results/phase3-golden-ete/completed-result.png`
- `apps/desktop/test-results/phase3-golden-ete/calendar-projection.png`
- `apps/desktop/test-results/phase3-golden-ete/restart-rehydrated.png`

## Regression gates

- `npm run backend:check`: pass.
- `npm run test:backend`: pass.
- `npm --workspace apps/desktop run test`: 261 passed.
- `npm --workspace apps/runner run test`: 29 passed.
- `npm test`: pass.
- `git diff --check`: pass.

One initial parallel Backend suite run observed the Phase 6 Runner-completion timing test
returning null. Its focused rerun passed, the full Backend suite then passed 457/457, and the
final root `npm test` passed. No production behavior or assertion was weakened for that
transient result.

## External gates not claimed

- Live WorkOS tenant and dashboard configuration.
- Release-candidate enrollment from an ordinary user-owned Runner host. The product does not
  depend on a shared Mac mini; every OAuth-authenticated Workspace enrolls its own Runner.
- Codex, Claude, and Hermes now pass the same clean-account product ETE on the current
  non-production MacBook Pro. Grok is authenticated but its current Build usage balance is
  exhausted. Its truthful `quota_exhausted` failure ETE passes with one failed attempt,
  zero Calendar projections, Desktop restart rehydration, and Runner reconnect. Successful
  Grok generation coverage remains open; see
  `docs/operations/evidence/2026-07-25-live-runner-engine-readiness.md`.
- Signed/notarized public Runner and Desktop distribution.
