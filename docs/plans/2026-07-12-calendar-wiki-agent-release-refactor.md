# Calendar Wiki Agent Release Refactor

## Goal

현재 calendar-wiki-ai-spec 변경을 출시 가능한 상태로 만든다. 공개 API 권한, 에이전트 실행 정합성, 데스크톱 사용자 데이터, 로컬 위키 안전성과 완전성, 그래프 상호작용을 실제 사용자 계약에 맞춘다.

## Non-goals

- 새로운 에이전트 기능이나 신규 화면을 추가하지 않는다.
- Obsidian 자체의 물리 엔진을 복제하지 않는다.
- 기존 사용자의 저장 데이터나 다른 작업자의 변경을 삭제하지 않는다.

## Work size

Large / Boundary. Backend gateway, Electron local services, React desktop, persistence contracts, Playwright tests를 함께 변경한다.

## Touched boundaries

- Backend gateway: apps/backend/app/railway-gateway-server.js, apps/backend/app/lib/**
- Electron: apps/desktop/electron/**
- Desktop UI: apps/desktop/src/**
- Contracts/tests: apps/backend/tests/**, apps/desktop/tests/**
- Plans/design evidence: docs/**

## Success criteria

- 공개 Railway API는 구성된 클라이언트 토큰 없이는 쓰기와 민감 읽기를 거부한다.
- 런타임이 없으면 에이전트를 실행 가능/Ready로 표시하거나 가짜 queued run을 만들지 않는다.
- 미션 실패는 선행 작업을 롤백하고, 생성·승인·artifact 계약은 서버 상태와 일치한다.
- 기존 agents-calendar-desktop 사용자 데이터가 새 앱 이름에서도 보존된다.
- 로컬 위키는 symlink 밖 파일을 읽지 않고, 모든 Markdown 노트를 인덱싱하며, 오류가 캘린더 hydration을 막지 않는다.
- 위키 payload는 동일 데이터를 중복 직렬화하지 않고 그래프를 한 번만 만든다.
- 상대 링크와 reciprocal edge가 정확하며 그래프 drag/keyboard/label 동작이 검증된다.
- 전체 테스트, 타입체크, 빌드와 핵심 실제 UI 흐름이 통과한다.

## Edge cases

- 인증 토큰이 구성되지 않은 로컬 개발 환경
- Hermes relay/runtime 부재 또는 지연
- 미션 생성 중 task만 저장된 부분 실패
- 기존/신규 Electron userData 폴더가 동시에 존재
- 누락된 볼트, 빈 문서, heading-only 문서, symlink 문서
- root-relative와 source-relative Markdown 링크 충돌
- dense focus와 local graph 상태에서 node drag 및 키보드 활성화

## Test plan

- Backend API auth/agent fallback/mission tests를 먼저 RED로 추가한다.
- Desktop agent mission rollback, approval, artifact 계약 Playwright를 RED로 추가한다.
- Electron migration/local GET wiki integration tests를 RED로 추가한다.
- Wiki symlink, complete inventory, payload shape, relative link, edge dedupe 단위/통합 테스트를 RED로 추가한다.
- Dense/local drag, keyboard activation, label overlap Playwright를 RED로 추가한다.
- 각 묶음 후 narrow test, typecheck를 실행하고 마지막에 모든 verification gate를 실행한다.

## Acceptance gates

- npm run backend:check
- npm run test:backend
- npm run typecheck
- npm --workspace apps/desktop run test
- 관련 Playwright 시나리오 전체
- npm run build:desktop
- npm test
- 실제 앱에서 위키 질문, 에이전트 탭, 미션 실패/성공 경계, 캘린더 로딩 확인

## Step-by-step checklist

- [x] 공개 API 인증 RED 테스트와 최소 인증 경계를 구현한다.
- [x] offline agent/run이 실행 가능으로 보이지 않도록 RED 테스트와 상태 계약을 구현한다.
- [x] agent create/profile request를 지속 가능한 명시적 상태 계약으로 정리한다.
- [x] mission task rollback, approval 404 rollback, artifact open 계약을 구현한다.
- [x] legacy Electron userData 마이그레이션을 구현한다.
- [x] local wiki 오류를 proxy/hydration 경계에서 격리한다.
- [x] local wiki symlink confinement과 완전한 Markdown inventory를 구현한다.
- [x] wiki payload 중복과 graph 중복 계산을 제거한다.
- [x] relative Markdown link와 reciprocal edge dedupe를 구현한다.
- [x] dense/local graph drag, keyboard activation, label collision 제약을 검증한다.
- [x] 변경 계약을 행동 기반 테스트로 보호한다.
- [x] 날짜 의존 backend tests에 명시적 clock을 주입한다.
- [x] 전체 자동 검증과 실제 UI QA를 통과한다.
- [x] 초기 구현 기준 review-work와 runtime/security gate를 통과한다.
- [x] PostgreSQL의 늦은 stale task upsert가 선점된 Agent Task를 `scheduled`로 되돌리지 못하게 한다.
- [x] scheduler GET 응답에서도 제거된 Hermes profile을 공식 profile로 정규화한다.
- [x] Agent Operations action route가 정확히 네 개 segment인 경로만 수락하게 한다.
- [x] Relay snapshot의 public projection에서 비공식 profile과 unsafe toolset, raw MCP metadata를 제거한다.
- [x] Public state/snapshot을 top-level allowlist로 제한하고 public agent command template과 wrapped tool 누락을 제거한다.
- [x] Relay `data`와 direct `state`/`data`/`data.state` 응답을 같은 공개 상태 계약으로 정규화한다.
- [x] Direct agent 목록에서 런타임의 임의 최상위 필드를 제거하고 현재 Agent Operations 탭에 맞춰 profile Playwright를 갱신한다.
- [ ] 위 후속 회귀를 RED/GREEN으로 검증하고 전체 review-work gate를 다시 통과한다.

## Rollback / fallback

- 인증은 환경 토큰이 없는 명시적 local-only 모드에서만 loopback 요청을 허용한다.
- 런타임 부재 시 생성 대신 503 runtime_unavailable을 반환하고 UI는 unavailable로 표시한다.
- userData 마이그레이션은 원본을 보존한 채 누락 파일만 복사한다.
- 위키 스캔 실패는 빈 위키 오류 응답으로 격리하고 캘린더·작업 데이터는 유지한다.

## Remaining risks

- 95% Obsidian 시각 유사도와 직접 Obsidian 입력 증거는 별도 시각 반복이 필요할 수 있다.
- 현재 대형 App.tsx와 gateway 파일 분리는 행동 수정 후 별도 구조 단계에서만 수행한다.
- Mac mini에서 실행 중인 Hermes runtime의 실제 safe toolset/yolo 설정과 Telegram 환경 변수는 배포 후 별도 live gate가 필요하다.

## Verification results

- `npm run backend:check`: passed.
- `npm run test:backend`: 122/122 passed.
- `npm --workspace apps/desktop run typecheck`: passed.
- `npm --workspace apps/desktop run test`: 75/75 passed.
- `npm run build:desktop`: passed.
- `npm test`: backend 122/122, desktop 75/75 passed.
- Agent create/mission/approval/artifact, wiki graph/ask/search/tree, calendar CRUD Playwright scenarios: passed.
- Live gateway QA: unauthenticated caller 401, authenticated offline agents `Unavailable`, offline run 503.
- Post-push regression QA: task detail format/comment/delegate controls restored; chat, full-page login, and authenticated widget fixtures aligned with the shipped contracts.
- Post-review HTTP QA: legacy scheduler profile normalized to `default`, trailing action route returned 404, exact action route returned 200, unauthenticated scheduler read returned 401.
- Relay projection HTTP QA: app-token reads exposed only official profiles, `toolsets: [safe]`, no MCP command/raw/path metadata; bridge-token diagnostics retained the original snapshot.
- Direct runtime projection QA: `state`, `data`, and `data.state` `/api/state` responses share the same flat sanitized contract; top-level profile readiness and `/api/agents` do not expose setup commands or arbitrary runtime fields.
- Hostile dual-server HTTP QA: direct and Relay public reads retained one sanitized tool/skill plus user tasks, exposed only official profiles and `toolsets: [safe]`, and kept raw diagnostics bridge-only.
- Agent profile Playwright: navigated from the Agent Operations `Missions` default tab to `Agents`, rendered `준비됨`, and hid removed `marketflow` readiness.
