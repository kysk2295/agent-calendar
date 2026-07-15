# Agent Calendar Personal Beta Release

This runbook releases the single-owner Agent Calendar desktop and Railway gateway.
It does not describe a public, multi-user service.

## Current Release Candidate

- Source base: `6b0397434e73788424d99e6deb3f87e14912873d` plus the reviewed working-tree release diff
- Railway deployment: `979fff60-ec11-4851-b245-6f503d55c352`
- Railway image: `sha256:000f00370bca74a12d296a920414a373ad0e1ba140284edf9c9e65b0e44d1920`
- Railway rollback candidate: `6923a5b2-016a-4683-b3fb-3cb8ef72cddc` with Telegram disabled
- Mac mini cancellation backup: `work/beta-runtime-cancellation-backup-20260715T213935`
- DMG SHA-256: `442b0b193acbc7f344096d74160216dbb0f8396a0458714fb6f1927e5e569cb5`
- ZIP SHA-256: `c29cbd47612b56428b48598aae9fa88da9faea1dd3168d8964830abf9566097a`

The current source is not yet a Git commit. Do not advance or share the beta until a
reviewed release commit makes this snapshot reproducible.

## Release Gates

Run from the repository root with a clean dependency install:

```bash
npm ci
npm run verify:beta
```

`verify:beta` checks backend syntax, desktop types, backend and desktop contracts,
and the production desktop build. It does not contact Railway, Mac mini Hermes, or
Telegram and therefore needs no production secrets.

Before packaging, confirm that at least one valid macOS code-signing identity is
available:

```bash
security find-identity -v -p codesigning
```

Build the personal arm64 beta:

```bash
npm --workspace apps/desktop run dist:mac
```

The build fails instead of silently producing an unsigned application. Output is
written to `apps/desktop/release/` and includes DMG and ZIP artifacts.

## Artifact Verification

Verify the exact app bundle produced by electron-builder before distributing it:

```bash
codesign --verify --deep --strict --verbose=2 "apps/desktop/release/mac-arm64/Agent Calendar.app"
codesign -d --entitlements :- "apps/desktop/release/mac-arm64/Agent Calendar.app"
spctl --assess --type execute --verbose=4 "apps/desktop/release/mac-arm64/Agent Calendar.app"
shasum -a 256 apps/desktop/release/*.dmg apps/desktop/release/*.zip
```

`codesign --verify` is required for the personal beta. `spctl` is expected to
reject an Apple Development-signed or ad-hoc artifact for public Gatekeeper
distribution; record that result rather than treating it as a build failure.

Mount the DMG, copy the app to a temporary location or `/Applications`, launch it,
and observe all of the following:

- the production renderer opens without a development server;
- Railway hydration reports connected or an explicit recoverable error;
- Control Home opens and a Delegated Work can be selected;
- a Work Conversation survives close and relaunch;
- no uncaught error is appended to the app lifecycle log during the smoke flow.

## Railway Deployment

The desktop defaults to the production Railway gateway in Electron settings. Deploy
only after all local gates pass and record the source revision and last-known-good
deployment ID.

```bash
git rev-parse HEAD
railway status
railway up --detach
railway deployment list
```

After the deployment reaches success, verify the authenticated health, Agent
Operations daemon, bridge readiness, and one harmless selected-profile Delegated
Work. Never paste auth headers, relay secrets, raw prompts, or private evidence into
the release record.

The current candidate must report HTTP 200, deployment
`979fff60-ec11-4851-b245-6f503d55c352`, `runtimeAccessMode=relay`,
`effectiveRuntimeReachable=true`, an online bridge and live snapshot, and zero pending
or active relay jobs after smoke cleanup.

Required Railway configuration names are documented as names only:

