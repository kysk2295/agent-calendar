# Plan: 지속형 에이전트 프로필·기억·실시간 작업

- Date: 2026-07-26
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified

## Goal

사용자가 Argo의 크루 프로필처럼 이름, 역할, 책임, 행동 지침, 말투와 성격,
전문 분야, 계속 기억할 내용을 조합해 특성이 분명한 담당 에이전트를 만들고
수정할 수 있게 한다.

저장된 프로필은 Workspace DB에 영속화하고 버전을 올리며, Delegated Work 실행마다
당시 프로필과 기억을 비밀 없는 스냅샷으로 고정해 실제 Runner 실행 입력에 적용한다.
사용자는 에이전트 카드에서 프로필 버전과 기억 상태를 확인하고 기존 Work
Conversation의 SSE 실시간 진행을 계속 관찰할 수 있어야 한다.

## Non-Goals

- 모든 대화를 자동으로 장기 기억으로 승격하지 않는다.
- LLM이 사용자 확인 없이 기억을 생성·수정·삭제하지 않는다.
- Calendar AI Personal Memory, Workspace Knowledge, provider-native session context를
  에이전트 기억과 합치지 않는다.
- 이번 단계에서 도구 grant, Approval policy, skill marketplace를 구현하지 않는다.
- 외부 provider credential이나 원본 provider 설정을 Gateway에 저장하지 않는다.
- 기존 provider-native session 연속성 및 Telegram 채널 구현을 다시 설계하지 않는다.

## Work Size

Large / Boundary. Agent payload의 persisted meaning, durable execution job 입력,
Runner가 받는 실행 문맥, Desktop agent editor와 테스트를 함께 변경한다.

## Touched Boundaries

- Backend gateway:
  - 기존 Workspace-scoped `/api/agents` CRUD 계약의 공개 필드 확장
  - 기존 durable work 및 Work Conversation turn 생성 경로 유지
- Backend library:
  - agent profile 정규화, 프로필 버전, 실행 스냅샷
  - 신규 작업과 후속 turn의 실제 실행 goal에 profile context 적용
- DB/migrations:
  - 신규 테이블 없음
  - 기존 `agents.payload` JSONB와 `execution_jobs.payload` JSONB에 하위 호환 필드 추가
- Electron bridge:
  - 변경 없음
- React UI:
  - 에이전트 생성/편집의 말투와 성격, 계속 기억할 내용
  - 카드의 프로필 버전·기억 개수·실시간 작업 지원 표시
- Runner:
  - 기존 `goal` 실행 계약 유지
  - Gateway가 구성한 profile-aware goal을 기존 어댑터가 그대로 실행
- Tests:
  - agent normalization/versioning unit
  - durable execution profile snapshot/application
  - Desktop Argo-derived structure and Playwright interaction
- Docs:
  - 이 계획과 검증 결과

## Success Criteria

- [x] 사용자가 `말투와 성격`과 여러 개의 `계속 기억할 내용`을 생성·편집할 수 있다.
- [x] 프로필과 기억은 agent payload에 Workspace-scoped로 저장되고 다시 읽힌다.
- [x] 의미 있는 프로필 수정 때 `profileVersion`이 증가하며 legacy agent는 v1로 보인다.
- [x] 새 Delegated Work는 당시 agent profile snapshot을 mission/job에 기록한다.
- [x] Runner에 전달되는 실제 goal에는 역할, 책임, 지침, 스타일, 전문 분야, 기억이
      명확히 구분된 profile context로 포함된다.
- [x] 프로필 수정 후 새 작업은 새 버전을 사용하고 기존 실행 snapshot은 바뀌지 않는다.
- [x] 후속 Work Conversation turn도 실행 시점의 profile snapshot을 기록하고 적용한다.
- [x] 에이전트 카드에서 profile version, 기억 개수, 실시간 작업 지원 상태를 본다.
- [x] 기존 SSE delta/checkpoint/done 실시간 대화가 회귀하지 않는다.
- [x] secret-like 임의 요청 필드는 profile snapshot과 공개 응답에 포함되지 않는다.

## Edge Cases

- Legacy agent:
  - 새 필드가 없으면 빈 스타일·빈 기억과 profile v1로 projection한다.
- 빈 기억:
  - 기억 섹션을 실행 prompt에 추가하지 않고 UI에는 `저장된 기억 없음`으로 표시한다.
- 중복/긴 기억:
  - 공백 정규화 후 중복을 제거하고 개수와 각 항목 길이를 제한한다.
- 연결된 agent:
  - Agent Calendar overlay profile을 provider reference와 분리해 적용한다.
- 프로필 수정 중 기존 작업 실행:
  - job payload의 snapshot을 사용하므로 실행 의미가 바뀌지 않는다.
- 악성 프로필 텍스트:
  - 고정된 구분자와 길이 제한을 사용하고 credential-like 별도 필드는 수집하지 않는다.
