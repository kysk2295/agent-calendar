# Plan: Workspace AI 실행 정책 설정

- Date: 2026-07-25
- Owner: Codex
- Work size: Medium / Boundary
- Status: Verified

## Goal

각 Workspace 사용자가 설정 화면에서 Calendar AI와 Wiki AI의 기본 추론 경로를
확인하고, 자신의 Runner 또는 명시적인 Agent Calendar Cloud AI 중 하나를 선택할
수 있게 한다. Runner 모드에서는 Codex, Claude, Grok, Hermes 또는 자동 선택을
비밀 없이 지정한다.

## Non-Goals

- OAuth, API key, CLI session, cookie를 Desktop이나 Gateway 설정에 입력·저장하지 않는다.
- Runner 내부의 제공자 로그인 흐름을 설정 화면으로 옮기지 않는다.
- Agent Calendar Cloud AI 결제·요금제 UI는 이번 범위에 포함하지 않는다.
- Mobile 화면은 시작하지 않는다.

## Touched Boundaries

- Backend gateway: 기존 `/api/settings` 계약 사용, 신규 route 없음
- Backend library: 기존 `normalizeInferencePolicy`와 secret scrub 계약 유지
- DB/migrations: 기존 `state_meta.workspace_settings` 사용, 신규 migration 없음
- Electron bridge: 변경 없음
- React UI: Desktop 설정 overlay의 `AI 실행` pane
- Tests: 정적 설계 계약, Playwright 저장·재진입·오류 복구
- Docs: 이 계획과 검증 기록

## Success Criteria

- [x] 설정에서 현재 Workspace의 Runner/Cloud 모드와 기본 엔진을 읽어 표시한다.
- [x] Runner 모드에서 자동, Codex, Claude, Grok, Hermes를 선택하고 저장한다.
- [x] Cloud 모드는 명시적인 사용자 선택과 확인 문구가 있어야만 저장된다.
- [x] 설정 요청에는 `mode`와 `defaultEngine`만 포함되며 credential 입력이 없다.
- [x] 저장 실패 시 이전 정책을 유지하고 정직한 오류를 표시한다.
- [x] 다른 Workspace의 정책이나 Runner 식별자를 표시하지 않는다.
- [x] light/dark와 작은 Desktop 폭에서 잘림이나 수평 overflow가 없다.

## Edge Cases

- 설정 응답이 비어 있음: 안전한 기본값 `runner/auto`를 표시한다.
- Cloud AI가 서버에 구성되지 않음: 선택은 저장 가능하되 실제 질의는 기존
  `AGENT_CALENDAR_CLOUD_AI_UNAVAILABLE` 계약으로 fail closed 한다.
- 저장 중 중복 클릭: 버튼을 비활성화하고 한 번만 요청한다.
- 저장 실패: 선택 초안을 남기되 적용 상태로 표시하지 않는다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] AI 실행 pane, 모드·엔진 선택, credential input 부재 구조 테스트
  - [x] Runner 정책 저장과 Cloud 명시 선택 Playwright 테스트
  - [x] 저장 실패 시 오류·기존 정책 유지 테스트
- GREEN:
  - [x] 설정 envelope 정규화와 저장 callback
  - [x] 간결한 AI 실행 pane
- REFACTOR:
  - [x] 정책 타입과 정규화를 Desktop domain helper로 분리

## Acceptance Gates

- [x] 집중 Desktop 테스트
- [x] `node --test apps/backend/tests/phase6-calendar-ai.test.cjs`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] 실제 renderer light/dark 및 작은 폭 QA

건너뛴 gate:

- Gate: 실제 Agent Calendar Cloud provider 호출
  - Reason: 플랫폼 credential이 없는 환경에서는 기존 fail-closed backend 계약을
    유지하며 UI는 비밀 없는 Workspace 정책만 저장한다.

## Implementation Checklist

- [x] Step 1: 기존 Broker, `/api/settings`, Desktop 설정 구조를 감사한다.
- [x] Step 2: 실패 테스트로 정책 표시·저장·비밀 부재 계약을 고정한다.
- [x] Step 3: AI 실행 pane과 저장 상태를 구현한다.
- [x] Step 4: 집중·전체 회귀와 실제 표면 QA를 수행한다.

## Verification Notes

- `node --test apps/desktop/tests/workspace-inference-policy.test.mjs apps/desktop/tests/workspace-inference-policy-design.test.mjs`
  - Result: RED는 모듈·pane 부재로 예상대로 실패, 구현 후 4/4 통과.
- `node --test apps/backend/tests/phase6-calendar-ai.test.cjs apps/backend/tests/phase5-knowledge-v2.test.cjs`
  - Result: 14/14 통과. same-Workspace Runner, explicit Cloud opt-in, Wiki citation 재검증 포함.
- `npm run typecheck`
  - Result: pass.
- `npm --workspace apps/desktop run test`
  - Result: 271/271 통과.
- `npm run build:desktop`
  - Result: pass. 기존 500 kB 초과 chunk 경고만 남음.
- `node apps/desktop/tests/playwright-workspace-inference-policy.cjs`
  - Result: light/dark 모두 통과. Runner/Hermes 저장, Cloud 확인 저장, 실패 시 적용 정책 보존,
    720px 수평 overflow 0 확인.
- Screenshot:
  - `apps/desktop/test-results/workspace-inference-policy/default-desktop.png`
  - `apps/desktop/test-results/workspace-inference-policy/dark-desktop.png`
  - `apps/desktop/test-results/workspace-inference-policy/default-compact.png`

## Remaining Risks

- Risk: Cloud AI의 사용 가능 여부와 비용 정보는 현재 settings 응답에 없다.
  - Mitigation: Cloud 선택이 자동 fallback이 아님을 명시하고, 실제 호출은 기존
    Broker의 fail-closed 오류를 그대로 사용한다.
- Risk: Vite main bundle이 500 kB를 넘는 기존 경고가 남아 있다.
  - Mitigation: 기능과 별개인 route-level code splitting을 후속 성능 범위로 유지한다.
