# Plan: Railway 서비스 분리와 Hermes 웹 동시 운영

- Date: 2026-07-18
- Owner: Codex
- Work size: Large / Boundary
- Status: Complete

## Goal

현재 정상 동작하는 Agent Calendar API, Mac mini Relay, Telegram ingress, daemon을
중단하지 않고 Agent Calendar를 유일한 운영 백엔드로 고정한다. 별도 Railway
서비스에서 기존 Hermes OS 웹 UI를 그대로 제공하고, 웹의 API 요청은 Agent
Calendar API로 전달해 두 화면이 동시에 동작하도록 한다.

## Non-Goals

- `agent-calendar`와 `hermes-os` GitHub 저장소를 합치지 않는다.
- Hermes 웹 UI의 디자인, 화면 구조, 문구를 변경하지 않는다.
- 이번 전환에서 Postgres 스키마나 데이터를 변경하지 않는다.
- Mac mini Relay URL, Telegram webhook, 설치된 데스크톱 API URL을 변경하지 않는다.
- Hermes 웹에 별도 daemon, Telegram webhook, Relay queue, DB writer를 만들지 않는다.
- 공개 Hermes 웹에서 인증 없이 canonical API mutation을 허용하지 않는다.

## Work Size And Ownership

- Work size: Railway, GitHub source, Agent Calendar 배포 가드, 별도 Hermes 웹
  gateway, 운영 도메인과 실서비스 QA를 함께 바꾸는 Large / Boundary 작업이다.
- Canonical owner: Agent Calendar API가 Postgres 쓰기, Relay, Telegram, TickTick
  callback, daemon scheduling을 단독 소유한다.
- Secondary surface: Hermes OS 웹은 정적 UI와 server-side API proxy만 소유한다.

## Touched Boundaries

- Backend gateway: API 런타임 동작은 유지한다.
- Backend library: 변경 없음.
- DB/migrations: 변경 없음. 기존 Postgres를 Agent Calendar만 직접 사용한다.
- Electron bridge: 변경 없음. 기존 저장 URL과 토큰을 보존한다.
- React UI: Agent Calendar와 Hermes UI 모두 시각 변경 없음.
- Hermes web gateway: 별도 깨끗한 `hermes-os` worktree에서 upstream proxy mode를
  추가한다.
- Railway: 현재 서비스를 Agent Calendar source로 고정하고 `hermes-os-web`
  서비스를 추가한다.
- Tests: Agent Calendar 배포 대상 가드, Hermes HTTP/SSE proxy 계약, 두 운영
  서비스의 독립 live smoke.
- Docs: 이 계획과 운영 검증 결과.

## Success Criteria

- [x] 현재 Agent Calendar API 도메인은 전환 중 계속 200을 반환하고 build commit,
      Relay online, daemon 상태가 유지된다.
- [x] 현재 Railway 서비스의 GitHub source가 `kysk2295/agent-calendar:main`으로
      고정돼 Hermes push가 Agent Calendar를 덮어쓰지 않는다.
- [x] 새 `hermes-os-web` 서비스는 `kysk2295/hermes-os:main`에서 독립 배포된다.
- [x] 새 웹 도메인의 `/`와 모든 정적 asset이 기존 Hermes UI를 200으로 제공한다.
- [x] Hermes 웹의 `/api/*` 요청과 SSE stream은 server-side에서 Agent Calendar
      API로 전달되며 upstream token은 브라우저, 응답, 로그에 노출되지 않는다.
- [x] Hermes 웹의 HTML, asset, API는 HTTPS Basic 인증 전에는 401이고 인증 후에만
      제공된다. 자격증명은 Railway와 macOS Keychain에만 저장된다.
- [x] Hermes 웹 서비스에는 DB, daemon, Telegram bot, Relay polling 소유권이 없다.
- [x] Agent Calendar와 Hermes 웹을 각각 재배포해도 다른 서비스 deployment ID와
      health가 변하지 않는다.
- [x] 배포 스크립트는 project/environment/service/source를 명시하지 않으면
      실행되지 않는다.

## Edge Cases

