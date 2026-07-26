# Mac mini / Relay Runtime Inventory (Phase 0 Story 2)

- Date: 2026-07-24
- Status: Durable inventory + reconstruction runbook
- Parent plan: `docs/plans/2026-07-24-phase0-macmini-runtime-inventory.md`
- Safety rule: secret **names** and **storage locations** only. Never paste token values, cookies, private keys, credential file contents, raw host secrets, or customer wiki/content.

## 1. Topology (current personal deployment)

```text
Desktop / Railway control plane
        |  HERMES_RELAY_TOKEN (name only) + outbound Relay jobs
        v
Mac mini / customer host execution plane
  - Hermes OS Runtime (loopback :64369, LaunchAgent xyz.hermes.os.runtime)
  - Optional Cloudflare tunnel (LaunchAgent xyz.hermes.os.tunnel)
  - Railway Relay bridge (LaunchAgent com.yunseo.hermes-railway-relay)  [expected on production Mac mini]
  - Wiki curator gateway (:8643) + calendar gateway (:8644)            [expected on production Mac mini]
  - Dashboard/read plane (:9121)                                       [expected on production Mac mini]
  - Ollama embeddings (:11434, model bge-m3)                           [expected when local embeddings used]
  - Hermes CLI profiles under $HERMES_HOME/profiles/*
```

Control plane source of truth for product state is Railway + Postgres. The Mac mini is the execution plane and is **not** fully source-controlled inside this repository.

## 2. Host roles observed 2026-07-24

| Role | Expected (docs / production Mac mini) | Observed on this probe host |
| --- | --- | --- |
| Probe host class | Dedicated Mac mini execution host | **MacBook Pro** (`darwin` `arm64`, macOS 26.5.2) |
| Hermes OS Runtime package | `hermes-os-runtime` under `$HOME/.hermes/os-runtime` | **present** — package name `hermes-os-runtime`, version `0.1.0` |
| Public loopback health `:64369` | online | **online** — `name=Hermes OS Runtime`, node runtime process reports Node `v22.17.0` |
| Dashboard `:9121` | online on production Mac mini | **unreachable** (`fetch failed`) |
| Wiki curator gateway `:8643` | online on production Mac mini | **unreachable** |
| Calendar gateway `:8644` | online on production Mac mini | **unreachable** |
| Ollama `:11434` | online when embeddings/local LLM used | **unreachable** (CLI installed; daemon not listening) |
| Railway Relay bridge script | `$HOME/.hermes/os-runtime/scripts/hermes-railway-relay-bridge.js` | **absent** on this host |
| Documented execution-host path templates | `$HOME/.hermes/...` and `$HERMES_HOME/...` only | **partial** — probe host is not the full production layout |

### Concrete live blocker

Full production Mac mini inventory cannot be completed from this session because:

1. Documented production execution-host layout (relay bridge + curator/calendar gateways) is incomplete on this probe host.
2. Ports `9121`, `8643`, `8644`, and `11434` are not listening.
3. LaunchAgents `com.yunseo.hermes-railway-relay`, `ai.hermes.gateway-wikicurator`, and `ai.hermes.gateway-calendarassistant` are not loaded.
4. No authenticated remote Mac mini / Railway bridge probe was performed (would require secret values).

**Blocker ID:** `P0-S2-MACMINI-HOST-UNREACHABLE`
**Unblock with:** read-only probe on the actual Mac mini host (or a tunnel that exposes only non-secret health endpoints), recording presence of the expected LaunchAgents, ports, profiles, and Hermes CLI versions without printing secrets.

## 3. Official profiles and engines

### 3.1 Product-official Hermes profiles

Source of truth in-repo: `apps/backend/app/lib/official-profiles.js`

| Profile ID | Product role | Expected on Mac mini |
| --- | --- | --- |
| `default` | Default Responsible Agent | profile dir + gateway |
| `bizconsultant` | Business consultant work | profile dir + gateway |
| `stockagent` | Market / analysis work | profile dir + gateway |
| `uniportpm` | UniPort PM work | profile dir + gateway |
| `wikicurator` | Wiki AI Q&A (file toolset only for API Q&A) | profile dir + gateway `:8643` |

