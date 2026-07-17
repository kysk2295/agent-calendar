# Plan: 개인 베타 신뢰성 마감 스프린트

- Date: 2026-07-17
- Owner: Codex
- Work size: Large / Boundary
- Status: In progress — implementation green, same-revision Railway/live gates pending

## Goal

데스크톱 앱의 각 탭이 올바른 데이터를 보여 주고, Calendar AI·Wiki Curator·Agent Work가 실제 Hermes 프로필과 자연스럽게 대화하며, 같은 커밋의 backend와 packaged desktop app을 반복해서 배포·검증할 수 있는 개인 베타를 만든다.

이번 스프린트의 우선순위는 새 기능 추가가 아니라 실제 QA에서 발견된 데이터 정합성 결함과 운영 불확실성을 제거하는 것이다.

## Planning Assumptions And Capacity

- 기간: 10 working days
- 인력: owner 1명 + Codex 구현/검증 지원
- 명목 용량: 80 ideal hours
- 장애·외부 모델 지연·재검증 buffer: 16 hours (20%)
- 이번 스프린트 commit: 64 ideal hours
- 과거 velocity가 없으므로 story point 대신 ideal hour를 사용한다. 첫 스프린트 종료 후 실제 소요 시간으로 다음 계획을 보정한다.

## Current Evidence

- `main` 기준 핵심 AI 경로와 Agent Work conversation routing은 구현되어 있다.
- 실제 packaged app에서 Calendar AI, Wiki Curator, Agent Work의 무해한 질문·후속 질문·reload persistence가 동작했다.
- backend 273/273, desktop 138/138과 관련 Playwright workflow가 통과했다.
- Railway gateway와 relay는 online이지만, CLI snapshot 배포는 source commit provenance가 비어 있어 어떤 Git commit이 실행 중인지 한눈에 확인하기 어렵다.
- 실제 결함: Mail 탭의 `getInbox()`가 `/api/inbox/commands`를 읽어 메일 0건인 상태에서도 Web chat 기록을 메일처럼 표시한다. 현재 mock Playwright fixture가 이 계약 오류를 가리고 있다.
- Hermes automation의 조회·새로고침·무변경 저장은 검증했지만 production automation의 실제 pause/delete는 운영 영향 때문에 실행하지 않았다.

## Non-Goals

- 모바일 UI를 다시 추가하거나 모바일 breakpoint를 제품 범위로 복원하지 않는다.
- Hermes 대신 새로운 local LLM/provider를 도입하지 않는다.
- Telegram 메시지를 앱의 transport로 우회 복사하지 않는다. 앱과 Telegram이 같은 Hermes profile 계약을 사용하도록 검증한다.
- 공개 멀티 사용자, 결제, 조직 권한, 전체 UI 재설계를 추가하지 않는다.
- production automation, 실제 이메일, 외부 게시·구매·거래를 QA 목적으로 파괴하거나 실행하지 않는다.
- Apple Developer ID/notarization이 없는데 public distribution 완료로 표시하지 않는다.

## Touched Boundaries

- Backend gateway: mail read/action API, public state projection, health/version provenance
- Backend library: mail/command source separation, runtime response telemetry if a stable seam is required
- DB/migrations: 기존 `mailMessages`와 `chatMessages` 의미를 유지하며 additive metadata만 허용; destructive migration 없음
- Electron bridge: 기존 `/api/*` proxy 유지, 새 IPC는 추가하지 않음
- React UI: Mail hydration/empty/error/source states, Agent/AI truthful status presentation
- Tests: backend mail contract, desktop source contract, unmocked/live Playwright, packaged-app smoke
- Operations: Railway deployment provenance, Hermes relay/profile live smoke, optional owner Telegram parity check
- Docs: 이 계획, evidence, release/rollback 기록

## Prioritized Sprint Backlog