- Upstream API unavailable: Hermes 웹은 비밀값 없이 명시적 502를 반환하고 정적
  UI 서비스 자체는 계속 올라와 있어야 한다.
- SSE/chat: proxy가 전체 응답을 버퍼링하지 않고 chunk를 순서대로 전달해야 한다.
- SSE disconnect/backpressure: 브라우저가 끊기면 upstream fetch와 reader를 취소하고,
  느린 client에는 `drain` 전까지 다음 chunk를 밀어 넣지 않는다.
- Compression/redirect: native fetch가 압축을 해제한 뒤 stale `content-encoding`을
  전달하지 않고 upstream redirect는 자동 추적하지 않는다.
- Authentication: browser가 보낸 토큰보다 server-side upstream token을 사용하고
  hop-by-hop/host/content-length 헤더는 전달하지 않는다.
- Healthcheck: 정보나 secret을 포함하지 않는 `GET /healthz`만 인증 없이 200을
  허용한다. HTML, asset, `/api/*`는 모두 Basic 인증 뒤에만 제공한다.
- Public access: Basic 인증 실패 시 `WWW-Authenticate`와 일반 401만 반환하며
  upstream을 호출하지 않는다.
- Request bodies: JSON, 빈 body, query string, DELETE/POST/PATCH를 보존한다.
- Existing deployment: current Agent Calendar domain과 DB/Relay/Telegram/daemon/auth
  variables는 제거·이동하지 않는다. source와 stale provenance variable만 Step 7의
  검증된 순서로 변경한다.
- Source drift: GitHub main SHA가 검증 SHA와 달라지면 배포를 중단한다.
- Local Hermes divergence: dirty한 `/Users/koyunseo/Documents/hermes-os`는 배포에
  사용하지 않고 remote main 기반 별도 worktree만 사용한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] Agent Calendar deploy script가 explicit service/source guard 없이 실행될 수
        있음을 잡는 contract test를 먼저 실패시킨다.
  - [x] Hermes web upstream proxy가 없는 상태에서 method/path/query/body/auth/SSE
        계약 테스트를 먼저 실패시킨다.
  - [x] 인증 없는 HTML/API 요청과 잘못된 Basic 자격증명이 upstream을 호출하지
        않고 401인지 먼저 실패시킨다.
  - [x] 운영 재현: 기존 Hermes URL의 `/`가 `404`와 Agent Calendar API-only JSON을
        반환해 두 artifact가 한 서비스에서 교체되는 문제를 확인했다.
- GREEN:
  - [x] Agent Calendar deploy guard는 project
        `b64a9c8f-101e-4e08-9a7f-68fea0a4de9a`, production environment
        `7629b09d-3447-4f74-9b06-2f9b8aafb80a`, 기존 canonical service
        `b7bd75ff-cc24-4a6d-9387-1628fcaff9d6`(현재 name `hermes-os`)와 source
        `kysk2295/agent-calendar:main`을 모두 확인한 뒤 GitHub source deployment만
        감시한다. 평시 경로에서 `railway up`을 호출하지 않는다.
  - [x] Hermes web은 정적 UI를 유지하면서 `/api/*`를 canonical upstream으로
        streaming proxy한다.
  - [x] 두 Railway 서비스와 도메인이 동시에 health/UI/API gate를 통과한다.
- REFACTOR:
  - [x] 서로 다른 repository의 Railway config를 인위적으로 합치지 않고, 각
        서비스의 source/config 경계를 명시적으로 유지했다.
  - [x] 역사 QA 문서와 사용자 지정 URL은 변경하지 않았다.

## Acceptance Gates

- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [ ] clean Hermes worktree `npm test` (실행됨: 아래의 동일한 기존 39 failures)
- [x] clean Hermes worktree `npm run build:static`
- [x] Agent Calendar public `GET /api/gateway-status`: 200, expected build SHA,
      `relay.bridgeOnline=true`, `relay.liveSnapshotOnline=true`
- [x] Agent Calendar bearer-authenticated `GET /api/agent-operations`: 200,
      `daemon.running=true`, `daemon.lastError=null`