- 실시간 연결 중단:
  - 기존 partial response/error/refresh fallback을 유지한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] `workspace-agent-directory.test.cjs`에 style/memory/version 정규화와 version bump 테스트
  - [x] `phase3-durable-execution.test.cjs`에 profile snapshot과 effective goal 테스트
  - [x] `argo-agent-control-design.test.mjs`에 프로필·기억·실시간 표시 구조 테스트
  - [x] `playwright-argo-agent-control.cjs`에 생성 payload와 카드 재표시 테스트
- GREEN:
  - [x] JSONB 하위 호환 profile 필드 및 버전 계산
  - [x] 비밀 없는 immutable execution snapshot과 profile-aware goal
  - [x] Desktop editor/card 최소 UI
- REFACTOR:
  - [x] profile context 구성기를 backend helper로 격리
  - [x] UI form ↔ API 변환에서 기억 정규화를 한 곳에 유지

## Acceptance Gates

- [x] `node --test apps/backend/tests/workspace-agent-directory.test.cjs`
- [x] 관련 durable execution 집중 테스트
- [x] `node --test apps/desktop/tests/argo-agent-control-design.test.mjs`
- [x] `node apps/desktop/tests/playwright-argo-agent-control.cjs`
- [x] `node --test apps/desktop/tests/agent-work-live-stream.test.mjs`
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`

건너뛴 gate:

- Gate:
  - Reason:

## Rollback / Fallback

- 새 profile 필드는 기존 JSONB의 선택 필드라 구형 Desktop과 Runner 계약을 깨지 않는다.
- profile snapshot 적용 문제가 생기면 goal 구성기 호출만 제거해 기존 raw goal 실행으로
  되돌릴 수 있고 저장된 프로필 데이터는 유지된다.
- UI 필드는 기존 create/edit dialog 안에 추가되므로 해당 입력과 카드 행만 제거할 수 있다.
- 기존 job은 자체 snapshot 또는 기존 raw goal을 보존하므로 migration rollback이 필요 없다.

## Step-by-Step Checklist

- [x] Step 1: profile 공개 필드, 정규화, version bump 규칙을 테스트로 고정한다.
- [x] Step 2: immutable execution snapshot과 effective goal을 테스트로 고정한다.
- [x] Step 3: backend normalization과 durable execution 적용을 구현한다.
- [x] Step 4: Desktop 타입, form, 카드, styling을 구현한다.
- [x] Step 5: create/edit/delegate/실시간 상태를 집중 테스트한다.
- [x] Step 6: 전체 회귀와 실제 UI 수동 QA를 수행한다.
- [x] Step 7: 검증 결과와 남은 위험을 이 문서에 기록한다.

## Verification Notes

- `node --test apps/backend/tests/workspace-agent-directory.test.cjs`
  - 6/6 pass. profile normalization, versioning, bounded snapshot, effective goal 확인.
- `node --test --test-name-pattern='Work Conversation follow-up leases|one Work Conversation switches' apps/backend/tests/phase3-durable-execution.test.cjs`
  - 2/2 pass. 서버 재시작, provider session reuse, v1→v2 immutable job snapshot 확인.
- `node --test apps/desktop/tests/agent-work-live-stream.test.mjs`
  - 14/14 pass. accepted/delta/checkpoint/error/done와 빈 Runner fallback 확인.
- `node apps/desktop/tests/playwright-argo-agent-control.cjs`
  - light pass. profile 입력, 기억 2개 API payload, 카드 재표시, 위임, 실시간 대화 확인.
- `AGENT_CALENDAR_E2E_THEME=dark node apps/desktop/tests/playwright-argo-agent-control.cjs`
  - dark pass. 동일 상호작용과 overflow 확인.
- `npm run backend:check`
  - pass.
- `npm run typecheck`
  - pass.
- `npm run test:backend`
  - 513/513 pass.
- `npm --workspace apps/desktop run test`
  - 290/290 pass.
- `npm run test:runner`
  - pass.
- `npm run build:desktop`
  - pass. 기존 500 kB chunk warning만 유지.
- `npm test`
  - Backend 513 + Desktop 290 + Runner 58 = 861/861 pass.
- Visual evidence:
  - `apps/desktop/test-results/argo-agent-control/default-create-agent.png`
  - `apps/desktop/test-results/argo-agent-control/default-profile-memory-card.png`
  - dark mode의 대응 이미지도 같은 디렉터리에서 확인.

## Remaining Risks

- 자동 기억 추출이 없으므로 사용자가 장기 기억을 직접 관리해야 한다.
- profile text는 provider-native system role이 아니라 고정 구분된 실행 context로
  전달된다. 각 provider CLI가 공식 system instruction 입력을 안정적으로 제공하면
  후속 단계에서 adapter별 system channel로 강화할 수 있다.
- 현재 dirty worktree의 provider session, cross-channel, Runner 변경과 같은 파일을
  공유하므로 기존 사용자 변경을 보존하며 최소 범위로 수정해야 한다.