| Priority | Story | Estimate | Dependency | Done evidence |
| --- | --- | ---: | --- | --- |
| P0 | Mail과 command inbox의 현재 계약을 실패 테스트로 분리 | 5h | none | Web chat fixture가 Mail에 들어오면 test가 실패 |
| P0 | 실제 `mailMessages` 전용 backend read/action 계약 구현 | 10h | Mail RED | 빈 메일은 빈 배열, command/chat은 별도 API에 유지 |
| P0 | Desktop Mail hydration·count·empty/error/source UI 교정 | 8h | mail API | 메일 0건이면 빈 상태이고 Web chat 602건이 나타나지 않음 |
| P0 | Mock을 제거한 Mail API/Electron/packaged-app E2E 추가 | 7h | desktop Mail | reload와 star/archive/task action rollback까지 실제 계약 검증 |
| P0 | Git commit ↔ Railway deployment ↔ desktop build provenance 노출 | 8h | none | health/settings에서 동일 short SHA와 deployment/build ID 확인 |
| P0 | Calendar/Wiki/Agent 자연어·근거·다회차·latency regression matrix | 12h | stable deployment | 다양한 질문이 profile별 품질 기준과 first-response SLO 통과 |
| P1 | 과거 QA/중단/실패 기록을 현재 오류와 구분하는 표시·filter | 6h | none | `[redacted-command]`를 답변처럼 표시하지 않고 이력 상태가 명확함 |
| P1 | 동일 revision 전체 gate, packaged-app 전 탭 QA, Railway 배포 기록 | 8h | all P0 | 한 revision의 test/build/live evidence와 rollback ID 기록 |

Committed total: **64h**. 외부 모델/relay 장애가 buffer 16h를 넘으면 P1 두 항목을 다음 스프린트로 이동하고 P0 품질을 낮추지 않는다.

## Dependency And Execution Order

1. Mail contract RED를 먼저 고정한다.
2. backend mail source를 command/chat source와 분리한다.
3. desktop Mail adapter와 UI를 새 계약에 연결한다.
4. mock-free E2E와 packaged-app에서 Mail을 검증한다.
5. 위 critical path와 독립적으로 deployment provenance와 AI regression harness를 만든다.
6. P0가 모두 green일 때만 history presentation과 최종 release QA를 진행한다.
7. 최종 검증 revision을 `main`에 commit/push한 뒤 Railway와 desktop artifact를 같은 revision으로 만든다.

## AI Quality Matrix

정확한 문장을 snapshot으로 고정하지 않고 구조·근거·자연스러움·대화 연속성을 검증한다.

| Surface | Required cases | Pass condition |
| --- | --- | --- |
| Calendar AI | 존재 일정, 없는 일정, 기간 요약, 애매한 날짜, 후속 질문 | 캘린더 근거 밖의 일정을 만들지 않고 자연어로 답함 |
| Wiki Curator | 사실 조회, 여러 문서 종합, BM 판단, 근거 없음, 후속 질문 | `wikicurator` 답변을 그대로 사용하고 실제 근거 위키만 tagging |
| Agent Work | 계산, 요약, 우선순위 판단, 문맥 후속 질문, 안전 거절 | 선택 profile의 자연어 응답과 multi-turn persistence, typed failure |
| Telegram parity | 동일 profile에 harmless prompt 1~2개 | 앱과 같은 profile/provider provenance; 비밀/원문 로그 미노출 |

- 목표 SLO: live 표본의 90%에서 첫 사용자용 model delta 30초 이내, hard timeout 90초 이내 종료.
- 30초를 넘으면 단순 timeout 확대보다 queue time, relay time, model first-token time을 분리해 원인을 기록한다.
- raw prompt, tool command, mission schema, `[redacted-command]`는 사용자 답변으로 취급하지 않는다.

## Success Criteria

- [x] Mail 탭은 `mailMessages`만 보여 주며 Web chat/command 기록을 메일로 표시하지 않는다.
- [x] 실제 메일 0건에서는 truthful empty state와 0 count를 표시한다.
- [x] Mail star/archive/task actions는 정확한 source record에 적용되고 실패 시 UI rollback이 동작한다.
- [ ] Railway health와 desktop settings/support view에서 현재 Git short SHA와 deployment/build ID를 확인할 수 있다.
- [ ] Calendar AI, Wiki Curator, Agent Work의 diverse live matrix가 자연어·grounding·multi-turn 기준을 통과한다.
- [ ] Wiki 답변은 실제 검색 근거만 tagging하고 근거가 없으면 없다고 말한다.
- [x] Agent Work의 실패는 typed user-facing error로 보이며 `[redacted-command]`가 답변 카드가 되지 않는다.
- [ ] 같은 revision으로 backend full tests, desktop full tests, typecheck, build, Playwright, packaged-app manual QA가 통과한다.
- [ ] 해당 revision을 `main`에 push하고 Railway SUCCESS/relay online과 rollback deployment ID를 기록한다.

