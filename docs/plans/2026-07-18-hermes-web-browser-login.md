# Plan: Hermes 웹 Chrome 접속 로그인 복구

- Date: 2026-07-18
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified

## Goal

`https://hermes-os-web-production.up.railway.app/`를 Chrome에서 열었을 때
`ERR_TOO_MANY_RETRIES`가 나오지 않고 일반 로그인 화면을 제공한다. 인증 후에는
기존 Hermes UI와 Agent Calendar API proxy가 그대로 작동해야 한다.

## Non-Goals

- Hermes UI의 고정 디자인과 6개 주요 화면을 재설계하지 않는다.
- Agent Calendar API, Postgres, Relay, daemon, Telegram 소유권을 변경하지 않는다.
- 인증을 제거하거나 credential을 URL에 넣지 않는다.
- 다중 사용자, 계정 복구, OAuth를 추가하지 않는다.

## Touched Boundaries

- Backend gateway: Hermes 웹의 browser authentication entry 및 session cookie.
- Backend library: `app/lib/agent-calendar-web-proxy.js` 인증 핸들러.
- DB/migrations: 변경 없음.
- Electron bridge: 변경 없음.
- React UI: 고정 Hermes UI 변경 없음. 인증 전 server-rendered login page만 추가.
- Tests: Hermes HTTP auth/proxy contract, Agent Calendar production browser QA.
- Docs: 이 계획과 실환경 검증 결과.
- Railway: 기존 `hermes-os-web` 서비스만 source redeploy.

## Success Criteria

- [x] 미인증 Chrome의 `/`는 `ERR_TOO_MANY_RETRIES` 대신 `/login` 화면을 보여준다.
- [x] 올바른 사용자명/비밀번호로 로그인하면 `HttpOnly`, `Secure`,
      `SameSite=Strict` session cookie로 Hermes UI와 `/api/*`에 접근한다.
- [x] 미인증/오류 credential은 브라우저 인증 challenge 루프를 만들지 않고,
      API upstream을 호출하지 않는다.
- [x] login/session/password/upstream token은 HTML, URL, response body에
      노출되지 않는다.
- [x] Hermes UI 6개 주요 화면과 live SSE가 인증 후 정상이다.
- [x] Hermes 웹 재배포 전후 canonical Agent Calendar deployment과 persisted task
      sentinel은 변하지 않는다.

## Edge Cases

- 이전의 잘못된 Basic `Authorization` header가 캐시된 브라우저도 다시 challenge하지
  않고 login page로 복구한다.
- login body는 작은 URL-encoded payload만 받고 크기 한도를 넘으면 거부한다.
- 오류 credential 응답은 사용자명/비밀번호를 반영하지 않고 일반 오류만 보여준다.
- password rotation 시 이전 session cookie는 즉시 무효화된다.
- `/healthz`는 Railway healthcheck를 위해 여전히 미인증 minimal 200이다.
- UI/static은 Basic header를 무시하고 form session만 허용한다. `/api/*`의 유효한
  preemptive Basic header는 CLI 호환성을 위해 challenge 없이 허용하되 브라우저의
  cross-site/same-site 요청은 거부한다.
- 로그인 실패는 Railway의 `X-Real-IP`별 15분 5회로 제한하고 limiter bucket은
  2,048개로 제한한다.
- login body는 16 KiB, proxy API body는 upstream 계약과 같은 15 MiB로 제한한다.
  5–15 MiB 문서 payload는 계속 전달하며 incomplete body는 deadline 또는 조기
  `Connection: close`로 정리한다.
- upstream redirect는 동일 upstream의 `/api/*`만 proxy-relative로 재작성하고 외부
  `Location`은 제거한다. active HTML/SVG 응답은 text/plain+CSP로 비활성화한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 미인증 `/` -> `/login` redirect, login HTML 200, no
        `WWW-Authenticate` 계약을 먼저 실패시킨다.
  - [x] 오류/cached Basic header가 login page로 복구되고 upstream call은 0인
        테스트를 먼저 실패시킨다.
  - [x] form login -> session cookie -> HTML/API 200, logout -> 재차단 테스트를
        먼저 실패시킨다.
  - [x] 실제 Chromium에서 login POST가 `Origin: null`로 거부되는 것을 재현하고,
        login page의 `Referrer-Policy: same-origin` 계약을 실패 테스트로 고정한다.
- GREEN:
  - [x] timing-safe credential 검증, 서버 저장 256-bit random session, secure cookie,
        bounded/deadlined body parsing으로 최소 구현한다.
  - [x] 외부 referrer 비공개와 동일 출처 CSRF 검증을 모두 유지하도록 login/redirect의
        referrer policy만 `same-origin`으로 좁힌다.
- REFACTOR:
  - [x] login renderer, session/auth, body reader, proxy header/rate-limit 경계를 각각
        250줄 이하의 작은 module로 분리하고 gateway의 다른 소유권을 늘리지 않는다.

## Acceptance Gates

- [x] Hermes focused auth/proxy tests
- [x] Hermes `npm run build:static`
- [x] Hermes `npm test` baseline comparison
- [x] Agent Calendar `node --check apps/desktop/tests/hermes-web-service-qa.cjs`
- [x] Live Chrome `/login` -> authenticated `/` manual QA
- [x] Live Playwright 6-tab QA, console/page/request/same-origin errors 0
- [x] Live `/api/events` first SSE chunk
- [x] Canonical Relay/daemon/Telegram/task sentinel unchanged
- [x] Response/deployment-log secret scan

