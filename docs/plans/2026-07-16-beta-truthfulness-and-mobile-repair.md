# Plan: 베타 신뢰성·AI 응답·모바일 핵심 동선 복구

- Date: 2026-07-16
- Owner: Codex
- Work size: Large / Boundary
- Status: In progress — production deploy/live verification remaining

## Goal

Agent Calendar의 공개 베타 경로에서 생성한 작업과 설정이 실제 저장소에 남고, Console·Wiki·Calendar AI가 내부 프롬프트나 실행 로그가 아닌 사용자용 답변만 보여 주도록 한다. 375px 모바일에서도 모든 핵심 화면과 Console에 접근하고 주요 입력·상세 영역을 사용할 수 있게 한다.

## Non-Goals

- Telegram BotFather 토큰, 봇 계정, 기존 Telegram 배포를 변경하지 않는다.
- 이번 작업에서 DB 스키마나 저장 데이터 의미를 변경하지 않는다.
- 응답의 정확한 한국어 문장·길이·말투를 테스트로 고정하지 않는다.
- 외부 LLM/Railway 장애 자체를 숨기거나 성공으로 위장하지 않는다.
- 사용자 확인 없이 프로덕션 배포나 외부 데이터 파괴 작업을 수행하지 않는다.

## Touched Boundaries

- Backend gateway: task write/read source of truth, public Console/Wiki SSE projection, weekly review routing
- Backend library: relay completion의 사용자 답변 분류가 필요할 경우 최소 범위로 변경
- DB/migrations: 기존 gateway store만 사용, migration 없음
- Electron bridge: 로컬 UI 설정 저장과 장시간 multipart 요청의 취소 전파
- React UI: Console event allowlist, canonical Wiki execution profile, 모바일 navigation/drawer/layout, 진행 상태
- Tests: backend HTTP contract, desktop unit/source contract, Electron proxy, Playwright 320px/375px workflows
- Docs: 이 계획과 검증 결과

## Success Criteria

- [x] `/api/tasks`가 성공을 반환한 작업은 동일 공개 API의 후속 조회에 나타나며 재시작 가능한 gateway store에 남는다.
- [x] UI preference 토글은 Electron 로컬 설정에 저장되고 reload 후 복원된다.
- [x] Console SSE wire와 renderer는 `delta` 또는 명시적 public answer만 공개하며 prompt/schema/log/timeline/memory/tool-activity/raw run 원문을 답변에 섞지 않는다.
- [x] Wiki 질문은 공식 `wikicurator` execution profile 계약을 사용하며 synthesis 실패를 성공 답변으로 위장하지 않고 명시적 degraded retrieval 상태 또는 안전한 SSE failure로 반환한다.
- [x] weekly review는 전달된 실제 주간 context를 사용하고 원시 JSON 대신 사용자용 회고를 반환한다.
- [x] 이미지 ingest는 정상 모델 지연 범위를 기다리고 취소 시 upstream 요청도 취소하며, 대기 상태를 사용자에게 알린다.
- [x] 320×812와 375×812에서 모바일 navigation으로 핵심 탭을 이동하고 Console을 열고 닫을 수 있다.
- [x] tasks, kanban, mail, wiki, diary의 주요 화면이 0폭·화면 밖 고정 패널·의도치 않은 root overflow 없이 사용 가능하다.
- [ ] 실제 모델 응답을 쓰는 live E2E에서 Console, Wiki, Calendar AI, weekly review, Responsible Agent의 응답이 비어 있지 않고 내부 구조를 노출하지 않는다.

## Edge Cases

- Runtime이 task mutation에 HTTP 200과 `gatewayFallback: true`를 함께 반환하는 경우
- Runtime 또는 relay가 metadata event에도 `text` 필드를 넣거나 `done`에 raw run을 넣는 경우
- Console이 delta 없이 public final answer만 보내거나 error event로 끝나는 경우
- Wiki retrieval은 성공하지만 curator synthesis가 실패하는 경우
- 이미지 분석이 45초를 넘지만 180초 안에 끝나는 경우와 사용자가 중간에 창을 닫는 경우
- 저장된 local settings가 없거나 remote `/api/settings`가 `uiPreferences`를 제거하는 경우
- 320~760px, safe-area inset, 긴 한글 제목, mail/diary/wiki의 빈 선택 상태

## Test Plan

제품 코드보다 테스트를 먼저 작성한다. 각 항목은 해당 RED가 기대한 이유로 실패한 뒤 최소 구현으로 GREEN을 만든다.

- RED:
  - [x] runtime이 fallback 성공을 반환한 task mutation 뒤 gateway read가 새 task를 보존하는 backend HTTP test
  - [x] metadata text와 raw run을 포함한 Console SSE에서 public answer만 남기는 backend/renderer tests
  - [x] local Electron settings 저장 호출과 reload 복원을 검증하는 Playwright test
  - [x] `wiki.search → chat.completions(profile='wikicurator')` routing 및 synthesis failure/degraded contract backend test
  - [x] weekly review가 request context를 소비하는 backend contract test
  - [x] 장시간 ingest timeout과 client abort propagation을 검증하는 desktop/proxy tests
  - [x] 320×812/375×812 mobile navigation, Console drawer, core screen bounding-box와 내부 overflow Playwright test