## Edge Cases

- mail은 0건인데 chat/command는 수백 건인 상태
- Gmail/메일 provider가 미설정, offline, partial sync, duplicate message를 반환하는 상태
- star/archive/task action이 HTTP 실패한 뒤 selection과 optimistic UI를 복원하는 경우
- Railway가 CLI snapshot으로 배포되어 Git env가 비어 있는 경우
- relay는 online이지만 profile이 disabled, cold-start, timeout, provider error인 경우
- Wiki retrieval은 성공했지만 LLM synthesis가 실패하거나 근거가 0건인 경우
- Calendar 질문이 상대 날짜, timezone, 존재하지 않는 일정, 생성 요청을 섞는 경우
- 과거 실패/취소된 QA task가 reload 후 현재 오류처럼 보이는 경우
- app restart 중 streaming response가 끊기거나 동일 client message가 재시도되는 경우

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] `/api/inbox/commands`의 Web chat fixture가 Mail 화면에 나타나면 실패하는 desktop test
  - [x] `mailMessages: []`, `chatMessages: many`에서 Mail count/rows가 0이 아니면 실패하는 contract test
  - [x] mail read/action API가 command record를 허용하면 실패하는 backend test
  - [x] build commit이 비어 있거나 local/deployed revision과 다르면 실패하는 release smoke
  - [x] AI matrix에서 profile mismatch, raw prompt exposure, empty final, ungrounded citation을 감지하는 verifier
- GREEN:
  - [x] mail source 전용 API와 typed adapter를 최소 구현
  - [x] truthful Mail loading/empty/error/action states 구현
  - [x] build/deployment provenance를 health와 support UI에 전달
  - [x] deterministic assertions와 bounded live AI verifier 구현
- REFACTOR:
  - [ ] `App.tsx`에 새 data mapping을 더 쌓지 않고 Mail adapter/presenter seam으로 분리
  - [ ] mock fixture를 실제 API envelope와 공유해 contract drift를 줄임
  - [x] AI exact prose snapshot 대신 safety/grounding/continuity/latency predicate를 재사용

## Acceptance Gates

- [x] focused backend Mail tests
- [x] focused desktop Mail tests and source-boundary Playwright
- [ ] focused AI live matrix against configured Hermes profiles
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [ ] packaged macOS app launch and all top-level tabs/buttons smoke
- [ ] Railway health/relay/profile/deployment-provenance smoke
- [x] `git diff --check`

건너뛴 gate:

- Gate: destructive production automation pause/delete
  - Reason: 실제 운영 schedule에 영향을 주므로 staging fixture 또는 owner가 지정한 disposable automation이 생기기 전에는 실행하지 않는다.
- Gate: real email send/archive against owner mailbox
  - Reason: read/source correctness를 먼저 마감하고 별도 disposable message와 명시적 승인으로 검증한다.
- Gate: public notarized macOS distribution
  - Reason: Developer ID Application identity와 notarization credentials가 별도 prerequisite다.

## Implementation Checklist

- [x] Step 1: Mail source 오류를 재현하는 backend/desktop RED를 작성한다.
- [x] Step 2: mail read/action API와 command/chat API의 데이터 의미를 분리한다.
- [x] Step 3: Desktop Mail hydration, count, empty/error, action rollback을 구현한다.
- [ ] Step 4: mock-free Electron/packaged-app Mail workflow를 통과시킨다.
- [ ] Step 5: source commit, Railway deployment ID, desktop build ID를 한 revision으로 연결한다.
- [ ] Step 6: Calendar/Wiki/Agent/Telegram parity quality matrix와 timing telemetry를 실행한다.
- [x] Step 7: 과거 QA/중단/실패 이력을 현재 오류와 구분한다.
- [ ] Step 8: 전체 gate와 실제 탭·버튼 QA를 같은 revision에서 실행한다.
- [ ] Step 9: `main` commit/push, Railway deploy, packaged build, rollback evidence를 기록한다.

## Next Sprints

### Sprint 2 — 운영 제어와 외부 채널

