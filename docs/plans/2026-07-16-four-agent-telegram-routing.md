# Plan: Default Plus Four-Agent Telegram Routing

- Date: 2026-07-16
- Owner: Codex
- Work size: Large / Boundary
- Status: Complete

## Goal

Agent Calendar의 default Telegram bot과 네 Responsible Agent(`bizconsultant`,
`stockagent`, `uniportpm`, `wikicurator`) 전용 봇으로 담당별 보고서 요약을 보낸다.
현재 소유자의 Mac mini Hermes가 이미 다섯 봇의 인바운드를 폴링하므로 Railway는
그 소비자를 유지하고 웹훅을 등록하지 않는다. 별도 폴러가 없는 설치에서는 명시적
webhook 모드가 다섯 봇의 인증·담당 에이전트·발신 경로를 끝까지 보존해야 한다.

## Non-Goals

- 봇을 삭제하거나 기존 토큰을 회전하지 않는다.
- 이미 운영 중인 Mac mini Telegram 폴러를 중단하거나 업데이트 소비권을 가져오지 않는다.
- `yunseo_ko_codex_bot` 같은 별도/과거 봇을 다섯 슬롯에 자동 편입하지 않는다.
- Telegram을 새 Execution Engine이나 Responsible Agent로 취급하지 않는다.
- 에이전트별 별도 허용 사용자 모델이나 멀티테넌트 권한 체계를 추가하지 않는다.
- 토큰·채팅 ID·웹훅 secret을 소스, 테스트 fixture, 문서, 로그에 기록하지 않는다.

## Work Size

환경변수 계약, 공개 웹훅 인증, 인바운드 담당 에이전트 라우팅, 보고서 발송,
Railway 부트스트랩과 운영 상태를 함께 바꾸는 Large / Boundary 작업이다.

## Touched Boundaries

- Backend gateway: `apps/backend/app/railway-gateway-server.js`
- Backend library: `apps/backend/app/lib/connectors/telegram.js`, 신규 Telegram routing seam
- DB/migrations: 기존 JSON 상태 메타만 확장하며 schema migration은 하지 않는다.
- Electron bridge: 변경하지 않는다.
- React UI: 기존 단일 Telegram 채널 표시에 안전한 configured-agent metadata만 추가할 수 있다.
- Tests: focused Telegram routing, release-blocker, Agent Operations delivery contracts
- Docs: Railway 변수 이름, 봇 매핑, 부트스트랩, 롤백 및 실제 수신 증거

## Configuration Contract

- `HERMES_TELEGRAM_BOT_TOKEN` is the required default route.
- `HERMES_TELEGRAM_BOT_TOKEN_BIZCONSULTANT`
- `HERMES_TELEGRAM_BOT_TOKEN_STOCKAGENT`
- `HERMES_TELEGRAM_BOT_TOKEN_UNIPORTPM`
- `HERMES_TELEGRAM_BOT_TOKEN_WIKICURATOR`
- `HERMES_TELEGRAM_ALLOWED_CHAT_IDS` remains the shared owner allowlist.
- `HERMES_TELEGRAM_INGRESS_MODE=existing-poller` preserves the owner's current Mac mini
  consumer and makes Railway webhook registration a no-op.
- For an installation explicitly using `webhook`, the default token keeps
  `/api/telegram/webhook`; each Responsible Agent token uses its own agent-specific route
  and is never replaced by the default token.

Deployment mapping to verify through Telegram `getMe`, without hardcoding usernames in product code:

- `default` → `yunseoKo_bot`
- `bizconsultant` → `Buzcunstalnt_bot`
- `stockagent` → `Yunseo_analysistbot`
- `uniportpm` → `yunseo_ko_grock_bot`
- `wikicurator` → `Yunseo_wikibot`

## Success Criteria

- [x] The default plus four configured bot tokens produce five distinct authenticated webhook registrations.
- [x] Existing-poller mode makes zero Bot API webhook calls and reports outbound delivery readiness separately.
- [x] A webhook accepted for one bot persists and executes with that bot's Responsible Agent ID.
- [x] A secret registered for one agent cannot authenticate another agent's webhook route.
- [x] An Agent Report is sent only through the token mapped to its mission's Responsible Agent.
- [x] Missing agent-specific configuration becomes `not_configured`; it never falls back to a different agent token.
- [x] Public connection/status responses expose configured agent IDs and counts but no token, chat ID, or derived secret.
- [x] The five existing tokens are read in memory without printing, validated with `getMe`, and staged in Railway without deploying.
- [x] Each live bot passes `getMe`, owner-chat validation, empty-webhook preservation, and one minimized safe-message receipt.

## Edge Cases

- One of four tokens is missing: the other three remain usable; the missing agent is reported separately.
- Token/agent mismatch: pre-deploy `getMe` mapping validation fails closed before Railway mutation.
- Cross-agent secret replay: HTTP 401 before parsing or storing the update.
- Default plus agent-specific tokens: default keeps only `/api/telegram/webhook`; agent routes use their own path.
- Same Telegram update ID on two bots: source identity includes the Responsible Agent route.
- Unknown route agent: HTTP 404/401 without revealing configured agent IDs or token state.
- One webhook registration fails: return per-agent status, retain successful registrations, and do not claim all connected.
- Existing poller owns ingress: skip registration entirely, expose `ingressMode=existing-poller`,
  and require a shared owner allowlist only for Agent Calendar report delivery.
