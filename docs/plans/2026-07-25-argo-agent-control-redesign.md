# Plan: Argo 기반 에이전트 디렉터리 슬라이스

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified

## Scope clarification

이 문서는 **에이전트 디렉터리와 위임 진입점 슬라이스만** 검증한 기록이다.
Provider-native agent catalog, 실제 provider session과 Work Conversation의 1:1 연결,
같은 session에 대한 후속 지시, 앱/Runner 재시작 이후 복구는 이 계획의 완료 범위가
아니다. 따라서 이 문서의 `Verified`는 Agent Calendar의 전체 에이전트 기능 완료를
뜻하지 않는다.

후속 Large/Boundary 구현과 실제 ETE 완료 기준은
`docs/plans/2026-07-25-provider-native-agent-session-bridge.md`가 소유한다.

## Goal

설치된 Argo에서 관찰한 팀별 에이전트 명단, 한 줄 생성, 역할 카드, 작업 대화,
스킬·도구와 실행 엔진의 점진적 공개 방식을 Agent Calendar의 에이전트 작업 관제
공간에 맞게 구현한다.

사용자는 한 Workspace 안에서 직접 담당 에이전트를 만들거나 Hermes 및 다른 외부
시스템의 에이전트를 Runner 경유 참조로 연결하고, 해당 에이전트를 선택해 위임
작업을 시작하며, 기존 Work Conversation에서 결과와 개입을 이어갈 수 있어야 한다.

## Non-Goals

- Argo의 회사·크루·기억 용어와 시각 자산을 그대로 복제하지 않는다.
- Responsible Agent를 모델 또는 Execution Engine과 합치지 않는다.
- 외부 시스템의 OAuth, API key, CLI session을 Gateway DB로 가져오지 않는다.
- 이번 단계에서 스킬 마켓, 메신저 봇, 모바일 화면을 새로 만들지 않는다.
- 외부 에이전트 원격 카탈로그 자동 검색과 실제 provider session 연결은 이
  디렉터리 슬라이스에서 구현하지 않는다. 이번 연결은 Runner가 사용할 외부
  에이전트 식별자를 Workspace에 등록하는 비밀 없는 reference 연결이다.

## Touched Boundaries

- Backend gateway: 기존 `/api/agents` Workspace-scoped CRUD 계약 유지
- Backend library:
  - Workspace agent 입력 정규화, source/reference 계약, secret 차단
  - 연결 상태와 담당 에이전트 공개 projection
- DB/migrations: 기존 `agents.payload` JSONB와 `workspace_id` 사용, 신규 migration 없음
- Electron bridge: 변경 없음
- React UI:
  - Agent Work Control Space의 에이전트 디렉터리
  - 직접 생성, 외부 연결, 편집 흐름
  - 에이전트 선택과 Delegated Work 위임 연결
- Tests:
  - agent directory domain
  - backend Workspace A/B 격리 및 secret 비저장
  - Desktop 구조·행동·실제 Electron QA
- Docs: 이 계획과 검증 증거

## Argo Benchmark Translation

- 왼쪽 팀별 크루 명단 → `내 에이전트`와 `연결된 에이전트`로 구분된 담당 에이전트
  디렉터리
- 한 줄 크루 영입 → 이름·역할·책임을 먼저 받는 짧은 직접 생성 흐름
- 크루 카드 → 책임, 지침, 전문 분야, 출처, 준비 상태를 보여주는 에이전트 카드
- 크루 대화 세션 → 자유 채팅이 아니라 Delegated Work별 Work Conversation
- 엔진 선택 → 고급 설정의 Execution Engine이며 담당 에이전트보다 시각적으로 후순위
- 스킬·도구 → 이번 범위에서는 에이전트의 선언된 전문 분야와 Runner 연결 상태만 표시
- 기억 → Personal Memory와 에이전트 지침을 혼합하지 않음

## Success Criteria

- [x] Control Home과 Work Conversation 양쪽에서 에이전트 디렉터리가 일관되게 유지된다.
- [x] 사용자는 이름, 역할, 책임, 지침, 전문 분야로 Workspace-owned 에이전트를 만든다.
- [x] 사용자는 Hermes, Claude, Codex, Grok 또는 사용자 정의 제공자의 외부 에이전트
      식별자를 비밀 없이 연결한다.
- [x] 연결된 에이전트는 Runner 연결 전에는 `Runner 필요`, 연결 후에는 `연결됨`으로
      정직하게 표시되며 사용 가능 여부가 구분된다.
- [x] 에이전트를 선택해 위임하면 정확한 agent id가 durable work 요청에 기록된다.
- [x] Source/provider/engine/Runner는 서로 다른 필드와 레이블로 표시된다.
- [x] User A/Workspace A의 에이전트가 User B/Workspace B에 노출되지 않는다.
- [x] token, API key, cookie, credential은 agent payload, 응답, 테스트 evidence에
      저장되거나 표시되지 않는다.
- [x] 1280px, 768px, 375px 및 light/dark에서 잘림과 수평 overflow가 없다.

## Edge Cases

- 에이전트 없음:
  - 전체 작업은 계속 보이고 생성·연결 진입점이 명확해야 한다.
- Runner 없음:
  - 직접 만든 에이전트는 저장 가능하지만 실제 실행은 기존 durable waiting 상태를
    따른다.
  - 외부 연결 에이전트는 `Runner 필요`로 표시되고 연결 전에는 선택할 수 없다.