Additional calendar synthesis profile used by runtime docs (not in the five official product agents list):

| Profile ID | Role |
| --- | --- |
| `calendarassistant` | Calendar natural-language synthesis; no toolsets; `openai-codex` / `gpt-5.5` |

### 3.2 Observed profile directories on this host

| Profile | Present |
| --- | --- |
| `default` | absent |
| `bizconsultant` | absent |
| `stockagent` | present |
| `uniportpm` | present |
| `wikicurator` | absent |
| `calendarassistant` | absent |
| `marketflow` | present (extra local profile; not in official product list) |

Observed model provider keys in present profile configs (values not dumped beyond provider/base_url labels):

- `provider: openai-codex`
- `base_url: https://openrouter.ai/api/v1` (label only; no API keys recorded)

### 3.3 Execution engines (product vocabulary)

| Engine label | Where it runs | Credential ownership | Inventory note |
| --- | --- | --- | --- |
| Hermes CLI profiles | Mac mini / customer host | Customer Hermes install + profile configs | Official IDs above |
| Codex (`openai-codex`) | Provider via profile model pin | Customer provider login / OpenRouter-style config | Documented pin for wiki/calendar agents |
| Claude | Future/optional Runner Adapter | Customer CLI/account on Runner | Not a separate Mac mini LaunchAgent in current inventory |
| Grok | Usage tracking roots only today | Customer host usage files | Env names `HERMES_GROK_USAGE_ROOT`, `HERMES_GROK_USAGE_MAX_FILES` |
| Local Ollama embeddings | Mac mini `:11434` | Local model weights | Model id `bge-m3` (1024-d wiki/calendar indexes) |

Product policy: no silent Engine/Runner fallback across providers.

### 3.4 Hermes CLI version observed on this host

- Hermes Agent `v0.18.2 (2026.7.7.2)`
- Install method: `git` under `$HOME/.hermes/hermes-agent`
- Binary: `$HOME/.hermes/hermes-agent/venv/bin/hermes`

## 4. Ports and LaunchAgents

| Port | Service | Expected LaunchAgent / process |
| ---: | --- | --- |
| 64369 | Hermes OS Runtime HTTP | `xyz.hermes.os.runtime` (this host: **running**) |
| tunnel | Public tunnel to runtime | `xyz.hermes.os.tunnel` (this host: **running**) |
| 9121 | Dashboard / read plane | production Mac mini only (this host: absent) |
| 8643 | Wiki curator gateway | `ai.hermes.gateway-wikicurator` (absent here) |
| 8644 | Calendar gateway | `ai.hermes.gateway-calendarassistant` (absent here) |
| 11434 | Ollama | local Ollama service (CLI present; not listening) |

Other LaunchAgent names from product docs:

- `xyz.hermes.os` — older single-service label (not loaded on this host)
- `com.yunseo.hermes-railway-relay` — Railway Relay bridge (not loaded on this host)

## 5. Filesystem layout (path templates only)

Use `$HOME` / `$HERMES_HOME` templates. Do not commit machine-specific customer content paths into evidence.

| Path template | Purpose |
| --- | --- |
| `$HOME/.hermes/hermes-agent/` | Hermes Agent install (venv + CLI) |
| `$HOME/.hermes/hermes-agent/venv/bin/hermes` | Hermes CLI binary |
| `$HOME/.hermes/os-runtime/` | Hermes OS Runtime package (out of repo) |
| `$HOME/.hermes/os-runtime/scripts/install-macmini-resident.sh` | Resident install |
| `$HOME/.hermes/os-runtime/scripts/macmini-hermes-connector.sh` | Connector / env bootstrap |
| `$HOME/.hermes/os-runtime/scripts/apply-runtime-update.sh` | Runtime update apply |
| `$HOME/.hermes/os-runtime/scripts/hermes-railway-relay-bridge.js` | Railway Relay bridge (expected; absent on this host) |
| `$HOME/.hermes/profiles/<profileId>/` | Profile home (`config.yaml`, `SOUL.md`, `sessions`, …) |
| `$HOME/.hermes/cache/agent-calendar-wiki-vectors.json` | Wiki vector index (expected) |
| `$HOME/.hermes/cache/agent-calendar-schedule-vectors.json` | Calendar vector index (expected) |
| `$HOME/Library/LaunchAgents/xyz.hermes.os.runtime.plist` | Runtime LaunchAgent |
| `$HOME/Library/LaunchAgents/xyz.hermes.os.tunnel.plist` | Tunnel LaunchAgent |
| `$HOME/Library/LaunchAgents/com.yunseo.hermes-railway-relay.plist` | Relay bridge LaunchAgent (expected) |
| `$HOME/Library/LaunchAgents/ai.hermes.gateway-wikicurator.plist` | Wiki gateway LaunchAgent (expected) |
| `$HOME/Library/LaunchAgents/ai.hermes.gateway-calendarassistant.plist` | Calendar gateway LaunchAgent (expected) |
| repo `docs/operations/macmini-runtime-cancellation.patch` | Operational patch reference |
| repo `docs/operations/macmini-relay-profile-chat-cancellation.patch` | Relay cancellation patch reference |
| repo `docs/operations/macmini-session-turn-vector-runtime.md` | Session-turn / vector runtime contract |