- Unknown ingress mode: fail closed as `disabled`; never fall through to webhook registration.
- Report mission is missing or has an unsupported agent: delivery becomes `not_configured` without using another bot.
- Existing token is intentionally retained by owner request: record the residual exposure risk and do not represent token rotation as completed.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] Five env slots resolve to default plus four agent/token pairs without duplication.
  - [x] Five registrations use distinct agent webhook URLs and token-derived secrets.
  - [x] Cross-agent webhook secret replay is rejected and accepted updates retain `agentId`.
  - [x] Report delivery selects the mission agent token and fails closed for an unmapped agent.
  - [x] Public status projects agent IDs/counts without any credential material.
  - [x] Existing-poller bootstrap performs no Telegram API call and leaves stored webhook state untouched.
- GREEN:
  - [x] Add the smallest routing seam and gateway integration that satisfies each failing contract.
- REFACTOR:
  - [x] Remove duplicated single-token readiness/bootstrap branches only after focused tests stay green.

## Acceptance Gates

- [x] Focused Telegram routing tests
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm run verify:beta`
- [x] Railway deploy and sanitized connection/bootstrap smoke
- [x] Five live `getMe` identity checks without token output
- [x] Five live owner-only minimized-message receipts
- [x] Five empty `getWebhookInfo` checks before and after delivery smoke
- [x] Final repository/build secret-pattern scan
- [x] `git diff --check`

Skipped gates:

- Gate: token rotation
  - Reason: owner explicitly requires the existing tokens; this remains a documented security exception.

## Implementation Checklist

- [x] Step 1: Add failing pure routing and five-webhook registration contracts.
- [x] Step 2: Implement agent-token configuration resolution and distinct webhook paths.
- [x] Step 3: Add failing gateway ingress and report egress routing contracts.
- [x] Step 4: Implement authenticated agent-specific ingress and mission-agent report delivery.
- [x] Step 5: Project safe per-agent readiness and update operations documentation.
- [x] Step 6: Run focused/full gates before production deployment.
- [x] Step 7: Read five existing tokens in memory, validate `getMe` mappings, and set Railway variables without output.
- [x] Step 8: Recover the single owner chat from existing Relay Telegram work without
  printing it, validate it with all five bots, and configure the shared allowlist.
- [x] Step 9: Deploy existing-poller coexistence, run safe outbound smokes, verify all
  webhooks remain empty, and record receipt/rollback evidence.

## Verification Notes

- Command: initial Telegram boundary audit
  - Result: the gateway, bootstrap, webhook authentication, status projection, and report delivery all consume one `HERMES_TELEGRAM_BOT_TOKEN`; four-token paste would not preserve Responsible Agent ownership.
- Command: `node --test apps/backend/tests/telegram-agent-routing.test.cjs`
  - Result: 7 passed, 0 failed; default-plus-four routing, duplicate-token rejection,
    safe settings, opt-in five-webhook registration, existing-poller coexistence,
    ingress isolation, and egress isolation passed.
- Command: focused Agent Operations and release-blocker regression set
  - Result: 155 passed, 0 failed.
- Live preparation: Bot API `getMe` and `getWebhookInfo`
  - Result: all five usernames matched; all five prior webhook URLs were empty; tokens were staged with Railway deploys skipped. Values were not printed or persisted in repository files.
- Command: `npm run verify:beta`
  - Result: backend 238 passed, desktop 133 passed, type checks and production desktop build passed.
- Owner-chat recovery: fresh raw Relay snapshot
  - Result: 26 existing Telegram automation jobs resolved to one private owner chat. All
    five bots returned matching `getChat` and `getMe`; the ID and tokens were never printed.
- Railway deployment: `979fff60-ec11-4851-b245-6f503d55c352`
  - Result: `SUCCESS`; `runtimeAccessMode=relay`, bridge and live snapshot online,
    `ingressMode=existing-poller`, `deliveryReady=true`, one allowed owner chat, the exact
    five configured agent IDs, zero registrations, empty webhook URL, and no credential-shaped public output.
- Live Bot API delivery smoke
  - Result: all five mapped bots returned a successful minimized `sendMessage` receipt.
    `getWebhookInfo` was empty before and after every send, so the existing polling consumer
    retained ingress ownership.
- Live existing-poller ingress smoke
  - Result: even a correctly derived default-bot webhook secret received HTTP 404
    `telegram_webhook_disabled`; the Command Inbox count was unchanged.

## Remaining Risks

- Risk: existing tokens were pasted into a conversation and are intentionally not rotated.
  - Mitigation: never repeat or persist them outside Railway, retain the shared owner allowlist and derived webhook secrets, and label the beta security exception explicitly.
- Risk: UI automation may copy the wrong historical BotFather token.
  - Mitigation: call `getMe` for every clipboard value and compare the returned username with the planned agent mapping before any Railway write.
- Risk: registering a Railway webhook would disable the owner's existing long-polling consumer.
  - Mitigation: production is locked to `existing-poller`; bootstrap skips `setWebhook`,
    and acceptance verifies all five webhook URLs remain empty.
- Risk: five independent bots can make connection status noisy.
  - Mitigation: keep one Telegram channel summary with per-agent readiness metadata; do not create four competing product surfaces.