- database and gateway authentication variables;
- `AGENT_OPERATIONS_DAEMON_ENABLED=true`;
- a bounded `AGENT_OPERATIONS_TICK_MS`;
- enabled outbound Hermes relay configuration;
- `HERMES_TELEGRAM_BOT_TOKEN` for the default `yunseoKo_bot` route;
- `HERMES_TELEGRAM_BOT_TOKEN_BIZCONSULTANT`;
- `HERMES_TELEGRAM_BOT_TOKEN_STOCKAGENT`;
- `HERMES_TELEGRAM_BOT_TOKEN_UNIPORTPM`;
- `HERMES_TELEGRAM_BOT_TOKEN_WIKICURATOR`;
- `HERMES_TELEGRAM_INGRESS_MODE=existing-poller` while the Mac mini Hermes poller owns ingress;
- `HERMES_TELEGRAM_ALLOWED_CHAT_IDS` for the shared owner-only gate.

## Telegram Acceptance

The owner has explicitly chosen to retain the existing five bot tokens instead of
rotating them. This is a beta security exception: never repeat the values in shell
output, logs, screenshots, documentation, or release evidence. Validate each token
with Bot API `getMe` before setting Railway variables, and fail closed if the returned
username does not match this routing contract:

| Responsible Agent | Telegram bot |
| --- | --- |
| `default` | `yunseoKo_bot` |
| `bizconsultant` | `Buzcunstalnt_bot` |
| `stockagent` | `Yunseo_analysistbot` |
| `uniportpm` | `yunseo_ko_grock_bot` |
| `wikicurator` | `Yunseo_wikibot` |

Confirm only configuration presence, never values:

```bash
railway variables --json | jq '{
  defaultBotConfigured: ((.HERMES_TELEGRAM_BOT_TOKEN // "") | length > 0),
  bizBotConfigured: ((.HERMES_TELEGRAM_BOT_TOKEN_BIZCONSULTANT // "") | length > 0),
  stockBotConfigured: ((.HERMES_TELEGRAM_BOT_TOKEN_STOCKAGENT // "") | length > 0),
  uniportBotConfigured: ((.HERMES_TELEGRAM_BOT_TOKEN_UNIPORTPM // "") | length > 0),
  wikiBotConfigured: ((.HERMES_TELEGRAM_BOT_TOKEN_WIKICURATOR // "") | length > 0),
  allowedChatConfigured: ((.HERMES_TELEGRAM_ALLOWED_CHAT_IDS // "") | length > 0)
}'
```

The owner already uses all five bots through the Mac mini Hermes long poller. Do not
register Railway webhooks or call `/start` to discover a chat. Recover the owner chat
from the existing Relay snapshot, require exactly one private chat, and validate it
with `getChat` from all five mapped bots before storing it. Never print the recovered ID.

With `HERMES_TELEGRAM_INGRESS_MODE=existing-poller`, the authenticated System Connections
bootstrap is safe to invoke because it must make zero `setWebhook` calls. Inspect only
the minimized coexistence state:

```bash
variables="$(railway variables --json)"
domain="$(jq -r '.RAILWAY_PUBLIC_DOMAIN' <<<"$variables")"
auth="$(jq -r '.HERMES_REMOTE_AUTH_TOKEN' <<<"$variables")"
curl -fsS -X POST -H "authorization: Bearer $auth" \
  "https://$domain/api/system/connections/bootstrap" \
  | jq '{telegram: {state: .telegram.state, connected: .telegram.connected,
    ingressMode: .telegram.ingressMode, deliveryReady: .telegram.deliveryReady,
    registered: .telegram.registered, registeredCount: .telegram.registeredCount,
    webhookUrl: .telegram.webhookUrl,
    configuredAgentIds: .telegram.configuredAgentIds,
    allowedChatCount: .telegram.allowedChatCount}}'
unset auth variables
```

Current-owner acceptance requires `state=ready`, `ingressMode=existing-poller`,
`deliveryReady=true`, `registeredCount=0`, an empty webhook URL, one allowed owner chat,
the five expected agent IDs, and no raw credential or chat ID in the response. A missing
agent-specific token is not replaced with the default token. `getWebhookInfo` must remain
empty for all five bots before and after delivery checks.

Only an installation with no existing Telegram consumer may explicitly select `webhook`.
That separate mode registers five token-derived secrets and requires
`registeredCount=5`; it is not the mode used by this owner deployment.