- [x] Agent Calendar bearer-authenticated connector state: Telegram
      `ingressMode=existing-poller`; Postgres-backed API read remains 200
- [x] Hermes web live `/` HTML/assets/API/SSE smoke
- [x] Hermes web `GET /healthz`: unauthenticated 200 with only `{ "ok": true }`
- [x] Hermes web unauthenticated/bad-auth `/` and `/api/state`: 401,
      `WWW-Authenticate` present, upstream request counter unchanged
- [x] Hermes web authenticated `/` and `/api/state`: 200; upstream token absent from
      HTML, headers, response body, Railway logs
- [x] Hermes SSE fixture/live route: first chunk arrives before upstream close and chunk
      order is preserved
- [x] Playwright로 Hermes 대시보드, 캘린더, 태스크, 워크보드, 에이전트,
      자동화 탭 클릭 및 console/page error 검사
- [x] Railway service source/start command/domain/deployment 독립성 검사

건너뛴 gate:

- Gate: clean Hermes worktree `npm test`
  - Reason: 기준 SHA도 `507 total / 468 pass / 39 fail`, 변경본은 신규 회귀 테스트를
    포함해 `519 total / 480 pass / 39 fail`이다. 실패 39건은 변경 전부터 존재한
    PRD 파일·고정 디자인 parity 계약군이며 이번 proxy/UI compatibility diff로
    추가된 failure는 0건이다. focused proxy/runtime/readiness `101/101`과
    static production build는 모두 exit 0이다.

## Rollback

- Fixed selectors before cutover:
  - Project: `b64a9c8f-101e-4e08-9a7f-68fea0a4de9a`
  - Environment: `7629b09d-3447-4f74-9b06-2f9b8aafb80a` (`production`)
  - Canonical service: `b7bd75ff-cc24-4a6d-9387-1628fcaff9d6` (`hermes-os`)
  - Working deployment: `640a55cd-8040-470f-943e-c8d5973e62a5`
  - Working API SHA: `f95b625e10463aac6693afebff8164d03f7c5516`
  - Working domain: `hermes-os-production-e174.up.railway.app`
- Agent Calendar source reconnect failure: Railway healthcheck가 새 deployment를
  promote하지 않으므로 위 working deployment를 계속 serving하는지 먼저 확인한다.
  잘못 연결된 source만 다음 명령으로 끊는다.

  `railway service source disconnect --project b64a9c8f-101e-4e08-9a7f-68fea0a4de9a --environment 7629b09d-3447-4f74-9b06-2f9b8aafb80a --service b7bd75ff-cc24-4a6d-9387-1628fcaff9d6`

  active artifact까지 손상된 경우 다음 고정 경로만 사용한다.

  1. `railway variable set SOURCE_COMMIT=f95b625e10463aac6693afebff8164d03f7c5516
     --skip-deploys --project b64a9c8f-101e-4e08-9a7f-68fea0a4de9a
     --environment 7629b09d-3447-4f74-9b06-2f9b8aafb80a
     --service b7bd75ff-cc24-4a6d-9387-1628fcaff9d6`
  2. clean worktree의 working API SHA에서 `railway up --ci --project
     b64a9c8f-101e-4e08-9a7f-68fea0a4de9a --environment
     7629b09d-3447-4f74-9b06-2f9b8aafb80a --service
     b7bd75ff-cc24-4a6d-9387-1628fcaff9d6 --message rollback@f95b625e1046`
  3. fixed selectors의 `railway deployment list --limit 1 --json`을 polling해 새
     emergency deployment가 `SUCCESS`가 된 뒤 `/api/gateway-status` build SHA와
     Relay, `/api/agent-operations` daemon, Telegram, `/api/tasks`를 다시 assert한다.
- Hermes web: 새 서비스는 독립 추가물이므로 실패한 deployment/source를 방치하지
  않는다. Step 9 직후 기록한 `WEB_SERVICE_ID`가 canonical ID와 다름을
  assert한 뒤 먼저 fixed-selector `railway service source disconnect`를 실행하고,
  이어서 `railway down --project b64a9c8f-101e-4e08-9a7f-68fea0a4de9a
  --environment 7629b09d-3447-4f74-9b06-2f9b8aafb80a --service "$WEB_SERVICE_ID"
  --yes`로 새 웹 deployment만 내린다. 그 뒤 canonical deployment ID가 변경 전과
  같고 canonical live gates가 모두 green인지 확인한다.
