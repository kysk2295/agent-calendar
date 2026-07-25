# Workspace inference broker evidence

- Captured: 2026-07-25
- Scope: Calendar AI, Wiki AI, Workspace policy, Runner ownership, Desktop local Wiki boundary
- Result: PASS

## Contract observed

- 기본 inference policy는 `runner + auto`이며 Workspace별 `state_meta.workspace_settings.inferencePolicy`에서 비밀 없이 읽힌다.
- Calendar AI와 Wiki AI는 공통 broker를 사용한다.
- Runner 후보는 요청 Workspace의 active Runner만 조회하며 connected + capability + Runner-local authentication을 모두 요구한다.
- Runner 실패는 Agent Calendar Cloud AI로 자동 재전송되지 않는다.
- Agent Calendar Cloud AI는 해당 Workspace의 policy mode가 `agent_calendar_cloud`일 때만 호출된다.
- Runner 없음, offline, engine auth required, quota exhausted가 서로 다른 안정 코드로 반환된다.
- Wiki는 Workspace 검색 후 broker synthesis를 수행하고 evidence handle을 합성 전후 재검증한다.
- Desktop local Wiki는 목록/검색만 로컬에서 처리하고 ask는 로그인된 Gateway로 전달한다.
- nested API key, token, cookie, credential은 Workspace settings 저장·응답 전에 제거된다.

## Automated verification

- `node --test apps/backend/tests/phase6-calendar-ai.test.cjs`
  - 5/5 pass.
- `node --test apps/backend/tests/phase5-knowledge-v2.test.cjs`
  - 9/9 pass.
- `npm run backend:check`
  - pass.
- `npm test`
  - Backend 488/488.
  - Desktop 262/262.
  - Runner 29/29.
- `npm run build:desktop`
  - pass.
  - Non-blocking Vite chunk-size warning observed.
- `git diff --check`
  - pass.

## Actual Electron clean-account ETE

Command:

`AGENT_CALENDAR_E2E_TWO_ACCOUNT=1 AGENT_CALENDAR_E2E_TIMEOUT_MS=420000 node apps/desktop/tests/playwright-phase3-golden-ete.cjs`

Observed result:

- Duration: 76,220 ms.
- AuthKit login completions: 2.
- Workspaces: 2.
- Runners: exactly 1 per Workspace.
- Completed jobs: 3 per Workspace.
- Inference jobs: 2 per Workspace, one Calendar AI and one Wiki AI.
- Every completed inference attempt's Runner Workspace equaled its job Workspace.
- Account A restored after Electron restart without another login.
- Account A surfaces did not contain Account B work, inference markers, or Runner fingerprint, and vice versa.

Screenshots:

- `apps/desktop/test-results/phase3-two-account-isolation-ete/03-workspace-a-inference.png`
  - SHA-256 `df3722cf30579554c23eeab09e51b4dc7bc7436123e539958b2bdeb9dd8658bf`
- `apps/desktop/test-results/phase3-two-account-isolation-ete/06-workspace-b-inference.png`
  - SHA-256 `6d10a76e8bdd5159e7e085d0accbd0b8a5daf448828d73cc4a48aa3639fd6eaa`

Both screenshots were visually inspected. Each showed only its own Workspace Wiki source, question marker, synthesized Runner artifact, and citation.

## External gate not claimed

- No live platform cloud credential was used. Explicit cloud mode was verified with an injected provider and missing-credential behavior remains fail-closed.
- No production deployment was performed in this slice.