Portable inventory language only:

- Prefer `$HOME`, `$HERMES_HOME`, and `$HERMES_RUNTIME_DIR` templates.
- Describe the production execution host as **legacy owner home** / **execution host**, never with a personal username or raw absolute home path.

## 6. Secret registry (names and storage only)

Record configuration presence only (`configured` / `missing`). Never store values here.

### 6.1 Railway / control plane

| Secret or config name | Storage location | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Railway variables | Postgres |
| `HERMES_REMOTE_AUTH_TOKEN` | Railway variables; also Mac mini connector env file | Caller/runtime auth |
| `HERMES_RUNTIME_URL` | Railway variables | Direct runtime URL when not relay-only |
| `HERMES_RUNTIME_TOKEN` | Railway variables | Runtime bearer |
| `HERMES_RELAY_TOKEN` / `HERMES_BRIDGE_TOKEN` | Railway variables + bridge process env | Relay bridge auth |
| `HERMES_RELAY_ENABLED` | Railway variables | Relay on/off (`1`/`0`) |
| `AGENT_OPERATIONS_DAEMON_ENABLED` | Railway variables | Agent Operations daemon |
| `AGENT_OPERATIONS_TICK_MS` | Railway variables | Daemon tick interval |
| `HERMES_TELEGRAM_BOT_TOKEN` | Railway variables | default bot |
| `HERMES_TELEGRAM_BOT_TOKEN_BIZCONSULTANT` | Railway variables | bizconsultant bot |
| `HERMES_TELEGRAM_BOT_TOKEN_STOCKAGENT` | Railway variables | stockagent bot |
| `HERMES_TELEGRAM_BOT_TOKEN_UNIPORTPM` | Railway variables | uniportpm bot |
| `HERMES_TELEGRAM_BOT_TOKEN_WIKICURATOR` | Railway variables | wikicurator bot |
| `HERMES_TELEGRAM_ALLOWED_CHAT_IDS` | Railway variables | owner allowlist |
| `HERMES_TELEGRAM_INGRESS_MODE` | Railway variables | `existing-poller` for current owner |
| `OPENAI_API_KEY` / `HERMES_OPENAI_API_KEY` / `AGENT_CALENDAR_OPENAI_API_KEY` | Railway or host env | cloud model (if used) |
| OAuth proxy keys (`*_OPENAI_OAUTH_PROXY_API_KEY`) | Railway variables | OAuth proxy |
| TickTick tokens (`HERMES_TICKTICK_*`) | Railway / secret store | calendar connector |
| `HERMES_MAIL_ACCOUNTS_JSON` | Railway / secret store | mail connector |

Presence check pattern (values never printed):

```bash
# Names only — replace with your secret manager's boolean presence API.
railway variables --json | jq 'with_entries(select(.key|test("TOKEN|SECRET|PASSWORD|DATABASE_URL|KEY"))) | map_values((. // "") | length > 0)'
```

### 6.2 Mac mini / host