- GitHub: Hermes proxy commit은 remote main의 검증 SHA 위에 단일 fast-forward
  commit으로 만들고, 실패 시 해당 commit을 revert한다.
- DB: 새 웹에는 `DATABASE_URL`을 주지 않으므로 DB rollback이 필요 없어야 한다.
- Secrets: 새 웹 서비스의 upstream token copy는 Railway service reference로만
  주입하며 출력하거나 파일에 저장하지 않는다. 기존 trusted desktop settings의
  canonical bearer copy는 URL/토큰 migration 없이 유지한다.
- Web access: Basic password는 무작위 생성하고 Railway variable과 macOS Keychain에
  동일하게 저장한다. plan, shell output, git, 최종 보고에 원문을 남기지 않는다.

## Implementation Checklist

- [x] Step 1: 현재 failure, service/source/domain/deployment/remote SHA를 기록한다.
- [x] Step 2: 기존 `apps/backend/tests/railway-deploy-script.test.cjs`를 fake
      `git`/`railway` CLI 계약으로 갱신해 기존 script가 implicit upload를 수행하는
      RED를 만든다. Command:
      `node --test apps/backend/tests/railway-deploy-script.test.cjs`.
      Expected RED: 호출 기록에 `railway up` 또는 target/source 검증 누락이 잡힌다.
- [x] Step 3: deploy script를 explicit project/environment/service/from-source와
      source preflight/monitor 방식으로 GREEN 처리한다. Expected GREEN: 고정 selector와
      source가 일치할 때만 0, drift 시 non-zero, `railway up`/`variable set` 호출 0회.
      Command: 같은 node test를 다시 실행해 exit 0을 확인한다.
- [x] Step 4: `git fetch origin main` 후 remote SHA가
      `29cbfdeb484139901cf68c2a7690de32aaf6f0ac`인지 확인하고 그 SHA에서 별도
      `codex/hermes-ui-proxy` worktree를 만든다. `git status --porcelain`은 빈 출력,
      `git rev-parse HEAD`는 위 SHA여야 한다.
- [x] Step 5: Hermes `tests/railway-gateway.test.js`에 Basic 401/no-upstream-call,
      public minimal `/healthz`, method/path/query/body, injected bearer, secret redaction,
      SSE early-chunk RED를 추가한다. Command:
      `node --test tests/railway-gateway.test.js tests/runtime-gateway.test.js`.
      proxy mode 전에는 expected assertion failure를 확인한다. 구현 뒤 같은 command,
      gzip/redirect/disconnect 실제 HTTP 회귀, readiness boundary contract, static build를
      exit 0으로 확인한다. full `npm test`는 위 baseline-equivalent 39 failures를 별도
      기록한다.
- [x] Step 6: Agent Calendar narrow/full gate를 실행하고 Agent Calendar 변경만
      commit/push한다. Commands: `npm run backend:check`, `npm run test:backend`,
      `npm run typecheck`, `npm --workspace apps/desktop run test`,
      `npm run build:desktop`; 모두 exit 0. `git diff --cached --name-only`에는 plan,
      deploy script, deploy test만 있어야 한다. push 뒤 `git ls-remote origin
      refs/heads/main`은 local HEAD와 같고 Hermes remote main은 여전히 위 29cb SHA다.
