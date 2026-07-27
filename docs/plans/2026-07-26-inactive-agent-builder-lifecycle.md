# Plan: Inactive one-line agent builder lifecycle

- Date: 2026-07-26
- Owner: Codex
- Work size: Large / Boundary
- Status: Complete; independently reviewed and approved

## Goal

한 줄 에이전트 요청을 영속적인 비활성 초안으로 만들고, 명시적 검토와
부작용 없는 제한 테스트가 성공한 뒤에만 프로필 버전을 활성화한다. 활성
프로필 수정은 새 버전을 만들며 기존 실행 작업의 프로필 snapshot은 바꾸지
않는다.

## Non-Goals

- 범용 프롬프트 생성기, 마켓플레이스, 자동 권한 승인, 외부 전송 기능을 만들지 않는다.
- 테스트 실행을 Calendar event, scheduler projection, mail/channel delivery로 투영하지 않는다.
- Runner/provider credential을 Desktop 또는 Backend payload로 받거나 저장하지 않는다.
- Todo12의 child handoff, session rebind/fork, comparison adoption을 수정하지 않는다.
- Todo10의 server-owned effective configuration/default-deny grant resolver를 대체하지 않는다.

## Touched Boundaries

- Backend gateway: lifecycle HTTP routes와 기존 scoped dispatch wiring.
- Backend library: `workspace-agent-directory.js`의 순수 lifecycle 계약, 별도 Workspace-scoped builder service.
- DB/migrations: immutable activated profile version 및 disposable test request/evidence persistence.
- Electron bridge: 변경 없음. Desktop은 기존 authenticated HTTP bridge를 사용한다.
- React UI: `AgentDirectoryPanel.tsx`, App API callbacks, roster parser/types.
- Runner: 기존 connector polling에 side-effect-free bounded builder-test request 한 종류 추가.
- Tests: focused Backend domain/contract/migration/Runner tests, focused Desktop contract tests, deterministic Playwright journey.
- Docs: 이 계획과 task-11 evidence/DoneClaim.

## Success Criteria

- [x] 한 줄 생성 초안은 reload 후에도 `draft`, `enabled=false`이고 검토/성공 테스트 전에는 실행 또는 활성화할 수 없다.
- [x] 명시적 검토는 현재 draft revision만 승인하며, failed/cancelled/timed-out disposable test는 비활성 상태를 유지하고 Calendar/external-delivery row/action을 만들지 않는다.
- [x] 현재 revision의 성공 테스트 evidence만 activation eligibility를 만들고, activation은 immutable profile v1을 저장한다.
- [x] 활성 프로필 수정은 v2 draft를 만들며 재검토/재테스트/재활성화 후에도 기존 job의 v1 snapshot은 byte-for-byte 유지된다.
- [x] 기존 direct manual create workflow는 비활성 draft 생성 + 명시적 activation 경로로 계속 지원된다.
- [x] empty/malformed/oversized/hostile input, malformed result, stale review/test/profile version은 deterministic 4xx로 fail closed한다.
- [x] 생성/테스트 payload가 credentials를 요구/저장하지 않고 Todo10 grants를 넓히지 않는다.
- [x] Desktop 실제 DOM에서 draft/review/fail/success/activate/edit/v2/history 상태를 볼 수 있고 horizontal overflow가 없다.

## Edge Cases

- Empty/malformed/oversized: one-line request는 trim 후 1..500자, test result는 bounded public fields만 허용한다.
- Hostile text: HTML/script/instruction-like request는 text로만 저장/표시하고 실행 명령, grants, external action으로 해석하지 않는다.
- Stale state: review/test/activate는 `expectedRevision`과 test request identity를 확인하며 mismatch는 409이다.
- Cancellation/reload: cancel은 terminal evidence로 남고 reload 후 inactive 상태가 유지된다.
- Timeout/hung Runner: request deadline과 Runner-local AbortSignal이 bounded timeout을 만들며 success로 승격하지 않는다.
- Repeated completion: request terminal completion은 idempotent이고 activation/profile-version insert는 unique identity로 replay-safe하다.
- Existing agents: lifecycle 필드가 없는 기존 enabled agent는 active legacy projection으로 유지한다.
- Dirty worktree: Todo10/Todo12/Keychain/Telegram 파일을 되돌리지 않고 task-owned paths의 current hash를 증거에 남긴다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- PIN:
  - [x] 기존 `normalizeWorkspaceAgent({displayName})`가 `enabled=true`, `profileVersion=1`인 exact projection을 만든다는 characterization을 기존 코드에서 통과시킨다.
