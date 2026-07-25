# Plan: Workspace-owned Calendar AI and Wiki AI inference

- Date: 2026-07-25
- Owner: Codex
- Work size: Boundary
- Status: Verified

## Goal

Calendar AI와 Wiki AI의 모든 생성형 추론을 요청 Workspace에 귀속된 공통 `WorkspaceInferenceBroker`로 통합한다. 기본 경로는 그 Workspace에 연결된 Runner와 Runner 로컬에서 인증된 Codex, Claude, Grok, Hermes만 사용하며, Agent Calendar Cloud AI는 Workspace가 명시적으로 선택한 경우에만 별도 경로로 실행한다.

## Non-Goals

- 정확한 일정 조회·계산·변경의 deterministic tool path는 모델 추론으로 대체하지 않는다.
- Runner의 OAuth, API key, CLI session, cookie를 Gateway로 복사하거나 저장하지 않는다.
- 다른 Workspace Runner를 공용 풀처럼 사용하지 않는다.
- Mobile 구현을 시작하지 않는다.
- 레거시 전역 OpenAI key를 암묵적 장애 fallback으로 유지하지 않는다.

## Touched Boundaries

- Backend gateway: `apps/backend/app/lib/phase1-auth-routes.js`, production product routes
- Backend library: 새 broker, Calendar AI adapter/composition, Knowledge v2 synthesis
- DB/migrations: 기존 Workspace `state_meta.workspace_settings`에 비밀 없는 inference policy 저장
- Electron bridge: 로컬 Wiki ask의 공용 Hermes/Railway credential 추론 제거
- React UI: 기존 Calendar AI/Wiki AI unavailable 상태를 정직하게 표시하는 범위
- Tests: backend hostile isolation tests, Calendar AI/Knowledge regression, Desktop proxy tests, Electron Playwright ETE
- Docs: 이 계획과 검증 증거

## Success Criteria

- [x] User A/B, Workspace A/B의 Calendar AI와 Wiki AI 요청이 각각 Runner A/B로만 전달된다.
- [x] 외부 Workspace Runner는 fallback, 열거, 상태 응답 어디에도 나타나지 않는다.
- [x] Runner 부재·offline·미인증·quota exhausted가 구분되며 전역 API key가 있어도 cloud opt-in 없이는 외부 호출이 0회다.
- [x] `mode=agent_calendar_cloud`를 Workspace가 명시적으로 저장한 경우에만 플랫폼 credential 경로가 실행된다.
- [x] Workspace 정책은 `mode`와 `defaultEngine`만 저장하며 secret/token/cookie를 허용하지 않는다.
- [x] 실제 Runner 엔진은 같은 Workspace의 연결 상태와 capability/authentication 검증을 모두 통과한다.
- [x] Wiki 답변은 Workspace 검색 결과를 broker가 합성하며 단순 excerpt join이 아니다.
- [x] Wiki 응답 직전 citation/source 권한을 재검증하고 foreign 또는 revoked citation을 반환하지 않는다.
- [x] engine credential/token/cookie가 Gateway DB, 로그, evidence, API response에 나타나지 않는다.
- [x] Electron clean-account ETE에서 두 계정 격리와 Calendar AI/Wiki AI 질문 흐름이 관찰된다.

## Edge Cases

- Runner 없음: `INFERENCE_RUNNER_UNAVAILABLE`이며 cloud를 호출하지 않는다.
- Runner는 등록됐지만 offline: `RUNNER_OFFLINE`이며 다른 Workspace Runner를 찾지 않는다.
- 요청 엔진은 설치됐지만 인증 만료/누락: `ENGINE_AUTH_REQUIRED`.
- Runner가 quota exhausted를 보고: `ENGINE_QUOTA_EXHAUSTED`.
- Runner 작업 실패·timeout: 같은 요청을 cloud로 자동 재전송하지 않는다.
- cloud mode지만 플랫폼 credential 없음: `AGENT_CALENDAR_CLOUD_AI_UNAVAILABLE`.
- Wiki citation이 합성 도중 revoke됨: 남은 citation만으로 한 번 재합성하거나 증거 변경 오류로 fail closed 한다.
- cache hit의 citation이 revoke됨: 캐시 답변을 반환하지 않는다.
- foreign Runner ID나 evidence handle이 입력에 섞임: 요청 Workspace 경계에서 무시/거부하고 공개 응답에 식별자를 노출하지 않는다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 두 Workspace의 Calendar/Wiki 요청이 자기 Runner로만 dispatch되는 hostile test
  - [x] no Runner/auth/quota 상태와 cloud 호출 0회 test
  - [x] explicit cloud mode에서만 platform completion 호출 test
  - [x] Wiki broker synthesis 및 revoke/foreign citation 재검증 test
  - [x] credential/token/cookie 비저장·비노출 test
  - [x] Desktop local Wiki ask가 공용 자격을 사용하지 않는 test