- [x] Step 7: 현재 canonical Railway service source를 먼저
      `kysk2295/agent-calendar:main`으로 고정한 뒤 stale `SOURCE_COMMIT` variable을
      삭제하고 explicit `redeploy --from-source`를 수행한다. 기존
      service ID/name/domain은 Relay·private-DNS 호환 anchor로 유지한다. 새 deployment가
      expected Agent Calendar SHA, Relay online, daemon running, Telegram
      `existing-poller`, Postgres read 200임을 확인한 뒤에만 다음 단계로 간다.
      Commands/expected result:
  - `railway service source connect --repo kysk2295/agent-calendar --branch main` with all
    fixed selectors; `railway service list --json` reports that exact repo.
  - source 확인 뒤 `railway variable delete SOURCE_COMMIT`을 fixed selectors로
    실행한다. delete가 deployment를 유발해도 이 시점의 source는 이미 Agent
    Calendar이므로 Hermes artifact가 canonical을 덮을 수 없다.
  - `railway redeploy --from-source --yes --json`을 fixed selectors로 실행해 GitHub
    Agent Calendar main deployment를 명시적으로 만든다.
  - `railway deployment list --limit 1 --json` reaches `SUCCESS`, source SHA equals the
    pushed Agent Calendar SHA, start command equals
    `npm --workspace apps/backend run start`.
  - `curl -fsS "$API/api/gateway-status" | jq -e` asserts ready and both Relay booleans.
  - settings의 token으로 `/api/agent-operations` daemon running/no error,
    `/api/channels/status`의 `.channels[] | select(.id=="telegram")` ingress
    `existing-poller`, `/api/tasks` HTTP 200을 assert한다. 전환 직전 다시 캡처한
    task ID count/SHA-256 sentinel이 Step 1 baseline과 동일해야 한다.
- [x] Step 8: clean Hermes worktree에서 관련 test/build가 green이고 full suite가
      baseline-equivalent임을 확인한 proxy commit을 `kysk2295/hermes-os:main`에
      push한다. Expected: Step 7 canonical
      deployment ID가 이 push만으로 변하지 않는다.
      Push 직전/직후 canonical latest deployment ID를 각각 저장해 동일함을
      `test "$before" = "$after"`로 assert한다.
- [x] Step 9: `hermes-os-web` service를 만들고 private upstream URL/token reference와
      Basic auth만 설정한 뒤 Hermes main을 연결·배포하고 도메인을 생성한다.
      먼저 `railway status --json`으로 linked project/environment가 위 fixed selector와
      일치함을 assert한다. `railway add --service hermes-os-web --json` 결과의 새 service
      ID를 즉시 `WEB_SERVICE_ID`에 저장하고 canonical ID와 다름을 assert한다. 이후
      variable/source/redeploy/domain/deployment/list 명령에는 project, environment,
      새 service ID를 모두 명시한다.
      `railway variable list --project <fixed> --environment <fixed> --service
      "$WEB_SERVICE_ID" --json | jq -e`로 required 네 key가 있고 `DATABASE_URL`, daemon,
      Telegram, Relay 관련 key가 전부 없는지 값 출력 없이 확인한다. `railway.json`
      healthcheck는 `/healthz`다.
      Source는 `kysk2295/hermes-os:main`, start command는 `npm run start:railway`, latest
      deployment는 `SUCCESS`, generated domain의 `/healthz`는 인증 없이 200이어야 한다.
- [x] Step 10: 두 live surface를 검증한다.
  - canonical: public gateway-status와 authenticated agent-operations/connector/API read
  - web: healthz 200, no/bad Basic 401, good Basic UI/API 200, SSE early chunk
  - independence: Hermes push/web redeploy 전후 canonical deployment ID 동일;
    canonical redeploy 전후 web deployment ID 동일
  - Playwright: `apps/desktop/tests/hermes-web-service-qa.cjs`를 새로 작성해 Basic
    credential를 브라우저 context에만 주입하고 dashboard/calendar/tasks/workboard/
    agents/automation tabs를 click한다. console error 0, failed same-origin API request
    0을 assert하고 스크립트는 secret을 출력하지 않는다.
- [x] Step 11: plan verification notes, 실제 새 service/deployment/domain IDs와 남은
      위험을 갱신한다.

## Verification Notes

- Command: Railway service/deployment inspection
  - Result: service source는 `kysk2295/hermes-os`지만 active artifact는 Agent
    Calendar `f95b625e`, start command는 `npm --workspace apps/backend run start`다.