- RED:
  - [x] generated draft persistence, review/test/activation gates, failed/cancel/timeout, stale revisions, immutable v1→v2 history, no side effects/grant widening 테스트를 먼저 실패시킨다.
  - [x] Runner connector의 bounded disposable request/result validation 및 timeout 테스트를 먼저 실패시킨다.
  - [x] Desktop API/type/source contract가 draft badge, disabled activation, review/test/activate actions를 요구하도록 먼저 실패시킨다.
- GREEN:
  - [x] agent payload lifecycle projection + immutable profile version table + builder-test request/evidence를 최소 구현한다.
  - [x] Runner는 temporary directory와 AbortSignal timeout에서 provider engine을 실행하고 public bounded evidence만 반환한다.
  - [x] Desktop은 lifecycle state와 action buttons만 추가하고 credential/external-delivery control을 추가하지 않는다.
- REFACTOR:
  - [ ] green 이후 중복 normalization/label만 정리하며 Todo10 resolver와 Todo12 product-service 흐름은 유지한다.

## Acceptance Gates

- [x] `npm run backend:check`
- [x] focused Backend domain/migration/route/Runner tests
- [x] `node --test apps/desktop/tests/agent-builder-lifecycle.test.mjs`
- [x] `npm run typecheck`
- [x] `npm run build:desktop`
- [x] `EVIDENCE_DIR=.omo/evidence/production-readiness-completion/task-11/playwright AGENT_CALENDAR_E2E_THEME=dark node apps/desktop/tests/playwright-agent-builder-lifecycle.cjs`
- [x] 위 Playwright timing-sensitive failure/success transition 3회 반복
- [x] source fingerprints / cleanup receipt (`LSP`는 설치되지 않아 typecheck/build로 대체)

건너뛴 gate:

- Gate: `npm test`
  - Reason: caller가 shared/full suite 실행을 명시적으로 금지했다.
- Gate: `npm run test:backend`
  - Reason: 전체 shared Backend suite 대신 task-owned focused contracts만 실행한다.
- Gate: staging/external delivery
  - Reason: 외부 접촉/쓰기와 credential 사용이 금지되며 이 기능은 side-effect-free local fixture로 검증한다.

## Implementation Checklist

- [x] Step 1: current manual create behavior를 PIN하고 exact output을 기록한다.
- [x] Step 2: lifecycle 순수 함수/validation/version transition RED를 작성한다.
- [x] Step 3: migration/service/route/Runner connector RED를 작성한다.
- [x] Step 4: Desktop API/parser/panel source contract RED를 작성한다.
- [x] Step 5: draft/review/test/activate lifecycle과 immutable profile snapshot을 GREEN으로 만든다.
- [x] Step 6: bounded disposable Runner test와 cancellation/timeout/result validation을 GREEN으로 만든다.
- [x] Step 7: Desktop builder UI/action callbacks를 GREEN으로 만든다.
- [x] Step 8: deterministic Vite/Playwright real-DOM journey를 작성하고 exact command로 통과시킨다.
- [x] Step 9: adversarial/reload/interruption/repetition/state-count checks를 수행한다.
- [x] Step 10: task-owned runtime cleanup, hashes, DoneClaim, independent HEAVY review를 완료한다.

## Verification Notes

- Evidence root: `.omo/evidence/production-readiness-completion/task-11/`
- Results: PIN 1/1, expected RED 0/6 + 0/4 + 0/5, Backend focused 20/20,
  PostgreSQL persistence 1/1, Desktop focused 5/5, typecheck/build/backend check,
  exact Playwright and two timing-sensitive repeats all passed.

## Remaining Risks

- Risk: existing agents and imported connected agents have no lifecycle metadata.
  - Mitigation: legacy enabled projection is explicitly active; new native manual/generated agents use inactive lifecycle.
- Risk: Runner completion could claim success without proving side-effect isolation.
  - Mitigation: server accepts only the dedicated builder-test result schema with no-side-effect counters all zero; request carries default-deny/no-external-delivery policy and is not a durable job.
- Risk: concurrent Todo10/Todo12 edits overlap adjacent agent files.
  - Mitigation: preserve current dirty content, avoid `workspace-scoped-product-service.js`, inspect current hashes before each patch, and report any precise conflict.