- 외부 식별자 중복:
  - 같은 Workspace 안에서 같은 provider/externalAgentId 중복을 거부한다.
- 긴 한국어 이름·책임:
  - 행과 카드가 줄바꿈하고 전체 레이아웃을 넓히지 않는다.
- Legacy agent payload:
  - 기존 name/role/source 데이터는 삭제하지 않고 새 projection 기본값으로 표시한다.
- 미지원 비밀 필드:
  - 요청에 포함되어도 저장하지 않고 응답에도 포함하지 않는다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] agent directory grouping/status/selectability domain test
  - [x] native/connected agent 입력 정규화와 secret 차단 test
  - [x] Workspace A/B 생성·목록·위임 격리 integration test
  - [x] Argo-derived directory/create/connect/card UI structure test
  - [x] create/connect/select/delegate Playwright behavior test
- GREEN:
  - [x] 기존 agents JSONB와 `/api/agents` 계약을 확장하는 최소 구현
  - [x] 기존 Agent Work 상태/대화 로직을 보존하는 directory shell
- REFACTOR:
  - [x] 구형 agent modal 로직을 공통 mutation callback으로 통합
  - [x] 중복 source/status 레이블을 domain helper로 이동

## Acceptance Gates

- [x] `node --test apps/backend/tests/workspace-agent-directory.test.cjs`
- [x] `node --test apps/backend/tests/phase1-full-gateway-workspace-cutover.test.cjs`
- [x] `node --test apps/desktop/tests/agent-roster-domain.test.mjs`
- [x] `node --test apps/desktop/tests/argo-agent-control-design.test.mjs`
- [x] `node apps/desktop/tests/playwright-argo-agent-control.cjs`
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] 실제 Electron light/dark 및 세 너비 QA

건너뛴 gate:

- Mobile:
  - 사용자가 모바일을 마지막 단계로 지정했으므로 이번 범위에서 제외한다.

## Rollback / Fallback

- 새 source/reference 필드는 기존 JSONB payload의 선택 필드이므로 이전 Desktop은
  name/role/status만 읽고 계속 동작한다.
- UI 문제가 생기면 directory shell만 제거해 기존 Control Home과 Work Conversation로
  되돌릴 수 있다.
- 입력 정규화는 기존 legacy payload의 list projection을 유지한다.

## Implementation Checklist

- [x] Step 1: 설치된 Argo의 데크, 크루 대화, 카드, 활동, 스킬·도구, 설정을 읽기
      전용으로 관찰한다.
- [x] Step 2: agent source/reference backend contract와 secret 경계를 테스트로 고정한다.
- [x] Step 3: Agent Work용 directory domain과 UI 구조 테스트를 작성한다.
- [x] Step 4: Workspace agent CRUD와 Desktop mutation callbacks을 구현한다.
- [x] Step 5: directory, create/connect/card interaction을 구현한다.
- [x] Step 6: 집중 테스트, 전체 회귀, 실제 Electron 시각·상호작용 QA를 수행한다.

## Verification Notes

- Argo 0.1.26 직접 관찰:
  - 데크의 한 줄 영입과 이름/팀 고급 옵션
  - 팀별 크루 표와 상태
  - 에이전트별 세션 레일, 역할 카드, 규칙, 스킬, 엔진
  - 스킬 직접 생성과 로컬 도구 가져오기
  - 활동 타임라인과 Runner/엔진 연결 설정
- Agent Calendar 현재 감사:
  - `/api/agents`는 Workspace-scoped CRUD지만 source/reference schema가 없다.
  - Control Home에는 상태 카드만 있고 생성·연동·편집 흐름이 없다.
  - 구형 생성 모달은 Agent Work 화면과 분리되어 있다.
  - durable work는 arbitrary agent id를 보존하지만 이 계약을 UI와 격리 테스트가
    보장하지 않는다.
- TDD:
  - 첫 RED에서 backend 정규화 모듈, directory domain helper,
    `AgentDirectoryPanel` 부재로 예상대로 실패했다.
  - 최소 구현 뒤 같은 집중 테스트가 모두 통과했다.
- 자동 검증:
  - Backend 전체: 491/491 통과
  - Desktop 전체: 267/267 통과
  - Runner 전체: 29/29 통과
  - `npm test`, backend syntax, Desktop typecheck와 build 모두 exit 0
- 실제 표면 QA:
  - light/dark에서 직접 생성, Hermes reference 연결, 편집, 선택, 위임을 실행했다.
  - 위임 요청에 선택한 connected agent id가 그대로 전달되는 것을 관찰했다.
  - 1280px, 768px, 375px에서 기존 Control Home과 Work Conversation 회귀를 확인했다.
  - 375px에서는 에이전트 디렉터리를 감추고 대화가 전체 폭을 사용하며 수평 overflow가
    없음을 확인했다.
  - 증거 이미지는 `apps/desktop/test-results/argo-agent-control/`에 보관한다.

## Remaining Risks

- 외부 agent reference가 실제 Runner provider profile과 일치하는지, 실제 provider
  session을 계속 재개하는지는 이 계획으로 검증되지 않았다.
- 외부 catalog discovery, provider session mapping, durable history, session lifecycle은
  `2026-07-25-provider-native-agent-session-bridge.md`에서 구현·검증한다.
- Desktop build는 성공했지만 Vite가 기존 main bundle의 500 kB 초과 경고를 출력한다.
- 현재 dirty worktree의 대규모 production 변경과 겹치는 파일은 최소 범위로
  수정하고 사용자 변경을 되돌리지 않는다.