- Command: `curl https://hermes-os-production-e174.up.railway.app/`
  - Result: `404`, `Agent Calendar backend only serves API routes`로 재현됐다.
- Command: live `/api/gateway-status`
  - Result: `ready=true`, `relay.bridgeOnline=true`,
    `relay.liveSnapshotOnline=true`, build `f95b625e1046`다.
- Command: Git remote SHA checks
  - Result: Agent Calendar main은 `f95b625e`; Hermes main과 마지막 정상 Hermes
    deployment는 `29cbfdeb`다.
- Command: live bearer-authenticated `/api/agent-operations`, `/api/channels/status`,
  `/api/tasks`
  - Result: daemon `running=true`, `lastError=null`; Telegram `connected=true`,
    `ingressMode=existing-poller`; Postgres-backed tasks HTTP `200`이다.
- Command: `/api/tasks` persisted-data sentinel (task IDs만 정렬해 SHA-256)
  - Result: baseline count `355`, ID-set SHA-256
    `fcf451f85626147f4450f0617831cead3ff3564f223b21158535891701516b8a`.
    Step 7 직전 동일 방식으로 재확인하고, Step 7·Step 10·emergency rollback 뒤 같은
    count/hash를 요구한다. 불일치 시 배포를 멈추고 실제 사용자 변경인지 먼저 판정한다.
  - Reproduction: bearer-authenticated curl을 payload variable/file/`tee` 없이 직접
    `jq -c '[.tasks[].id] | sort' | shasum -a 256 | awk '{print $1}'`로 pipe한다.
    Count는 별도 curl stream에 `jq -e '.tasks | length == 355'`를 실행한다. hash는
    `jq -c`가 출력하는 trailing newline을 포함한 값이다.
- Command: `node --test apps/backend/tests/railway-deploy-script.test.cjs`
  - RED: 기존 script가 `variable set SOURCE_COMMIT=...`을 호출해 2 tests failed.
  - GREEN: fixed project/environment/service/source preflight와 targeted
    `redeploy --from-source` 계약으로 2 tests passed.
- Command: `bash -n scripts/deploy-railway-main.sh && git diff --check`
  - Result: exit 0.
- Command: clean Hermes worktree creation
  - Result: branch `codex/hermes-ui-proxy-20260718`, HEAD
    `29cbfdeb484139901cf68c2a7690de32aaf6f0ac`, original dirty checkout untouched.
- Command: Agent Calendar full local gates
  - Result: backend check exit 0; backend `284/284`; desktop `141/141`; typecheck and
    desktop production build exit 0.
- Command: Agent Calendar commit/push
  - Result: `main` commit `47bce6f9e0a85b57fc5dde5f0fcda0ffda5b56ee` pushed to
    `kysk2295/agent-calendar`.
- Command: canonical Railway source cutover and explicit source redeploy
  - Result: service `b7bd75ff-cc24-4a6d-9387-1628fcaff9d6` now sources
    `kysk2295/agent-calendar:main`; deployment
    `bc307f27-46cf-4f24-acce-3baed9bf3213` reached SUCCESS at the expected commit and
    start command. Stale `SOURCE_COMMIT` is absent.
- Command: post-cutover canonical live gates
  - Result: build `47bce6f9e0a8`, Relay bridge/live snapshot online, daemon running with
    no error, all five Telegram profiles ready in `existing-poller`, registered webhook
    count 0, task count/hash still `355`/`fcf451f85626147f4450f0617831cead3ff3564f223b21158535891701516b8a`.
- Command: Hermes proxy TDD and adversarial transport regressions
  - RED: non-proxy `/healthz`, authenticated cache isolation, native-fetch gzip,
    manual redirect, SSE cache/cancel 계약을 추가한 뒤 `89 total / 83 pass / 6 fail`을
    확인했다.
  - GREEN: Basic auth, strict origin/fail-closed service identity, method/path/query/body,
    server bearer, gzip metadata removal, redirect preservation, secret-redacted 502,
    SSE early chunk/disconnect cancellation/backpressure를 별도 proxy module로 구현했고
    `node --test tests/railway-gateway.test.js tests/runtime-gateway.test.js`가
    readiness payload behavior 2 tests를 포함해 `101/101` pass다.