| Secret or config name | Storage location | Purpose |
| --- | --- | --- |
| `HERMES_REMOTE_AUTH_TOKEN` | connector-generated env file under runtime work dir | runtime auth |
| Provider credentials for Codex/Claude/Grok/OpenRouter | OS keychain / Hermes profile config / provider CLI login | model calls |
| Telegram bot tokens (poller mode) | Mac mini Hermes poller config (not Railway webhook) when `existing-poller` | ingress |
| Tunnel credentials (`HERMES_CLOUDFLARED_TUNNEL_NAME` etc.) | host env / cloudflared config | public tunnel |

Local secret store used by backend tooling when running on-host:

- `work/hermes-os-data/secrets.json` (path template under runtime data dir) — never commit.

## 7. Connection and deployment inputs

### 7.1 Railway project identifiers (non-secret)

From `scripts/deploy-railway-main.sh` (public project/service IDs, not credentials):

| Field | Value |
| --- | --- |
| Project ID | `b64a9c8f-101e-4e08-9a7f-68fea0a4de9a` |
| Environment ID | `7629b09d-3447-4f74-9b06-2f9b8aafb80a` |
| Service ID | `b7bd75ff-cc24-4a6d-9387-1628fcaff9d6` |
| Expected source repo | `kysk2295/agent-calendar` |
| Healthcheck path | `/api/health` (`apps/backend/railway.json`) |
| Start command | `npm --workspace apps/backend run start` |

### 7.2 Desktop / control plane connection

- Desktop stores one Railway connection profile and forwards a caller bearer token through the local Electron proxy.
- Production path prefers Relay (`runtimeAccessMode=relay`) rather than direct Mac mini URL exposure when bridge is online.
- Personal beta runbook: `docs/operations/personal-beta-release.md`.

### 7.3 Runtime access modes

| Mode | When | Required names |
| --- | --- | --- |
| Relay | Preferred production | `HERMES_RELAY_TOKEN`, bridge online, Railway gateway |
| Direct runtime | Fallback / local | `HERMES_RUNTIME_URL`, `HERMES_RUNTIME_TOKEN` |
| Offline fallback | No runtime/relay | gateway local store; must not invent fake queued runs |

## 8. Reconstruction command checklist

Run on the **execution host**. Do not paste secret values into chat or commits.

### 8.1 Prerequisites

```bash
# Tooling
node -v   # expect 22.x for product; local probe may differ
npm -v
command -v hermes || test -x "$HOME/.hermes/hermes-agent/venv/bin/hermes"
command -v ollama || true
command -v cloudflared || true
```

### 8.2 Install / refresh resident runtime (names only)

```bash
cd "${HERMES_RUNTIME_DIR:-$HOME/.hermes/os-runtime}"
# Review scripts first; do not run install commands during inventory-only work.
# Reconstruction (operator action, not this agent session):
#   bash scripts/macmini-hermes-connector.sh
#   bash scripts/install-macmini-resident.sh
# launchctl print gui/$UID/xyz.hermes.os.runtime
# launchctl print gui/$UID/xyz.hermes.os.tunnel
```

### 8.3 Profiles

```bash
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
export HERMES_CLI_PATH="${HERMES_CLI_PATH:-$HERMES_HOME/hermes-agent/venv/bin/hermes}"
"$HERMES_CLI_PATH" --version
# Expect official profile directories:
for p in default bizconsultant stockagent uniportpm wikicurator calendarassistant; do
  test -d "$HERMES_HOME/profiles/$p" && echo "present $p" || echo "missing $p"
done
# Profile list (text table only; do not dump tokens from configs):
"$HERMES_CLI_PATH" profile list 2>/dev/null || true
```

### 8.4 Safe product command template

Product-safe Hermes runner template (must not use `--yolo` or terminal toolset):

```text
hermes -p <profileId> chat -q "$HERMES_GOAL" -Q -t safe --source tool
```

Note: historical connector defaults may still mention unsafe templates. Product code rejects unsafe profile commands (`apps/backend/tests/hermes-runtime-safety.test.cjs`). Reconstruction must set `HERMES_RUNNER_COMMAND` to a safe template.

### 8.5 Railway bridge (production Mac mini)

