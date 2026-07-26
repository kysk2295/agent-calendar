# Plan: Phase 8 Desktop Offline Truth and Reconnect Recovery

- Date: 2026-07-25
- Owner: Codex
- Work size: Large | Boundary
- Status: Verified
- Parent: `docs/plans/2026-07-24-production-development-roadmap.md`

## Goal

로그인한 Desktop이 Railway 또는 네트워크 단절을 빈 Workspace로 오인하지 않게 한다.
마지막으로 정상 동기화한 캘린더와 제품 상태를 그대로 보여 주면서 연결 끊김을 명확히
알리고, 백엔드가 복구되면 재로그인 없이 현재 Workspace를 다시 동기화한다.

## Non-Goals

- 오프라인 상태에서 새로운 일정이나 위임 작업을 로컬에 큐잉
- Desktop 재실행 뒤 사용할 영구 로컬 Workspace 데이터베이스
- WorkOS, Google, Runner 공급자 자체의 장기 장애 복구
- 코드 서명, notarization, 자동 업데이트
- Web 또는 Mobile 구현

## Work Size

React의 전체 제품 hydration 의미, 인증된 세션 중 네트워크 오류 처리, 실제 Electron
재연결 워크플로를 바꾸므로 Large | Boundary다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 기존 secure session과 loopback proxy를 실제 ETE에서 사용
- React UI: `apps/desktop/src/App.tsx`, `apps/desktop/src/styles.css`,
  `apps/desktop/src/features/connectivity/**`
- Tests: 순수 연결 상태 테스트, AuthKit 기반 Electron offline/reconnect ETE,
  기존 Phase 8 session truth와 Phase 3 golden ETE
- Docs: 이 계획, roadmap Phase 8, evidence JSON

## Success Criteria

- [x] 첫 정상 hydration 뒤 Gateway가 실패해도 기존 Calendar, 작업, Wiki, 자동화,
      Runner 상태를 빈 fallback으로 교체하지 않는다.
- [x] 연결이 끊기면 마지막 정상 동기화 시각과 “표시 중인 데이터 유지”를 담은 간결한
      상태가 보이고 수동 재시도 동작이 제공된다.
- [x] 브라우저 `online` 이벤트와 오프라인 백오프 재시도가 인증된 hydration을 다시
      실행한다.
- [x] Gateway가 돌아오면 재로그인 없이 같은 Workspace 세션으로 최신 snapshot을
      적용하고 복구 상태를 사용자에게 알린다.
- [x] 개별 API 오류는 기존 `Railway API 확인 필요` 오류로 남고 전체 연결 끊김으로
      잘못 분류되지 않는다.
- [x] stale-profile 보호, secure-session 재실행, Runner checkpoint, Calendar result ETE가
      회귀하지 않는다.

## Edge Cases

- 첫 로그인 직후 아직 정상 snapshot이 없을 때 Gateway가 실패함
- 정상 snapshot 뒤 모든 제품 요청이 동시에 502/503을 반환함
- 연결이 끊긴 상태에서 재시도를 여러 번 누름
- OS는 online이지만 Railway만 일시적으로 응답하지 않음
- Gateway는 정상이지만 Wiki 같은 선택적 endpoint 하나만 실패함
- 로그아웃 중 예약된 재시도가 실행될 예정임

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] `desktop-connectivity-state.test.mjs`가 없는 연결 상태 모듈 때문에 실패한다.
  - [x] `playwright-phase8-offline-reconnect.cjs`가 offline 상태에서 Calendar 항목 보존
        또는 전용 상태 표시 부재로 실패한다.
- GREEN:
  - [x] 단일 gateway probe 결과로 연결 상태를 전이하고, 실패한 hydration은 마지막
        정상 AppState를 그대로 둔다.
  - [x] online 이벤트와 제한된 background retry가 복구 hydration을 실행한다.
  - [x] 기존 warm-neutral token으로 compact offline/recovered 상태를 표시한다.
- REFACTOR:
  - [x] 상태 전이와 표시 문구만 순수 모듈에 두고 App의 제품 데이터 parsing은 옮기지
        않는다.

## Manual QA Scenarios