- disposable fixture 기반 Hermes automation pause/resume/edit/delete live QA
- Telegram profile/provider parity, reconnect, delivery status와 one-safe-message gate
- Gmail 또는 실제 mail connector가 설정된 경우 sync/dedup/unread/archive end-to-end
- queue/relay/model latency breakdown과 사용자용 retry/cancel UX

### Sprint 3 — 2주 dogfood와 구조 정리

- Weekly Opportunity Brief를 두 번 실제 사용하고 usefulness/follow-up 지표 수집
- 오래된 QA artifact archive와 운영 dashboard noise 축소
- oversized gateway/App module을 characterization test 아래 점진 분리
- 개인 베타 release 후보의 서명·업데이트·rollback 절차 반복 검증

## Rollback / Fallback Story

- Mail 계약은 additive endpoint/adapter로 분리하고 기존 command API를 삭제하지 않는다.
- 새 mail path가 실패하면 Mail을 명시적 unavailable/empty 상태로 두고 command 기록으로 대체하지 않는다.
- AI provider/profile 실패는 다른 profile 응답으로 위장하지 않고 typed failure와 재시도를 제공한다.
- Railway 배포 전 last-known-good deployment ID를 기록하고 health/relay/profile smoke 실패 시 그 deployment로 rollback한다.
- schema migration 없이 기존 `mailMessages`, `chatMessages`, mission/session history를 보존한다.

## Verification Notes

- Planning baseline:
  - Current automated suites are green and the working tree was clean at planning time.
  - Live packaged-app QA confirmed the three core AI surfaces can complete harmless natural-language turns.
  - Live data inspection confirmed Mail source contamination despite mock-based Mail Playwright tests passing.
- 2026-07-18 implementation evidence:
  - Mail backend boundary 3/3, Mail desktop/API contracts 38/38, focused Mail Playwright 8/8 passed.
  - `npm run verify:beta` passed after review fixes: backend 278/278, desktop 141/141, typecheck, backend syntax, and desktop production build.
  - Major renderer surface/button QA passed 15/15 across desktop shell, Today, Tasks, Next 7, Calendar, Mail, Diary, Review, Wiki, Agent, Hermes automation, chat, Settings, and deployment provenance.
  - Agent Work regression now hides `[redacted-command]` for every checkpoint kind; focused suite 12/12 passed.
  - Live AI matrix correctly caught deployment drift before release: local `main` was `7a149708` while Railway reported `29cbfdeb`, so the old deployment routed Calendar AI to missing model `hermes-agent`. Same-revision deploy and matrix rerun remain required.
  - Independent spec review found and drove three pre-push fixes: Mail 503 now renders an unavailable/retry state without erasing prior items; a mock-free compiled Electron proxy → configured Railway Mail smoke now exists; and the live matrix now covers 5 Calendar, 5 Wiki, and 2 Agent Work turns with a 90-second hard timeout and safe cleanup.
  - Desktop build identity is embedded from `SOURCE_COMMIT` or Git HEAD and compared visibly with the Railway source commit; mismatch is now an explicit support warning.
  - The configured-runtime Mail smoke intentionally remains RED against the old Railway deployment (`/api/mail/messages` 503). It must become green only after the same-revision deploy.

## Remaining Risks

- Risk: 외부 OpenAI/Hermes latency는 코드만으로 고정할 수 없다.
  - Mitigation: queue/relay/model 시간을 분리하고 p90 first-response SLO, bounded timeout, typed retry를 검증한다.
- Risk: 실제 mail provider가 0건 또는 미설정이면 action workflow 전체를 production에서 검증하기 어렵다.
  - Mitigation: contract fixture + disposable provider message를 사용하고 Web chat fallback은 금지한다.
- Risk: Telegram credential과 실제 외부 메시지는 owner coordination이 필요하다.
  - Mitigation: 모든 내부 gate를 먼저 끝내고 secret을 출력하지 않는 one-safe-message만 별도 실행한다.
- Risk: CLI snapshot deployment에서 commit provenance가 자동 설정되지 않을 수 있다.
  - Mitigation: release script가 explicit source SHA를 build metadata로 전달하고 deployed health와 비교한다.
- Risk: 기존 plan의 오래된 미완료 checkbox가 현재 상태와 충돌한다.
  - Mitigation: 새 evidence로 superseded/completed 상태를 명시하되 과거 기록 자체는 삭제하거나 재작성하지 않는다.