```bash
# Expected bridge entry (path template):
test -f "$HOME/.hermes/os-runtime/scripts/hermes-railway-relay-bridge.js" \
  && echo present || echo missing
# LaunchAgent expected label:
#   com.yunseo.hermes-railway-relay
# Env names required by bridge process:
#   HERMES_RELAY_TOKEN (or HERMES_BRIDGE_TOKEN)
#   Railway gateway base URL configuration used by bridge
# Read-only health from Railway after bridge is online:
#   GET /api/gateway-status → bridgeOnline=true (auth required; do not log bearer)
```

### 8.6 Wiki / calendar gateways and embeddings

```bash
# Expected local listeners on production Mac mini:
for port in 64369 9121 8643 8644 11434; do
  lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1 \
    && echo "listening $port" || echo "not-listening $port"
done
# Ollama model (name only):
#   ollama list | rg 'bge-m3' || true
```

### 8.7 Cancellation / operational patches

Repo-side patch references for reconstruction parity:

- `docs/operations/macmini-runtime-cancellation.patch`
- `docs/operations/macmini-relay-profile-chat-cancellation.patch`
- Evidence note: `docs/evidence/2026-07-15-personal-beta-release-candidate.md`

Backup path names historically used (do not assume present):

- `work/beta-runtime-cancellation-backup-20260715T213935`
- `work/beta-safe-runtime-backup-20260715T114303Z`

### 8.8 Railway deploy (control plane, not Mac mini)

```bash
# Clean main only; script refuses dirty trees.
# bash scripts/deploy-railway-main.sh
railway status
# Health:
# curl -fsS "https://<RAILWAY_PUBLIC_DOMAIN>/api/health"
```

## 9. Automated checker

Sanitized fixture:

- `docs/operations/fixtures/macmini-runtime-inventory.fixture.json`

Validate fixture (no network):

```bash
node apps/backend/tools/macmini-runtime-inventory-check.cjs \
  --fixture docs/operations/fixtures/macmini-runtime-inventory.fixture.json
```

Optional read-only local probe (redacts paths/secrets; does not mutate state):

```bash
node apps/backend/tools/macmini-runtime-inventory-check.cjs --probe
```

Unit tests:

```bash
node --test apps/backend/tests/macmini-runtime-inventory-check.test.cjs
```

## 10. Probe evidence log (2026-07-24, this host)

| Check | Result |
| --- | --- |
| Host class | MacBook Pro arm64 probe host; not the full production execution-host layout |
| `:64369` health | HTTP 200, `hermes-os-runtime` `0.1.0`, capabilities include `chat-stream`, `streaming-runner-logs` |
| Forbidden capability advertisement | **blocker** `P0-S2-UNSAFE-RUNTIME-CAPABILITY` when health lists `no-approval-runner` (or approval-bypass / yolo-style markers); capability list retained as evidence only; runtime is not mutated |
| `:64369` gateway-status without auth | HTTP 401 |
| `:9121` / `:8643` / `:8644` / `:11434` | unreachable |
| LaunchAgent `xyz.hermes.os.runtime` | running |
| LaunchAgent `xyz.hermes.os.tunnel` | running |
| LaunchAgent `xyz.hermes.os` | not loaded |
| Relay / curator / calendar LaunchAgents | not loaded |
| Official profiles complete set | **no** (only stockagent, uniportpm, marketflow present) |
| Relay bridge script | missing |
| Secret env names in current shell | mostly unset; do not record values for any set keys |

## 11. Remaining reconstruction gaps

1. Authenticated probe of the real production Mac mini (or tunnel-only non-secret health) for ports `9121/8643/8644/11434` and LaunchAgents `com.yunseo.hermes-railway-relay`, `ai.hermes.gateway-*`.
2. Clear `P0-S2-UNSAFE-RUNTIME-CAPABILITY` by reconfiguring the execution-host runtime so health capabilities never advertise `no-approval-runner`, approval-bypass, or yolo-style markers (inventory/checker only; this Story 2 slice does not mutate the runtime).
3. Confirm provider readiness evidence for Codex/Claude/Grok without capturing credentials.
4. Confirm Ollama `bge-m3` and vector index files on the execution host.
5. Confirm Railway variable presence booleans in a secure operator session (no value dumps).
6. Align connector default runner command with product-safe template during a later controlled repair (not this inventory slice).