- Command: clean Hermes worktree `npm run build:static`
  - Result: static copy와 Vite production build 모두 exit 0.
- Command: clean Hermes worktree `npm test`
  - Result: `519 total / 480 pass / 39 fail`; 기준 SHA의 `507 / 468 / 39`와 failure
    count/family가 같고 신규 12 tests는 모두 통과했다.
- Command: local proxy against canonical production + Playwright clickthrough
  - Result: minimal health 200, no/bad Basic 401, authenticated HTML/API 200;
    dashboard/calendar/tasks/workboard/agents/automation 전부 visible, console/page error,
    request failure, same-origin 4xx/5xx가 모두 0이다. Canonical redacted readiness도
    5개 profile/status row를 유지하고 setup command 원문은 노출하지 않는다.
- Command: Hermes proxy commit and GitHub source deployment
  - Result: clean worktree commit
    `4edc3f2a99859d99039b8a77eeff26a69af4b39f`를
    `kysk2295/hermes-os:main`에 fast-forward push했다. 이 push 전후 canonical
    deployment는 `bc307f27-46cf-4f24-acce-3baed9bf3213`로 동일했다.
- Command: Railway `hermes-os-web` provisioning and source deployment
  - Result: service `3ec65b5e-f4b3-43f6-a8d2-52ec2222b6d0`, deployment
    `5f0cb9a0-5c82-4a5e-a64e-4ca5c3b1d7ab`, source
    `kysk2295/hermes-os:main`, source SHA `4edc3f2a99859d99039b8a77eeff26a69af4b39f`가
    `SUCCESS`다. Runtime log에서 `start:railway` 및 gateway port `8080` 시작을
    확인했다. 전용 도메인은
    `https://hermes-os-web-production.up.railway.app`이다.
- Command: web-service variable ownership allow/deny check
  - Result: 사용자 정의 키는 `AGENT_CALENDAR_API_ORIGIN`,
    `AGENT_CALENDAR_API_TOKEN`, `HERMES_WEB_USERNAME`, `HERMES_WEB_PASSWORD`만
    존재한다. `DATABASE_URL`, `HERMES_RELAY_*`, `HERMES_BRIDGE_*`,
    `HERMES_TELEGRAM_*`, `AGENT_OPERATIONS_*`는 없고 private service reference가 비어
    있지 않은 것도 값 출력 없이 확인했다.
- Command: live web security/API/SSE smoke
  - Result: `/healthz`는 정확히 `{"ok":true}`로 200, 미인증 `/`와
    `/api/state` 및 오류 credential은 401이다. 인증 후 `/`, `/api/state`,
    `/api/gateway-status`, `/api/tasks`는 모두 200이다. Live `/api/events` SSE의
    첫 chunk 125 bytes가 536 ms에 도착했다. 응답 3,198,188 bytes와 해당
    deployment의 build/runtime log 1,543 bytes를 검색했으며 Basic password와 upstream
    bearer 일치는 각각 0건이다.
- Command: production Playwright tab clickthrough
  - Result: 대시보드, 캘린더, 태스크 보드, 워크보드, 에이전트,
    오토메이션 6개 화면이 모두 visible이고 console error, page error,
    request failure, same-origin 4xx/5xx는 모두 0건이다. 에이전트 준비 표시는
    `default`, `bizconsultant`, `stockagent`, `uniportpm`, `wikicurator` 5개를
    유지하고 `hermes gateway setup` 원문은 DOM에 노출하지 않는다.
- Command: post-web-deploy canonical invariants
  - Result: canonical deployment는 여전히
    `bc307f27-46cf-4f24-acce-3baed9bf3213`/Agent Calendar
    `47bce6f9e0a85b57fc5dde5f0fcda0ffda5b56ee`이다. Relay bridge/live snapshot은
    online, daemon은 running/no error, Telegram은 connected/delivery-ready
    `existing-poller`/registered webhook 0이다. task sentinel은 여전히
    `355`/`fcf451f85626147f4450f0617831cead3ff3564f223b21158535891701516b8a`다.