- GREEN:
  - [x] 비밀 없는 Workspace policy 정규화
  - [x] same-Workspace Runner 선택, durable inference dispatch, truthful failure mapping
  - [x] explicit cloud provider 경로
  - [x] Calendar AI와 Knowledge v2 broker composition
  - [x] Desktop ask Gateway routing
- REFACTOR:
  - [x] 기존 Calendar 전용 Runner adapter와 암묵적 fallback을 제거하고 cloud-only adapter로 축소
  - [x] 공통 Runner prompt/result polling을 Workspace inference transport로 모은다.

## Acceptance Gates

- [x] focused broker hostile tests
- [x] focused Calendar AI + Knowledge v2 backend tests
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] 실제 Electron 두 계정 Calendar AI/Wiki AI ETE

건너뛴 gate:

- Gate: 실제 cloud provider 호출
  - Reason: 사용자 플랫폼 credential이 없는 환경에서는 injected provider로 계약을 검증하고, credential 미설정 fail-closed를 실제 표면에서 확인한다.

## Implementation Checklist

- [x] Step 1: 감사 결과와 RED 계약 테스트를 고정한다.
- [x] Step 2: `WorkspaceInferenceBroker`와 Workspace policy를 구현한다.
- [x] Step 3: Calendar AI model completion을 broker로 전환한다.
- [x] Step 4: Knowledge v2 answer synthesis와 citation 재검증을 broker로 전환한다.
- [x] Step 5: Desktop local Wiki inference의 공용 credential 경로를 제거한다.
- [x] Step 6: 두 계정 ETE, 전체 회귀, 비밀 유출 감사를 수행한다.

## Rollback / Fallback

- 새 broker 조립을 되돌리면 기존 Calendar/Wiki 경로로 복귀할 수 있지만 보안 계약을 위반하므로 운영 rollback으로 허용하지 않는다.
- 기능상 fallback은 명시적 unavailable이다. Runner 장애를 다른 Workspace Runner나 Agent Calendar Cloud AI로 자동 우회하지 않는다.
- Agent Calendar Cloud AI는 Workspace 설정의 명시적 mode 변경으로만 선택하며 변경 전후 감사 가능한 비밀 없는 정책만 저장한다.

## Verification Notes

- `node --test apps/backend/tests/phase6-calendar-ai.test.cjs`
  - Result: 5/5 pass. Workspace A/B Runner routing, no implicit cloud, offline/auth/quota, settings secret scrub.
- `node --test apps/backend/tests/phase5-knowledge-v2.test.cjs`
  - Result: 9/9 pass. Broker synthesis, Workspace isolation, revoke race revalidation, encrypted cache.
- `npm run backend:check`
  - Result: pass.
- `npm test`
  - Result: Backend 488/488, Desktop 262/262, Runner 29/29 pass.
- `npm run build:desktop`
  - Result: pass. Vite chunk-size warning only.
- `AGENT_CALENDAR_E2E_TWO_ACCOUNT=1 AGENT_CALENDAR_E2E_TIMEOUT_MS=420000 node apps/desktop/tests/playwright-phase3-golden-ete.cjs`
  - Result: pass in 76,220 ms. Two Workspaces, one Runner each, three completed jobs each including two inference jobs, exact Runner ownership, Account A cold restore.

## Remaining Risks

- Agent Calendar Cloud AI 정책의 전용 Desktop 설정 UI는
  `2026-07-25-workspace-ai-policy-settings.md`에서 구현·검증했다.
- Risk: 실제 Codex/Claude/Grok/Hermes 계정의 quota/auth 만료는 외부 계정 상태에 따라 달라진다.
  - Mitigation: Runner capability 계약과 오류 매핑은 자동화 테스트로 고정했고, 실제 계정 release gate는 별도 live-engine ETE에서 계속 확인한다.
