# Plan: Agent Work typography and conversation-load repair

- Date: 2026-07-15
- Owner: Codex
- Work size: Medium
- Status: Final visual review in progress

## Goal

Agent Work Conversation이 데스크톱에서 안정적인 한글 글꼴 계열과 일관된 정보 위계를 사용하고, 큰 작업 대화를 기본 6.5초 요청 제한 때문에 실패로 표시하지 않는다.

## Non-Goals

- Railway 운영 환경에 배포하거나 운영 데이터·자격 증명을 수정하지 않는다.
- Agent Work의 API 계약, DB 스키마, 작업 의미를 변경하지 않는다.
- 기존 공유 작업 트리의 무관한 Agent 기능 변경을 정리하거나 되돌리지 않는다.

## Touched Boundaries

- Backend gateway: 없음
- Backend library: 없음
- DB/migrations: 없음
- Electron bridge: 없음
- React UI: `apps/desktop/src/styles.css`, `apps/desktop/src/features/agent-operations/agent-workspace.css`
- Tests: `apps/desktop/tests/agent-work-timeout.test.mjs`, `apps/desktop/tests/playwright-agent-work-workspace.cjs`
- Docs: `docs/DESIGN.md`, 이 계획

## Success Criteria

- [x] Agent 화면의 한글 글꼴 fallback과 제목/본문 위계가 `docs/DESIGN.md` 토큰 계약에 맞는다.
- [x] Work Conversation 조회와 메시지 전송이 Agent Operations용 요청 예산을 사용해 긴 작업 이력을 성급히 실패 처리하지 않는다.
- [x] 오류가 생겨도 작업 제목, 뒤로가기, 작성 중 메시지, 재시도 경로가 유지된다.
- [x] 실제 로컬 gateway 흐름과 데스크톱 렌더 화면에서 변경을 관찰한다.

## Edge Cases

- CDN 글꼴이 불가능한 macOS Electron 환경에서도 Apple SD Gothic Neo/system fallback으로 한글 메트릭이 안정적이어야 한다.
- 200개 이상 체크포인트의 다음 페이지를 읽는 중에도 기본 API timeout으로 취소되지 않아야 한다.
- 실제 운영 gateway가 미배포라면 로컬 코드는 운영 응답을 조작하거나 성공으로 위장하지 않아야 한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
- [x] 긴 Work Conversation route가 기본 timeout보다 늦게 응답해도 Agent Operations 예산 내에서 파싱되는 테스트를 추가한다.
- [x] Playwright workspace가 한글 fallback과 작업 제목의 정보 위계를 검증하도록 추가하고 현재 CSS에서 실패를 확인한다.
- GREEN:
- [x] Work Conversation GET/POST와 create request에 기존 Agent Operations timeout을 사용하고, 디자인 계약 기반 font stack과 title scale을 적용한다.
- REFACTOR:
- [x] 기존 token/selector를 재사용하고 비관련 Agent 화면을 변경하지 않는다.

## Acceptance Gates

- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `node apps/desktop/tests/playwright-agent-work-workspace.cjs`
- [x] `node apps/desktop/tests/playwright-agent-work-gateway-e2e.cjs`
- [x] `npm run build:desktop`
- [ ] fresh Electron/browser visual QA at 1280px, 768px, 375px, and 200% zoom

건너뛴 gate:

- Gate: Railway production verification/deployment
  - Reason: this repair must not mutate the user's production service or credentials.

## Implementation Checklist

- [x] Step 1: screenshot, CSS, proxy, API client, and real local browser evidence establish the timeout/font hypotheses.
- [x] Step 2: write and run focused RED tests for timeout and typography hierarchy.
- [x] Step 3: apply the narrow API timeout and design-token typography fixes.
- [x] Step 4: run focused/full desktop tests, real local gateway browser path, Electron surface, and fresh responsive captures.

## Verification Notes

- Command: `node /tmp/agent-font-conversation-repro.mjs`
  - Result: Vite renderer loads Pretendard when CDN is reachable, but unauthenticated direct Vite requests receive `401 caller_unauthorized`; it cannot validate the credentialed Electron path. Source still has a CDN-only Pretendard dependency and omits the macOS Korean fallback.
- Command: source inspection
  - Result: `getAgentWorkConversation` and `sendAgentWorkMessage` use the 6.5-second default while slower Agent Operations calls use `AGENT_OPERATIONS_TIMEOUT_MS = 400_000`.
- RED: a delayed Work Conversation response failed at 6,509ms under the generic API limit; the original workspace assertions also failed for the missing macOS Korean fallback, the oversized title, a covering narrow composer, and a mobile rejected-message predicate split.
- GREEN: the focused timeout test accepts a 7,000ms response; the workspace test validates `Apple SD Gothic Neo` fallback, a 24px-or-smaller title, CJK predicate wrapping, truthful post-send refresh failure feedback, no narrow composer overlap, and fresh 1280/768/375/200% captures.
- Command: `npm run typecheck` — passed.
- Command: `npm --workspace apps/desktop run test` — 106/106 passed. Vite printed four non-failing `24678 already in use` HMR warnings from the SSR test harness.
- Command: `node apps/desktop/tests/playwright-agent-work-gateway-e2e.cjs` — passed, with 70 real local gateway API responses and restart persistence.
- Command: `npm run build:desktop` — passed; renderer and Electron builds completed.

## Remaining Risks

- Risk: the current installed desktop app may point at an older Railway deployment missing the new Work Conversation route.
  - Mitigation: prove local gateway/Electron behavior without production mutation; surface any remaining deployment mismatch explicitly rather than masking it.
- Risk: the Vite SSR test harness reports its known HMR port-24678 collision while all tests pass.
  - Mitigation: treat it as a separate, non-product test-harness cleanup item; it does not change test outcomes or renderer behavior.