Each public webhook in the opt-in webhook mode rejects missing or incorrect Telegram
secret headers with HTTP 401 before recording an update. In the current existing-poller
deployment, trigger one safe report from each Responsible Agent only after the shared
allowlist and empty webhook state are confirmed. Each received message must come from
its mapped bot and contain a concise title,
limited findings, at most one limitation, and an `agent-calendar://` deep link. It
must not contain the evidence bundle, credentials, private filesystem paths, hidden
reasoning, raw relay logs, or runtime identifiers.

The formatter enforces bounded field budgets below Telegram's 4,096-character
`sendMessage` limit and redacts Telegram-shaped raw credentials at both persistence
and outbound-summary boundaries. Still inspect the actual owner message before closing
the acceptance gate.

If delivery fails, the report remains complete and only its delivery state becomes
`failed` or `not_configured`.

## Public Distribution Upgrade

An Apple Development identity is suitable for current-machine development and
personal testing, but not for public internet distribution. Public distribution
requires all of the following:

- Apple Developer Program membership;
- a `Developer ID Application` identity selected through `CSC_NAME` or `CSC_LINK`;
- hardened runtime, which is already enabled;
- one complete notarization credential set:
  - `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`; or
  - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`;
- successful notarization and stapling assessment.

Do not upload a personal-development artifact as if it were notarized.

## Rollback

### Backend

1. Stop new Agent Operations execution if runtime safety or persistence is uncertain.
2. In the Railway Deployments view, redeploy
   `6923a5b2-016a-4683-b3fb-3cb8ef72cddc` if the retained snapshot is available.
   This snapshot passed the runtime, taskless-resume, Telegram length, and raw-token
   redaction checks but predates webhook-secret authentication. Keep Telegram ingress
   and delivery disabled while it is active and restore the current forward fix before
   re-enabling either path.
3. Re-run health, daemon, relay, and persisted-state smoke checks.
4. Keep blocked work visible; do not rewrite it to completed.
5. If the retained snapshot is unavailable, do not improvise from an unreviewed tree;
   disable new execution and deploy from the reviewed release commit or its recorded patch.

### Desktop

1. Quit the beta application.
2. Reinstall the retained prior DMG or ZIP.
3. Preserve the existing Electron user-data directory unless a documented migration
   explicitly requires a backup/restore.
4. Confirm the prior app can hydrate the current backward-compatible server state.

### Mac mini Runtime

If the runtime cannot enforce safe toolsets, approvals, profile identity, or remote
cancellation, disable execution at the gateway and expose `blocked` or `unavailable`.
Never fall back silently to another Responsible Agent or Execution Engine.

The cancellation patch has a file-level backup under the runtime root:

```bash
cd /Users/goyunseo/.hermes/os-runtime
cp -p work/beta-runtime-cancellation-backup-20260715T213935/app/lib/command-runner.js app/lib/command-runner.js
cp -p work/beta-runtime-cancellation-backup-20260715T213935/app/lib/runner.js app/lib/runner.js
cp -p work/beta-runtime-cancellation-backup-20260715T213935/app/server.js app/server.js
cp -p work/beta-runtime-cancellation-backup-20260715T213935/scripts/hermes-railway-relay-bridge.js scripts/hermes-railway-relay-bridge.js
/Users/goyunseo/.hermes/node/bin/node --test tests/*.test.js
launchctl kickstart -k "gui/$(id -u)/xyz.hermes.os.runtime"
launchctl kickstart -k "gui/$(id -u)/com.yunseo.hermes-railway-relay"
```

This restores the state immediately before process-tree cancellation while retaining
the earlier safe-runtime contract. If that earlier safe contract itself is suspect,
do not restore the pre-safety behavior: keep execution disabled and apply a forward fix.

### Telegram

Preserve all five existing bot tokens and the Mac mini poller. If minimization, mapping,
or allowlist checks fail, remove only the Agent Calendar shared allowlist or disable its
outbound report delivery; report creation remains enabled with a separate delivery state.
Do not register a webhook and do not leave only the default token as an implicit fallback
for Responsible Agent reports.