- Command: independent final code review
  - Result: P0/P1/P2 0건, `APPROVE`; focused `101/101`, scoped strict TypeScript,
    static build, syntax/diff 검사가 모두 통과했다.

## Executable Live QA

Secret 원문은 출력하지 않고 데스크톱 settings와 macOS Keychain에서 shell 변수로만
읽는다.

1. Canonical API invariant:
   - `curl -fsS "$API/api/gateway-status" | jq -e '.ready and
     .relay.bridgeOnline and .relay.liveSnapshotOnline'`
   - bearer-authenticated `/api/agent-operations`에
     `jq -e '.daemon.running and (.daemon.lastError == null)'`
   - bearer-authenticated `/api/channels/status`에
     `jq -e '[.channels[] | select(.id == "telegram" and .connected == true and
     .ingressMode == "existing-poller")] | length == 1'`
   - bearer-authenticated `/api/tasks` status `200`; `.tasks[].id` 정렬 배열의 count와
     SHA-256이 직전 baseline과 동일
2. Web security and proxy:
   - `curl -sS -D - -o /dev/null "$WEB/"`와 `"$WEB/api/state"`: status 401,
     `WWW-Authenticate: Basic`; 잘못된 `-u`도 동일하다.
   - `curl -fsS "$WEB/healthz" | jq -e '.ok == true and (keys | length == 1)'`
   - Keychain credential를 사용한 `curl -u`로 `/`는 HTML 200, `/api/state`는 JSON
     200이다. 응답/headers/logs에서 hostile fixture token과 실제 token pattern 검색은
     0건이어야 한다.
   - unit SSE upstream은 첫 chunk 뒤 종료를 지연한다. client가 종료 전에 첫 chunk를
     받고 뒤 chunk까지 순서대로 받는 test가 exit 0이어야 한다.
3. UI clickthrough:
   - `apps/desktop/tests/hermes-web-service-qa.cjs`를 새 web URL과 Keychain Basic
     credential로 실행한다.
   - 대시보드, 캘린더, 태스크, 워크보드, 에이전트, 자동화 탭이 각각 렌더되고
     console/page error 및 same-origin API 4xx/5xx가 0이어야 한다.
4. Independence and variables:
   - web deploy/redeploy 전후 canonical latest deployment ID가 동일하다.
   - canonical source redeploy 전후 web latest deployment ID가 동일하다.
   - fixed selectors와 `WEB_SERVICE_ID`를 쓴 `railway variable list --json`을 직접
     `jq -e`에 pipe해 key만 검사한다. `AGENT_CALENDAR_API_ORIGIN`,
     `AGENT_CALENDAR_API_TOKEN`, `HERMES_WEB_USERNAME`, `HERMES_WEB_PASSWORD`는 있고
     `DATABASE_URL`, `HERMES_RELAY_TOKEN`, `HERMES_TELEGRAM_*`,
     `AGENT_OPERATIONS_DAEMON_ENABLED`은 없다. raw JSON은 저장·출력하지 않는다.

## Remaining Risks

- Risk: Hermes UI가 향후 새 legacy API에 의존하면 Agent Calendar와 다시
  compatibility drift가 생길 수 있다.
  - Mitigation: 배포 QA 스크립트를 유지하고 Hermes UI/API 변경 때 매번 6개 탭과
    same-origin network gate를 재실행한다.
- Risk: Basic credential은 현재 단일 운영자 credential이므로 공유 또는 분실 시
  수동 rotation이 필요하다.
  - Mitigation: 원문은 Railway와 macOS Keychain에만 저장했고 응답·로그·Git에서
    노출 검사를 통과했다. 필요 시 두 저장소의 값을 함께 교체한다.
- Risk: `/api/state` 응답이 현재 약 3.2 MB라 데이터가 더 커지면 첫 화면의
  network cost가 커질 수 있다.
  - Mitigation: 이번 분리의 정확성과는 별개이며, 후속 성능 작업에서 화면별 API와
    pagination을 검토한다. 현재 실환경 6개 탭은 request failure 없이 렌더됐다.
