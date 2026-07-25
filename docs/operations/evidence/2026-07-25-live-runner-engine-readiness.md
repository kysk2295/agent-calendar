# Live Runner Engine readiness evidence

- Date: 2026-07-25
- Host scope: current non-production MacBook Pro (`Mac15,6`)
- Result: Codex, Claude, Hermes live smoke and clean-account product ETE pass;
  Grok truthful quota-failure product ETE passes; Grok successful generation remains
  externally blocked by usage balance

The host is an ordinary user-owned Runner test host, not a control-plane dependency.
Production users enroll their own account-bound Runner after OAuth login; no shared Mac mini
or operator-owned machine is part of the tenant isolation model.

## Public capability report

Only non-secret capability fields were retained.

| Engine | Version | Installed | Authentication probe | Stream contract |
| --- | --- | --- | --- | --- |
| Codex | `0.145.0` | yes | authenticated | JSONL checkpoints |
| Claude | `2.1.153` | yes | authenticated | stream-json checkpoints |
| Grok | `0.2.112` | yes | authenticated | batch, no stable stream schema claimed |
| Hermes | `0.18.2` | yes | authenticated | batch, no stable stream schema claimed |

An installed/version-only result no longer marks an Engine available. Codex and Claude use
their explicit authentication status commands. Grok model discovery and Hermes provider status
are interpreted without retaining provider labels, account identifiers, tokens, or raw output.
An unavailable Engine keeps its authentication failure message even after adapter capability
metadata is merged.

## Bounded live adapter smoke

Each Engine received the same no-tool, no-file-mutation prompt in an isolated temporary working
directory. Evidence retained only success, public error code, checkpoint phases, artifact count,
resume support, and duration.

| Engine | Result | Public outcome |
| --- | --- | --- |
| Codex | pass | plan → progress → result, curated artifact, resumable thread |
| Claude | pass | plan → progress → result, curated artifact, resumable session |
| Grok | blocked | `quota_exhausted`, non-retryable until usage balance is restored |
| Hermes | pass | plan → result, batch artifact |

The first live run exposed two real installed-version argument mismatches:

- Codex rejected an isolated non-Git working directory. The adapter now uses the supported
  `--skip-git-repo-check` together with `workspace-write` sandboxing.
- Claude required `--verbose` for `--print --output-format stream-json`.

Grok's installed CLI accepted the current prompt-file, JSON, default permission,
no-subagent, and no-web-search arguments. The provider then returned HTTP 402 because the
current Grok Build usage balance is exhausted. The adapter now reports `quota_exhausted`
instead of the ambiguous `grok_exit`.

## Clean-account live Engine product ETE

Commands:

`AGENT_CALENDAR_E2E_LIVE_ENGINE=codex node apps/desktop/tests/playwright-phase3-golden-ete.cjs`

`AGENT_CALENDAR_E2E_LIVE_ENGINE=claude node apps/desktop/tests/playwright-phase3-golden-ete.cjs`

`AGENT_CALENDAR_E2E_LIVE_ENGINE=hermes node apps/desktop/tests/playwright-phase3-golden-ete.cjs`

`AGENT_CALENDAR_E2E_LIVE_ENGINE=grok AGENT_CALENDAR_E2E_EXPECT_ERROR=quota_exhausted node apps/desktop/tests/playwright-phase3-golden-ete.cjs`

Observed through the real Electron surface for each Engine:

- clean AuthKit account completed login exactly once;
- a clean Runner enrolled, confirmed its fingerprint, connected, and reported real capabilities;
- Desktop explicitly selected the requested real Engine rather than the Fake Engine;
- accepted, lease, plan, progress, result, and Calendar projection were visible;
- Backend restarted after acceptance and before the lease;
- Desktop restarted after completion without replaying login;
- Runner reconnected after restart;
- exactly one terminal attempt and one Calendar projection remained;
- the resolved Execution Engine remained the requested Engine after rehydration.

Final results:

| Engine | Duration | Login completions | Terminal attempts | Calendar projections | Artifacts |
| --- | ---: | ---: | ---: | ---: | --- |
| Codex | 29.3s | 1 | 1 | 1 | `apps/desktop/test-results/phase3-golden-ete-codex` |
| Claude | 35.3s | 1 | 1 | 1 | `apps/desktop/test-results/phase3-golden-ete-claude` |
| Hermes | 23.5s | 1 | 1 | 1 | `apps/desktop/test-results/phase3-golden-ete-hermes` |
| Grok quota failure | 29.8s | 1 | 1 failed | 0 | `apps/desktop/test-results/phase3-golden-ete-grok-failure` |

Every variant produced five distinct queued, live, completed, Calendar, and rehydrated screenshot
hashes. The deterministic Fake Engine variant also passed after the harness was strengthened.

The real Grok HTTP 402 path additionally proves that the terminal failure updates the
Workspace-owned Delegated Work and Work Conversation to failed, retains the resolved Grok
Engine, shows `quota_exhausted`, survives Desktop restart and Runner reconnect, and never creates
a successful Calendar projection. This is failure-path readiness evidence, not a successful
Grok generation claim.

## Manual QA finding and repair

The first Codex completed-result screenshot showed an absolute host path inside an internal
warning. The Engine boundary now removes macOS, Linux, Windows, and macOS temporary user paths
from every adapter's public checkpoint and artifact text. Codex `item.type=error` setup warnings
and empty `turn.started` protocol noise are no longer projected as Work Checkpoints.

Claude's first screenshot showed an empty `rate_limit_event` as the generic `Claude event`.
Real stream-json inspection showed system hook events, init, assistant, rate-limit, and result
records. Empty hook/rate-limit protocol events are now omitted while init, assistant text, and
result remain visible.

The first Engine-specific completion assertion also matched `ENGINE_OK` inside the work title
before the result reached the timeline. The ETE now scopes the assertion to
`.agent-work-timeline` and requires the Engine-specific terminal checkpoint. This prevented a
status-only or title-only false pass.

Provider thread/session identifiers remain in the internal resume contract but are removed from
public completion checkpoints.

The final observed result surfaces contain the selected Engine, curated plan/progress/result, and
no host path, provider credential, raw stream record, internal setup warning, or provider
thread/session identifier:

`apps/desktop/test-results/phase3-golden-ete-codex/completed-result.png`

`apps/desktop/test-results/phase3-golden-ete-claude/completed-result.png`

`apps/desktop/test-results/phase3-golden-ete-hermes/completed-result.png`

The Calendar surface contains one source-aware Agent result:

`apps/desktop/test-results/phase3-golden-ete-codex/calendar-projection.png`

The Grok failure surface and empty Calendar projection are:

`apps/desktop/test-results/phase3-golden-ete-grok-failure/failed-result.png`

`apps/desktop/test-results/phase3-golden-ete-grok-failure/calendar-no-projection.png`

`apps/desktop/test-results/phase3-golden-ete-grok-failure/restart-rehydrated.png`

## Verification

- RED/GREEN focused adapter contracts:
  - current Codex and Claude argv
  - Grok quota classification
  - unavailable authentication message preservation
  - cross-platform private-path redaction
  - Codex internal protocol-noise suppression
- RED/GREEN terminal-failure projection contract:
  - durable job stays internally `failed` or `dead_letter`
  - Workspace-owned Delegated Work and Work Conversation become `failed`
  - bounded public error code/message and resolved Engine survive rehydration
  - failed work creates no Calendar result
- `npm run runner:check`: pass
- Runner tests: 29/29 pass
- Desktop onboarding/Runner readiness tests: pass
- Backend Phase 2 Runner and Phase 3 durable execution matrices: pass
- Root `npm test`: pass; Desktop 261/261 and Runner 29/29
- deterministic Fake Engine clean-account ETE after live-mode parameterization: pass
- live Codex, Claude, and Hermes clean-account ETE variants: pass
- live Grok `quota_exhausted` failure, restart, reconnect, and no-projection ETE: pass
- Desktop typecheck and build: pass as part of the ETE runs

## Open external gates

- A release-candidate user-owned Runner host must enroll as a fresh account-bound Runner and
  repeat the release ETE. This host may be a Mac, Windows PC, Linux machine, or server supported
  by the distribution; it is not a shared service dependency.
- Grok Build usage balance must be restored, followed by a bounded live smoke and product ETE.
- Live WorkOS tenant/dashboard configuration and signed/notarized public Runner distribution
  remain separate production gates.