- GREEN:
  - [x] 기존 gateway store를 task source of truth로 일관되게 사용
  - [x] public event projection과 renderer allowlist를 작은 모듈로 추출
  - [x] UI preference persistence를 local-first helper로 추출
  - [x] Wiki/weekly review를 canonical execution profile과 context-aware contract로 정렬
  - [x] ingest 전용 timeout과 AbortSignal 전달 구현
  - [x] mobile navigation 컴포넌트와 별도 responsive stylesheet 구현
- REFACTOR:
  - [x] `App.tsx`와 `styles.css`에 기능을 더 쌓지 않고 새 모듈/CSS로 이동
  - [x] exact prose 대신 구조·공개 경계·행동을 검증하도록 중복 test fixture 정리

## Acceptance Gates

- [x] 관련 backend test의 narrow command
- [x] 관련 desktop unit/Playwright test의 narrow command
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [ ] 실제 configured runtime live E2E와 fresh desktop/320px/375px screenshots
- [ ] 두 개의 독립 visual/functional review가 fresh evidence를 PASS

건너뛴 gate:

- Gate: 프로덕션 배포
  - Reason: 이 계획은 배포 가능한 산출물과 live configured-runtime 검증까지이며, 외부 배포는 별도 명시적 승인 대상이다.

## Implementation Checklist

- [x] Step 1: 실패 증거와 code map을 공개 seam별로 고정한다.
- [x] Step 2: task persistence와 settings persistence를 RED→GREEN으로 복구한다.
- [x] Step 3: Console SSE 공개 경계와 renderer allowlist를 RED→GREEN으로 복구한다.
- [x] Step 4: canonical Wiki curator execution profile과 context-aware weekly review를 RED→GREEN으로 복구한다.
- [x] Step 5: image ingest timeout/abort/progress UX를 RED→GREEN으로 복구한다.
- [x] Step 6: mobile navigation/Console/core layout을 RED→GREEN으로 복구한다.
- [ ] Step 7: 전체 gate, live E2E, fresh screenshot, 독립 review를 통과시킨다.

## Rollback / Fallback Story

- 각 slice는 독립 commit 가능한 public boundary 단위로 유지한다.
- task mirror가 runtime과 충돌하면 gateway store를 authoritative read/write로 유지하고 runtime write-through를 feature flag로 끌 수 있게 한다.
- Wiki/LLM이 실패하면 내부 로그나 retrieval 원문을 성공 답변으로 내보내지 않고 명시적인 안전한 실패 상태와 재시도 동선을 제공한다.
- 모바일 CSS는 `responsive.css` 한 파일로 격리해 desktop regression 발생 시 독립 제거할 수 있다.
- schema migration이 없으므로 rollback 시 data migration이나 destructive cleanup이 필요하지 않다.

## Verification Notes

- Command: `npm run verify:beta` (수정 전 baseline)
  - Result: backend 238, desktop 133, typecheck/build는 통과했으나 live surface audit에서 task/settings/AI/mobile failures가 재현되어 기존 suite의 contract gap을 확인했다.
- Command: live public seam probes (수정 전 baseline)
  - Result: task POST 200 후 조회 누락, settings preference 누락, image ingest 약 77초, Console 내부 prompt/log 노출, `wikicurator` 0자 relay failure, 375px navigation/Console 미도달을 확인했다.
- Command: `node --test apps/backend/tests/release-blockers.test.cjs apps/backend/tests/agent-operations.test.cjs apps/backend/tests/wiki-fallback.test.cjs`
  - Result: canonical `chat.completions` + `profile` 계약 RED 4건, 대화형 90초 timeout RED 1건, Console privacy filter RED 1건, Wiki degraded-provider 진실성 RED 1건을 각각 확인한 뒤 구현해 관련 테스트를 GREEN으로 전환했다.
- Command: `npm run verify:beta`
  - Result: backend 245/245, desktop 135/135, backend syntax, desktop typecheck, renderer/Electron production build 모두 통과.
- Command: mobile/theme/Agent Work Control Space Playwright evidence와 탭별 기능 25개 Playwright 시나리오
  - Result: 320×812/375×812 모바일, 5개 테마, 11개 navigation surface, Console, CRUD, Mail, Wiki, Diary, Review, Widget, Delegated Work 시나리오 모두 통과. 최신 증거는 `.omo/evidence/2026-07-16-beta-repair`에 저장.
- Command: 최신 desktop/tablet/mobile screenshot 독립 review 2회
  - Result: FAB/content 겹침과 검은 합성 타일이 제거됐고 P0/P1/P2 시각 결함 없이 visual gate와 mock 기반 기능 연결 gate가 모두 PASS했다.
- Command: configured production runtime probe
  - Result: 배포 중인 이전 Railway artifact는 Relay online 상태에서도 기존 Console `profile.chat` 작업이 약 103초 내 완료되지 않았다. 현재 수정본은 아직 배포하지 않았으므로 실제 모델 응답 live E2E는 배포 후 재검증해야 한다.

## Remaining Risks

- Risk: 외부 Railway/LLM latency와 profile availability는 로컬 코드만으로 완전히 통제할 수 없다.
  - Mitigation: `chat.completions` payload의 canonical `profile` 계약으로 정렬했으며, 배포 후 configured-runtime live gate로 확인한다.
- Risk: gateway와 runtime의 task source of truth가 이중화될 수 있다.
  - Mitigation: 성공 조건을 gateway persisted read로 정의하고 idempotent upsert/merge contract로 검증한다.
- Risk: 큰 기존 `App.tsx`와 `styles.css` 변경이 회귀를 만들 수 있다.
  - Mitigation: 새 모듈/별도 responsive stylesheet, narrow tests, full suite, fresh visual review를 사용한다.