1. `node apps/desktop/tests/playwright-phase8-offline-reconnect.cjs`
   - 입력: fake production AuthKit 로그인, `Reconnect proof event`가 있는 정상 Gateway,
     browser offline 이벤트와 unavailable Gateway
   - PASS: 이벤트가 계속 보이고 `연결 끊김`, `표시 중인 데이터 유지`, 마지막 동기화
     문구가 나타나며 session이 signed-in 상태다.
   - 증거: `01-online-calendar.png`, `02-offline-retained.png`
2. 같은 Electron 프로세스에서 Gateway를 복구하고 browser online 이벤트를 보낸다.
   - PASS: 인증된 product 요청이 다시 성공하고 재로그인 없이 연결 상태가 정상화되며
     이벤트가 계속 보인다.
   - 증거: `03-reconnected-calendar.png`, ETE JSON 요약
3. 기존 `playwright-phase8-session-truth.cjs`와
   `playwright-phase3-golden-ete.cjs`를 실행한다.
   - PASS: 로그인 진실성, 암호화 세션 재실행, Runner 작업, checkpoint, Calendar 결과,
     backend/Desktop restart가 모두 유지된다.

## Acceptance Gates

- [x] Targeted connectivity unit tests
- [x] Phase 8 offline/reconnect Electron ETE
- [x] Phase 8 session truth Electron ETE
- [x] Phase 3 golden ETE
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] Light and dark screenshot review
- [x] No orphan Electron, backend, Runner, or PostgreSQL process
- [x] HEAVY read-only reviewer approval

건너뛴 gate:

- LSP diagnostics:
  - Reason: 현재 TSX 문서에 Deno LSP가 잘못 연결되어 document-symbol 요청이 timeout됐다.
    TypeScript typecheck와 production build를 blocking 대체 gate로 사용한다.

## Implementation Checklist

- [x] Step 1: 계획과 정확한 QA 조건 작성
- [x] Step 2: 연결 상태 순수 테스트 RED
- [x] Step 3: Electron offline retention RED
- [x] Step 4: 연결 상태 모듈 GREEN
- [x] Step 5: hydration snapshot 보존
- [x] Step 6: offline/online listener와 retry
- [x] Step 7: compact 상태 UI
- [x] Step 8: Electron GREEN과 화면 검수
- [x] Step 9: 인접 ETE와 전체 gate
- [x] Step 10: reviewer, cleanup, evidence, roadmap

## Rollback and Fallback

- 이 slice를 이전 signed Desktop build로 되돌린다.
- 연결 실패 중에는 기존 동작처럼 수동 `재시도`를 유지하되, 정상 snapshot을 삭제하지
  않는다.
- 새 연결 상태 모듈은 DB나 API contract를 변경하지 않아 서버 롤백과 독립적이다.

## Verification Notes

- RED: pure test failed because the connectivity module did not exist; Electron ETE then failed
  because the signed-in Desktop had no offline truth surface.
- GREEN: light and dark Electron ETE retained `Reconnect proof event`, kept the secure session,
  failed a retry truthfully, recovered without login, and restored after Desktop restart.
- Adjacent ETE: Phase 8 session truth and Phase 3 golden Runner/Engine/checkpoint/Calendar journey
  passed.
- Full gates: backend syntax passed; `npm test` passed with Backend, Desktop 199/199, Runner 19/19.
- Read-only HEAVY review: APPROVED with no criterion-linked blocker. Non-blocking follow-ups are
  source-regex test brittleness, the existing oversized `App.tsx`, and optional in-flight retry
  deduplication.
- Evidence: `docs/operations/evidence/2026-07-25-phase8-desktop-offline-reconnect.json`.

## Remaining Risks

- Resolved follow-up: 완전 종료 후 offline 재실행은 safeStorage 암호화,
  User/Workspace/session 격리, 7일 보존, 8 MiB 상한을 갖춘 cold-start snapshot으로
  검증했다.
  - Evidence: `docs/plans/2026-07-25-phase8-encrypted-cold-start-snapshot.md`
- Risk: 모든 오프라인 사용자의 같은 간격 재시도가 복구 시 몰릴 수 있다.
  - Mitigation: 최대 간격이 있는 증가형 retry와 online 이벤트의 즉시 재시도를 사용한다.