건너뛴 gate:

- Gate: Agent Calendar backend/desktop full suite
  - Reason: Agent Calendar 제품 코드는 변경하지 않고 production QA 스크립트의
    인증 진입만 변경한다. 해당 스크립트는 syntax와 live E2E로 검증한다.

## Implementation Checklist

- [x] Step 1: user Chrome에서 `ERR_TOO_MANY_RETRIES`를 재현하고 curl health 200,
      Railway deployment/domain active, 5xx 0건으로 auth challenge를 원인으로 좁힌다.
- [x] Step 2: login/session auth contract를 실패 테스트로 고정한다.
- [x] Step 3: proxy module에 최소 login/session 처리를 구현한다.
- [x] Step 4: 로컬 HTTP, production-connected API, 정적 build/full baseline gate를 통과한다.
- [x] Step 5: Hermes main에 commit/push하고 `hermes-os-web` source만 재배포한다.
- [x] Step 6: user Chrome 탭, 6개 화면, SSE, 비밀값, canonical 독립성을 재검증한다.

## Verification Notes

- Command: three-run public `/healthz` curl loop
  - Result: 3/3 HTTP 200, exact `{"ok":true}`, total 0.36–0.45 seconds.
- Command: claimed user Chrome tab reload and DOM snapshot
  - Result: 2/2 `ERR_TOO_MANY_RETRIES` with the exact reported
    `사이트에 연결할 수 없음` screen.
- Command: Railway deployment/domain/log inspection
  - Result: deployment `5f0cb9a0-5c82-4a5e-a64e-4ca5c3b1d7ab` SUCCESS, domain
    ACTIVE, last 10 minutes 5xx count 0. Root returns 401 with
    `WWW-Authenticate: Basic realm="Hermes OS"`.
- Command: `node --test tests/railway-gateway.test.js tests/runtime-gateway.test.js`
  - Result: 120/120 passed, including session expiry/revoke, CSRF, rate limit,
    15 MiB payload, redirect, active content, SSE, and raw incomplete-body close gates.
- Command: `npm test`
  - Result: 501/540 passed with the same 39 inherited PRD/design-parity failures;
    no new failure was added.
- Command: `npm run build:static`
  - Result: static and Vite production builds passed.
- Command: local Hermes web process connected to canonical production Agent Calendar API
  - Result: root 303 `/login`, login page 200, form login 303, secure session issued,
    UI 200, `/api/gateway-status` 200 with `ready=true`, secret exposure false.
- Command: production Playwright form login against deployment `d7ad33b3-1663-4e83-bcc1-1f547ba472db`
  - Result: browser location origin은 정상 HTTPS였지만 `Referrer-Policy: no-referrer`로
    POST `Origin: null`이 전송되어 same-origin CSRF guard가 403을 반환하는 실제 원인을
    확인했다.
- Command: failing header contract, patched local Chromium login, focused suite, static build
  - Result: RED에서 actual `no-referrer`를 확인한 뒤 `same-origin`으로 수정했다. 로컬
    Chromium은 실제 origin과 함께 login 303, UI visible을 통과했고 focused tests는
    120/120, static/Vite build는 통과했다. full suite는 동일한 inherited 39 failures만
    남아 501/540이다.
- Command: Hermes main push and Railway source deployment
  - Result: commits `17cf292492fb06d69cc5e36ddc331b91110001c8`와
    `8394f23923d36c65ee221ce8cfb0ff58d1e6ef79`를 main에 push했고 web deployment
    `9bd0a122-678d-4c7c-843c-a16ae2223520`가 SUCCESS다.
- Command: live user Chrome and Playwright six-screen QA
  - Result: user Chrome은 `/login`에서 session login 후 `/#dashboard`를 표시했고,
    대시보드/캘린더/태스크 보드/워크보드/에이전트/오토메이션 heading이 모두 일치했다.
    별도 Playwright QA도 6/6 visible, console/page/request/bad-response 0건이다.
- Command: final live HTTP/session/SSE/canonical gates
  - Result: web root 303, health 200, login 303, UI/API/SSE 200, logout 303, revoked
    session 401이다. canonical deployment는 기존
    `5fd60f90-8dbe-4261-8bd0-d81d03e54c71` 그대로이며 gateway/daemon/Telegram/tasks
    모두 200, task count 355와 ID-set SHA-256
    `fcf451f85626147f4450f0617831cead3ff3564f223b21158535891701516b8a`가 유지됐다.
- Command: deployment/build log secret scan
  - Result: deployment 6 lines와 build 7 lines에서 web password 및 upstream bearer
    literal match가 모두 0건이다.
- Review: independent browser-login security/code review
  - Result: P0/P1/P2 없음, `codeQualityStatus: CLEAR`, `recommendation: APPROVE`.

## Remaining Risks

- Risk: process restart는 server-side session을 모두 로그아웃시킨다.
  - Mitigation: 단일 사용자 운영 웹의 fail-closed 동작으로 수용하며 form login으로
    즉시 재인증할 수 있다.
- Risk: 기존 native Basic UI 진입 계약이 바뀐다.
  - Mitigation: UI는 form session으로 명시적으로 전환하고 `/api/*`의 안전한
    preemptive Basic CLI 경로만 유지한다.
