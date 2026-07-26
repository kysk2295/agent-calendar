# Provider Session Interruption Correction Evidence

- Captured: 2026-07-25
- Scope: provider-session early binding, Runner restart replay, Runner-local provider identity,
  safe tool checkpoints, single-account live Codex surface
- Result: CORRECTIVE SLICE PASS; full two-account release gate remains open

## Why the prior completion claim was withdrawn

The earlier two-account journey isolated Agent Calendar Workspace and Runner rows, but both logical
Runners could read the same host-default `CODEX_HOME`. A newly created provider session identity was
also written to the Gateway only at terminal completion. Interruption after provider acceptance but
before completion could therefore lose the mapping and allow a later retry to create another
session.

The earlier evidence remains regression evidence only:
`docs/operations/evidence/2026-07-25-provider-native-agent-session-bridge.md`.

## Corrected contract

- Codex and Claude report the external session identity on the first checkpoint where it is known.
- The Runner first stores that identity in its owner-only active-attempt state.
- The Runner then calls
  `POST /api/runner/device/provider-session/bind` before posting the checkpoint or terminal result.
- The Gateway binds only the exact Workspace + Runner + provider-session row under a row lock.
- An existing external identity cannot be replaced. Terminal missing, deleted, auth-required,
  quota-exhausted, or archived sessions cannot be silently resurrected.
- Secret-shaped external identity input is rejected before bind, complete, or failure persistence.
- If the process is interrupted with a locally captured identity, Runner startup replays the bind
  before requesting another offer.
- Provider discovery and provider CLI child processes inherit the individual Runner's `HOME`,
  `CODEX_HOME`, and `CLAUDE_CONFIG_DIR`.
- Tool history contains only a curated provider/tool label and optional exit status. Raw commands,
  output, file paths, provider identifiers, tokens, and credentials are not persisted or returned.

## Focused TDD verification

- Backend real PostgreSQL + loopback HTTP:
  - provider session binds before terminal completion;
  - same-Workspace Runner replay succeeds;
  - foreign Workspace Runner bind returns 404;
  - secret-shaped external identity bind returns 400 and leaves the mapping empty;
  - follow-up and restart retain the same external session identity.
- Runner:
  - early bind happens before event and completion;
  - locally captured binding is restored before the next offer;
  - two connectors with different `CODEX_HOME` values enumerate only their own agent metadata;
  - Codex and Claude tool parsers omit raw command, output, secret, and host path data.
- Desktop:
  - curated `tool` checkpoints render in Work Conversation;
  - legacy raw `tool_activity` records remain excluded.

Focused results:

- Backend provider-session route and durable continuity: 2/2 pass.
- Backend route lifecycle: 9/9 pass.
- Runner continuity, connector, and engine focused tests: 35/35 pass.
- Desktop Work Conversation focused tests: 18/18 pass.
- Backend syntax, Runner syntax, Desktop typecheck, and Desktop build: pass.
- Full `npm test`: exit 0.
  - Desktop: 274/274 pass.
  - Runner: 46/46 pass.
  - Backend suite: pass.

## Actual single-account Codex Electron ETE

Command:

`AGENT_CALENDAR_E2E_LIVE_ENGINE=codex AGENT_CALENDAR_E2E_TIMEOUT_MS=900000 node apps/desktop/tests/playwright-phase3-golden-ete.cjs`

Observed:

- duration: 48,525 ms;
- one clean local test account and Workspace;
- real Runner enrollment and authenticated local Codex engine;
- provider agent catalog queried by the actual Runner CLI process and one agent imported;
- existing provider session imported and continued;
- follow-up delivered to the same external session identity;
- actual read-only Codex shell tool use observed as a curated `Codex 도구` checkpoint;
- `codex-result.txt` artifact and Unified Calendar result observed;
- Gateway and Electron restart restored the same session, chat, tool checkpoint, artifact, and
  calendar projection without another login;
- completed attempts: 2; failed attempts: 0;
- durable tool payload contained no raw `printf` command or host path.

Surface artifacts:

- `apps/desktop/test-results/phase3-golden-ete-codex/provider-session-continued.png`
- `apps/desktop/test-results/phase3-golden-ete-codex/provider-session-rehydrated.png`

## Open release gate

This is not full agent-feature completion evidence.

- The Electron identity in this run is `workos_authkit_test_adapter`, not production WorkOS.
- Strict two-account live mode now requires two distinct existing authenticated directories:
  `AGENT_CALENDAR_E2E_CODEX_HOME_A` and `AGENT_CALENDAR_E2E_CODEX_HOME_B`.
- Those two independent provider identities were not available in this environment, so the
  required two-account provider credential/profile/session ETE was not run.
- Hermes and Grok remain honest limited batch/resume capabilities until a stable machine-readable
  new-session identity stream is verified. Their live success matrix still requires the user's own
  authenticated Runner installations.
- Direct accessibility inspection of the installed Argo window remained unavailable even though
  macOS reported Accessibility and Screenshot permissions granted. The supplied Argo screenshot
  and previously recorded interaction evidence remain the visual benchmark.
- Mobile was not started.
