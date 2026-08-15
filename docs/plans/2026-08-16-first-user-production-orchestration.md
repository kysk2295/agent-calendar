# Plan: 첫 사용자 production 단일 UX 오케스트레이션

- Date: 2026-08-16
- Owner: Grok (design) / Codex (implementation)
- Work size: Large / Boundary
- Status: In progress
- Authoritative PRD: `docs/PRD-agent-calendar-second-brain.md`
- Language: `CONTEXT.md`
- Prior delivery: `docs/plans/2026-08-02-grok-codex-calendar-intelligence-delivery.md`
- Design tokens: `docs/DESIGN.md` (token/shell only; first-run replacement-shell 문장은 이 계획의 제품 계약이 아님)

> **For implementers:** AGENTS.md와 이 계획의 TDD seam을 따른다. 사용자 화면, 인증된 API,
> Electron IPC, Runner 결과, signed-package production flow를 공개 seam으로 삼고 제품 코드보다
> 아래 RED test를 먼저 작성한다. 다른 작업자의 dirty hunk를 되돌리거나 재포맷하지 않는다.
> 이 문서는 제품 코드를 변경하지 않는다.

## Goal

패키지 Electron + Railway production + 사용자 소유 Runner에서, 처음 가입한 비개발자가 다음 한 줄 여정을 막힘·가짜 성공·새 홈/대시보드 없이 끝낸다.

로그인 → 허용한 자료만 연결 → 출처가 보이는 Second Brain 초안 검토 → Calendar AI 사용 → Google Calendar/Gmail 권한을 서로 독립적으로 연결 → 로컬 폴더 Wiki 또는 폴더 없는 Wiki → 작업 위임 → 진행/병렬/개입/중단/재시작 복원 → 결과가 Calendar와 Wiki에 환류.

## Non-Goals

- 14번째 navigation, 대체 홈, AI 대시보드, 설정 벽, Second Brain 상시 카드, `SecondBrainCalendarBriefing` 재연결을 만들지 않는다.
- Calendar AI를 일반 챗봇으로, Agent Work를 엔진 콘솔로 바꾸지 않는다.
- Gmail 전송/삭제/별표, Calendar+Gmail 한 번의 통합 consent, 전체 디스크 스캔을 추가하지 않는다.
- Google OAuth secret를 새로 발급받았다고 가장하거나 저장소에 커밋하지 않는다. 이미 로그인된
  운영자 권한이 있으면 Google Cloud consent/test user와 Railway secret를 이 계획 안에서 실제로
  설정한다. 권한이 없으면 `EXTERNAL_BLOCKED`로 남기고 PASS로 위장하지 않는다.
- C12 frozen SHA `f2a3b430bdc0`를 현재 dirty worktree와 같다고 주장하지 않는다.
- `.ouroboros/` 추적, 역사적 FAIL QA를 현재 제품 진실로 재해석하지 않는다.
- 기존 dirty 파일을 정리한다는 이유로 unrelated refactor, 대규모 파일 분할, 다른 작업자 hunk revert를 하지 않는다.
- 로컬 Vite/mock/dev server를 production 완료 증거로 쓰지 않는다.
- 이 문서 작성 세션에서 제품 코드를 수정하지 않는다.

## Work Size

`Large / Boundary`. Backend gateway, client-v1, WorkOS/Google OAuth, Electron IPC, 13개 Desktop surface, Runner working context, Railway deploy, signed package identity가 한 사용자 여정에 묶인다. 구현은 아래 Wave 단위로만 커밋한다. 한 Wave의 RED가 예상 이유로 실패하기 전에 다음 Wave 제품 코드를 쓰지 않는다.

## Evidence Snapshot (2026-08-16, 이 worktree)

이 수치는 구현 시작 전 `git status`로 다시 찍는다. 다른 작업자가 파일을 추가해도 이 계획의 keep/rewrite 규칙을 적용한다.

| 항목 | 관측 |
| --- | --- |
| Branch | `kysk2295/agent-control-p0-wave1` |
| HEAD | `35748b2c622cc76f301677643e860525afa41f69` |
| origin/main | `d86a1aee4291ebc04dfd5a94debde2559c6b963b` (README/web landing 2커밋 ahead) |
| Tracking | origin 대비 ahead 2 / behind 2 |
| origin/main...HEAD 커밋 파일 | 23 |
| local HEAD 기준 status | modified 119 + untracked 180 = **299** |
| origin/main과 실제 파일 내용이 다른 path | modified 116 + local-only 164 + main-only/missing 3 = **283** |
| 과거 C12 frozen triple | marker `f2a3b430bdc0`, Railway `08f238e7-5757-496d-b97a-67b5033853b0`, `app.asar` `e40ab9286f4199c635335ca636e608f6e74d3051e31698db08b2d25206e3c703`. `f2a3b430…`는 현재 Git object가 아니므로 재현 가능한 rollback이 아니라 참고 증거다. |
| 현재 Railway source | deployment `180de29c-7e2c-4aba-9af4-776d357dbd77`, Git `d86a1aee4291ebc04dfd5a94debde2559c6b963b`; `/api/gateway-status`의 `f2a3b430bdc0` 표시는 stale marker다. |
| Production gateway | `https://hermes-os-production-e174.up.railway.app` |
| C12 Runner | PID 46299, `maxConcurrentWork: 2`, connected |
| 신규 WorkOS 계정 | C12 `NOT RUN / external authority` |
| 진짜 source-empty | C7/C9의 `source-empty-journey.json`은 connector 0이어도 Source Library 27건. **빈 계정 증거가 아님** |

코드에서 확인한 첫 사용자 구멍 (이 계획이 닫는다):

1. `buildOnboardingReadiness()`에서 `wiki`는 required다. 폴더/지식 소스 없으면 `allReady=false`. 폴더 없는 첫 사용자가 설정 완료를 못한다 (`apps/desktop/tests/onboarding-readiness.test.mjs` 244–254행이 이 계약을 잠근다).
2. 온보딩에 Gmail 단계가 없고, `MailScreen.tsx` 빈 상태 copy가 “Google Calendar와 Gmail 읽기 전용 권한을 한 번에 연결합니다”라고 거짓말한다. 실제 scope는 `google-calendar-adapter.js`에서 Calendar=`calendar`, Mail=`gmail.readonly`로 분리되어 있다.
3. Wiki/온보딩 copy가 `LLM_WIKI_VAULT`를 쓴다. 비개발자 언어가 아니다.
4. `SecondBrainCalendarBriefing.tsx`는 남아 있으나 `App.tsx`는 import하면 안 된다 (`calendar-intelligence-release-a5.test.mjs`). C5/C12는 캘린더 기본 화면의 브리핑 카드 부재를 PASS로 고정했다.
5. Calendar AI `delegate_work` 승인은 backend에서 Work Intake preview/start를 탄다 (`calendar-ai-service.js` 1066–1118). Desktop `actOnCalendarAiDraft`는 hydrate만 하고 `agents` 화면·해당 mission을 열지 않는다. 첫 사용자는 승인 뒤 작업 대화를 보지 못한다.
6. Desktop `hermesApi.ts`에 `work-intake.preview/start` client가 없다. 직접 시작 경로는 레거시 `agent-work.create`다.
7. Agent Control Home 1차 copy가 `새 위임 작업`, `실행 엔진`을 노출한다. `CONTEXT.md`는 `새 작업`과 엔진 비노출을 요구한다.
8. 2026-08-02 Agent IDE QA는 Work 전환 시 `request_failed` draft 누출을 FAIL로 남겼다. C12는 완료 대화 복원만 재검증했다. isolation은 첫 사용자 acceptance에 다시 넣는다.

## Touched Boundaries

- Backend gateway: `apps/backend/app/lib/production-product-routes.js`, `production-route-registry.js`, `phase1-auth-routes.js`, `apps/backend/app/railway-gateway-server.js` (composition only)
- Backend library: `source-library.js`, `second-brain.js`, `context-assembler.js`, `work-intake.js`, `calendar-ai-service.js`, `google-calendar-adapter.js`, `google-auth-callback-bridge.js`, `client-v1-contract.js`, `workspace-scoped-product-service.js`, `agent-work-wiki-archive.js`, `runner-control.js`
- DB/migrations: 기존 `0035`–`0038`만 유지. 새 의미 변경이 있으면 `0039` additive. `0009`/`0010`/`0013`/`0014`/`0022` dirty hunk는 replay-safety만 살리고 스키마 재해석 금지
- Electron bridge: `mailOAuth.ts`, `localWikiAsk.ts`, `localWikiWriter.ts`, `deepLink.ts`, `deepLinkMain.ts`, `preload.ts`, `preload.cts`, `settings.ts`, `main.ts`
- React UI: `OnboardingGuide.tsx`, `onboardingReadiness.ts`, `second-brain/**`, `MailScreen.tsx`, `ChatDrawer.tsx`, `WikiScreen.tsx`, `AgentWorkWorkspace.tsx`, `AgentWorkConversationView.tsx`, `App.tsx` composition only
- Runner: `apps/runner/lib/execution-loop.js`, `capabilities.js` (folderless cwd, capacity, interrupt)
- Tests: 아래 TDD seam 목록
- Docs: 이 파일만 제품 계약. README는 origin/main 것을 merge하고 사용자 여정 문장만 맞춘다
- Railway / signed package: 한 SHA triple. 현재 Git `d86a1ae` deployment를 새 freeze 전까지
  재현 가능한 rollback 대상으로 유지하고, C12는 기능 비교 증거로만 사용

## Locked Product Decisions

1. **제품 중심은 캘린더다.** 로그인 후 기본 화면은 `calendar`다. Second Brain은 Module이지 화면이 아니다.
2. **13개 sidebar id/순서/라벨을 유지한다.** `calendar`, `agents`, `automation` / `today`, `next7`, `tasks`, `mail`, `kanban`, `wiki`, `review`, `diary`, `runner`, `widgets`.
3. **시작 가이드는 기존 `OnboardingGuide` in-place overlay다.** 새 route, 새 nav, 사이드바를 없애는 대체 홈을 만들지 않는다. `설정 완료`와 `나중에` 모두 `openScreen('calendar')`로 돌아간다.
4. **권한은 세 겹이다.** WorkOS AuthKit 로그인 ≠ Google Calendar `https://www.googleapis.com/auth/calendar` ≠ Gmail `https://www.googleapis.com/auth/gmail.readonly`. 로그인은 일정/메일을 주지 않는다.
5. **폴더 Wiki는 선택이다.** 폴더 없는 경로는 (a) Workspace 암호화 파일 추가, (b) 폴더 없이 계속. `wiki` step을 optional로 바꾼다. `LLM_WIKI_VAULT` 문자열을 사용자 copy에서 제거한다.
6. **Runner/실행 컴퓨터는 작업 실행에만 필요하다.** 설정 완료를 막지 않는다. Calendar/Mail/Wiki/Calendar AI/Second Brain 검토는 Runner 없이 된다. 작업 생성은 연결된 실행 컴퓨터가 있을 때만 켠다 (기존 `agentWorkCreationPresentation`).
7. **캘린더 기본 화면에 Second Brain 카드/브리핑을 두지 않는다.** citation은 온보딩 검토, Calendar AI 답변, Wiki 답변, 작업 결과에만 보인다.
8. **Calendar AI `delegate_work` 승인 성공 시** 해당 `missionId`의 기존 `agents` Work Conversation을 연다. hydrate-only는 실패다.
9. **완료 current result만** Calendar terminal entry + Source Record + (폴더가 있으면) `5_conversation/agent-runs/<workResultId>.md`에 남긴다. failed/cancelled는 성공 지식으로 올리지 않는다. 폴더가 없으면 `pending_local`을 정직하게 유지한다.
10. **사용자 copy:** `작업`, `새 작업`, `작업 대화`. 1차 UI에 Runner/engine/endpoint/model/provider session/Second Brain vN/프로필 vN을 쓰지 않는다.
11. **디자인:** `docs/DESIGN.md` 토큰만 사용. `--control-height 30px`, `--radius-control 6px`, `--shell-sidebar 220px`, Phosphor outline, primary는 `--action`/`--action-text`. terracotta는 캘린더 의미에만. 그라데이션 FAB, 이모지 nav, 히어로 카드 금지.

## Success Criteria

- [ ] 신규 WorkOS 계정으로 패키지 앱 로그인 후 합성 일정/메일/Wiki/에이전트가 0건이다.
- [ ] 로그인만으로 Google Calendar/Gmail consent가 열리지 않는다.
- [ ] source-empty에서 Second Brain이 `source_required`이고 “파악 중”/가짜 %를 보여주지 않으며,
      사용자는 이 상태를 확인한 뒤 온보딩을 완료할 수 있다.
- [ ] source-rich에서 모든 표시 claim이 citation 또는 `user_confirmed`를 가진다.
- [ ] 사용자는 claim을 confirm/correct/reject할 수 있고 다음 Calendar AI 답변의 snapshot version이 바뀐다.
- [ ] Wiki 폴더 없이 설정 완료가 가능하고, 나중에 폴더를 연결하면 `pending_local`이 같은 identity로 write/replay된다.
- [ ] Calendar와 Gmail을 따로 연결·거부·재승인할 수 있다. 한쪽 거부가 다른 쪽과 로그인을 끄지 않는다.
- [ ] Calendar AI에서 `조사해줘`류 요청이 `delegate_work` 초안 → 승인 → `agents`의 해당 작업 대화로 이어진다.
- [ ] 폴더 없는 `workspace_general` Work와 명시한 `local_folder` Work가 모두 실제 Runner에서 완료된다.
- [ ] capacity 2에서 두 Work가 겹치고, 하나만 중단해도 다른 쪽은 계속된다. capacity 1에서는 queued가 보인다.
- [ ] Work별 composer/live/error/draft가 다른 Work에 새지 않는다.
- [ ] 앱·Gateway·Runner 재시작 후 세션, Second Brain, 작업 대화, pending Wiki가 복구된다.
- [ ] 13 nav와 기존 Calendar CRUD가 A0 테스트와 같다.
- [ ] Railway build SHA = 패키지 embedded marker = signed `app.asar`의 소스 커밋.
- [ ] 아래 버튼 matrix의 모든 사용자 노출 컨트롤이 PASS / 정직한 disabled / 명시적 external-blocked / NOT CLICKED 중 하나다.

## Single User Journey (canonical)

```text
packaged app signed-out
  → AuthKit (WorkOS; Google identity 또는 magic link)
  → 기존 시작 가이드 (sidebar 13개는 유지, 가이드가 본문만 가림)
      1. 캘린더 사용 방식 확인          [선택: Google Calendar 연결 / 내부 캘린더로 계속]
      2. 기록 연결                     [선택: Gmail / 로컬 폴더 / 파일 / 폴더 없이 계속]
      3. Second Brain 초안 검토        [source 있으면 run, 없으면 source_required]
      4. Calendar AI 열기              [기존 topbar chat-fab / 가이드 CTA]
      5. 실행 컴퓨터                   [선택; 작업 전에만 필요]
  → 설정 완료 또는 나중에 → calendar
  → Calendar AI 질문 → (선택) delegate_work 승인 → agents Work Conversation
  → 진행 / 추가 지시 / 병렬 / 중단 / 재시도 / 재시작
  → 완료 결과: 같은 workResultId가 Calendar + 작업 대화 + Wiki에 남음
```

설정 완료 공식 (`allReady`):

```text
decisionReady =
  calendar.connected OR calendar.skipped_to_internal
  AND records.source_selected OR records.skipped
  AND second_brain.active OR second_brain.source_required_acknowledged
  AND calendar_ai.available_or_honestly_limited
optional = runner, wiki, mail
allReady = decisionReady && optional ignored
dismiss("나중에") = calendar, allReady 아니어도 허용. 빈 상태 CTA가 남는다.
```

연결 결과가 아니라 사용자의 명시적 선택이 완료 조건이다. `calendar`, `records`,
`second_brain`을 연결 성공 필수로 만들면 Google을 쓰지 않거나 아직 자료가 없는 사용자가 제품에
들어갈 수 없다. `wiki`, `mail`, `runner`는 optional이며, skip은 합성 source나 active Second Brain을
만들지 않는다. 기존 테스트 `Runner is optional setup because Calendar AI and Wiki AI no longer need
one`의 `for (const step of others) assert.notEqual(step.optional, true)`는 **의도적으로 RED**가 된다.

## Screen-by-Screen Minimum UI

모든 화면은 기존 component/token을 재사용한다. 새 카드 그리드, 히어로, 설정 벽을 추가하지 않는다.

### 공통 shell

| 상태 | UI | CTA |
| --- | --- | --- |
| signed-out | 기존 로그인. AuthKit과 Calendar OAuth를 분리한 copy 유지 | `로그인`, `로그인 취소` |
| WorkOS 미설정 | 한국어 `로그인 제공자가 설정되어 있지 않습니다` | 재시도 |
| 로그인 취소/timeout | 대기 스피너에 갇히지 않음 | `다시 로그인` |
| signed-in + 미완료 가이드 | `OnboardingGuide`가 본문. sidebar 13개 그대로 | 단계 CTA, `나중에`, `설정 완료`(allReady일 때만 enabled) |
| signed-in + 가이드 완료/dismiss | 기존 shell. topbar `Calendar AI` 30px | 기존 화면 |
| Railway 끊김 | 기존 정직한 배너. 가짜 최신 데이터 금지 | `다시 시도` |
| 오프라인 스냅샷 | 읽기 가능, 쓰기는 실패를 숨기지 않음 | 재연결 |

금지: “준비 중 100%”, 합성 이름/메일, 로그인 직후 Calendar/Gmail consent 자동 팝업.

### 시작 가이드 (`OnboardingGuide`)

| Step id | 제목 (사용자) | ready 조건 | 빈/오류 | CTA |
| --- | --- | --- | --- | --- |
| `calendar` | 캘린더 사용 방식 | Google source `connected` + `lastSyncedAt` **또는** 내부 캘린더 사용 선택 | OAuth 취소=`연결 필요`. admin client 없음=관리자 설정 안내. skip은 Google 연결로 표시하지 않음 | `Google Calendar 연결` / `내부 캘린더로 계속` / `지금 동기화` |
| `records` (기존 `wiki` id 유지, 라벨만 변경) | 기록 연결 (선택) | local vault **또는** ready knowledge source **또는** Gmail connected **또는** 사용자가 `폴더 없이 계속`를 누름 | `LLM_WIKI_VAULT` 금지. 폴더 취소는 실패가 아님 | `로컬 폴더 연결`, `파일 추가`(암호화 동의 후), `Google 메일 연결`, `폴더 없이 계속` |
| `second_brain` | 나를 이해하기 | snapshot.status=`active` **또는** `source_required` 확인 후 나중에 만들기 선택 | `source_required`: 연결 CTA와 `자료를 연결한 뒤 만들기`. `running/queued`: 실제 stage+processed/total. `failed/interrupted`: 저장 지점부터 재시작. citation 없는 claim 숨김 | `검토 완료 및 활성화`, claim별 확인/수정/제외, `나중에 만들기` |
| `calendar_ai` | Calendar AI 확인 | 기존 규칙 | 대화 id만으로 ready 금지 | `Calendar AI 화면 열기` → `openScreen('calendar'); setChatOpen(true)` |
| `runner` | 실행 컴퓨터 (선택) | active runner 존재 | 오프라인은 ready이되 `현재 오프라인`. 1차 copy에 일회용 코드는 두되 “Runner”를 제목에서 뺀다 | `실행 컴퓨터 연결` → 기존 `runner` 화면 |

`records`의 `폴더 없이 계속`는 local flag (`onboardingRecordsSkipped=true`)로 step.ready를 true로 만든다. Second Brain은 이 flag만으로 run하지 않는다. source가 없으면 계속 `source_required`.

### 1. 캘린더 `calendar`

| 상태 | 최소 UI | CTA |
| --- | --- | --- |
| 외부 캘린더 없음 | 기존 월간 그리드 + `외부 캘린더 없음`. 브리핑 카드 없음 | 소스 행 `Google Calendar 연결` |
| 연결·미동기화 | `동기화 필요` | `지금 동기화` |
| 연결·동기화 | 기존 Me/Agent/All, Month/Week/Day, Today, prev/next, CRUD | 기존 일정 추가/수정/삭제 |
| OAuth 설정 없음 | 관리자 설정 필요. 대기 중으로 위장 금지 | 재시도 |
| 권한 철회 | source disconnected, Second Brain stale는 온보딩/Calendar AI에만 | 다시 연결 |
| 완료 작업 있음 | 기존 agent result row (`workResultId`, 잘리지 않은 결과) | row 클릭 → 해당 작업 대화 |
| 사람/에이전트 겹침 | 충돌로 표시하지 않음 (기존 계약) | 필터만 |

금지: `나를 이해한 캘린더`, `Second Brain vN`, `Calendar AI에 물어보기` 대형 카드.

### 2. 에이전트 `agents`

| 상태 | 최소 UI | CTA |
| --- | --- | --- |
| Control Home, 작업 0 | 세션 레일 + `새 작업` composer. 설정 disclosure 접힘 | `새 작업` 전송, `실행 컴퓨터 연결`(생성 불가 시) |
| 실행 컴퓨터 없음/오프라인 | composer disabled, `실행 컴퓨터 연결이 필요합니다` (기존 테스트: 메시지에 `Runner` 없음) | Runner 화면으로 |
| 작업 선택 | Work Conversation + 하단 composer + 레일 | 보내기, 중단, 재시도, 승인/거절 |
| queued | `대기 중` | 추가 지시는 저장, 실행은 대기 |
| running | `진행 중`, composer는 지시 가능, 전송 중 `응답 중` | `작업 실행 중단` (선택 Work만) |
| blocked / approval | 체크포인트에 범위·담당만 | 승인, 거절. 미지원 외부 요청은 승인 버튼 없음 |
| failed | 원인 + 재시도 | `실패한 단계 재시도` |
| completed | 전체 markdown, artifact, current result | 수정 차수, Wiki 경로 또는 `폴더 미연결 · 보관 대기` |
| cancelled | 기록 유지 | 새 작업 |
| 병렬 | 레일에 running 1 + queued N (capacity 1) 또는 running≤capacity | 한 Work 중단이 다른 Work를 바꾸지 않음 |
| 전환 isolation | draft/error/liveTurn은 missionId keyed | 다른 Work composer가 비어 있음 |
| 재시작 | 저장 작업 N개 복원, composer empty | 마지막 선택 복원 |
| 접힌 에이전트 설정 | 초안 프로필/기억 | 기존 review/test/activate. 내부 id 금지 |

### 3. 자동화 `automation`

| 상태 | 최소 UI | CTA |
| --- | --- | --- |
| 소스 없음 | 기존 empty. 합성 자동화 0 | 소스 연결 (고급) |
| 초안 있음 | 기본 dashboard, `자동화 설정` 접힘 | 펼친 뒤 review/activate. 활성화 전 실행 0 |
| 담당 미활성 | 정확한 `담당 에이전트를 먼저 활성화해 주세요.` | 에이전트 설정으로 |
| 활성 루틴 | occurrence + receipt | 1회 실행, 실패 숨기지 않음 |

### 4. 오늘 `today` / 5. 다음 7일 `next7` / 6. 기본함 `tasks` / 8. 칸반 `kanban`

기존 작업 원본을 유지한다. 추가 최소 UI:

- 메일/Calendar AI에서 만든 열린 일은 `tasks`에 남는다.
- 에이전트 완료/지연은 기존 배지.
- 새 AI 요약 카드 없음.
- CTA: 기존 추가/완료/위임. 위임은 `agents`로 연다.

### 7. 메일함 `mail`

| 상태 `connector` | UI | CTA |
| --- | --- | --- |
| `not_linked` | `Google 메일 읽기 전용`. **Calendar와 한 번에 연결한다는 문장 삭제** | `Google 메일 연결` |
| busy | `Google 연결 중...` | disabled |
| `connected` + 목록 | 읽기 전용 inbox | 새로고침, `Google 권한 다시 연결` |
| `connected` + empty | `받은편지함이 비어 있습니다.` | 새로고침 |
| `reauthorization_required` | 재승인 필요 | `Google 권한 다시 연결` |
| admin OAuth 없음 | 관리자 설정 확인. Electron welcome/local server로 나가지 않음 | 재시도 |
| 로드 실패 | 기존 데이터 불변 | `메일 다시 불러오기` |
| 메시지 선택 | 본문 | `작업으로 추가` → tasks, `에이전트에 위임` → agents. `답장 초안`은 **새 작업 초안**이지 메일 전송이 아님. copy를 `답장 초안 작업`으로 바꾼다 |

### 9. 위키 `wiki`

| 상태 | UI | CTA |
| --- | --- | --- |
| folderless + knowledge 0 | `로컬 Wiki 미연결` + 지식 소스 패널 | `로컬 폴더 연결`, 동의 후 `파일 추가` |
| folderless + knowledge N | Workspace 파일 검색/질문. 로컬 트리/그래프는 비어 있음을 정직히 | 질문, 연결 해제 |
| local folder | 기존 tree/graph/reader/ask. 절대 경로 비노출 | 폴더 변경, 질문 |
| picker 취소 | 이전 상태 유지 | 없음 |
| pending_local | `이 컴퓨터 폴더에 아직 쓰지 못한 기록이 있습니다` | `로컬 폴더 연결` |
| 폴더 후 hydrate | 같은 projectionId write 또는 replay | 없음 (자동) |
| path traversal / id mismatch | 실패, 기존 파일 불변 | 재시도 |

### 10. 주간 회고 `review` / 11. 일기 `diary`

기존 입력 유지. 폴더 있으면 로컬 저장, 없으면 Workspace 문서 또는 pending_local. 가짜 저장 성공 금지.

### 12. Runner 설정 `runner`

고급 화면. 등록 → 설치/열기 → 일회용 코드 → owner 확인. revoke는 매트릭스에서 NOT CLICKED(운영 Runner 파괴) 또는 disposable enrollment만. 자격 증명은 Runner에 남는다.

### 13. 위젯 `widgets`

미리보기만. 내부 실행 버튼 없음.

### Calendar AI (`ChatDrawer`, topbar)

| 상태 | UI | CTA |
| --- | --- | --- |
| 소스 없음 | 일정 근거 없음을 정직히. 일반 잡담 성공 위장 금지 | 캘린더 연결 |
| 답변 | 본문 + citations + envelope/snapshot(고급 토글이 아니라 cite 칩만) | 보내기 |
| `delegate_work` 초안 | `승인 전 초안` | `승인하고 실행` → Work Intake → **agents에서 해당 작업 열기**, `초안 수정`, `취소` |
| Runner 없음에서 승인 | 작업을 만들지 않거나 queued-unavailable로 정직. 성공 toast 금지 | `실행 컴퓨터 연결` |
| 일정 초안 | 기존 미리보기 | 등록/취소 |
| 기억 | 접힌 개인 기억 | 저장/잊기/삭제 |
| revoke 후 다음 답변 | 해당 citation 제거 | 없음 |

## State Machines

### A. Auth

`signed_out → authenticating → signed_in`  
실패: `provider_unconfigured | cancelled | state_mismatch | network`.  
모든 실패는 signed_out으로 돌아오고 재시도 가능하다. `AUTH_STATE_MISMATCH_STALE`는 URL query state만 신뢰한다 (기존 수정).

### B. Google Calendar source

`absent → authorizing → connected → synced`  
가지: `denied`, `admin_unconfigured`, `revoked`, `sync_failed`.  
로그인 세션과 Gmail 연결과 독립.

### C. Gmail connection

`not_linked → authorizing → connected`  
가지: `reauthorization_required`, `admin_unconfigured`, `denied`, `empty_inbox`.  
Calendar sync를 트리거하지 않는다.

### D. Wiki binding

`unbound → (folder_selected | knowledge_added | skipped)`  
`folder_selected → indexed`  
`pending_local + folder_selected → written | replay | write_failed`  
skipped는 Second Brain source가 아니다.

### E. Second Brain run

`idle → queued → collecting → indexing → extracting → linking → ready_for_review → active`  
가지: `source_required`, `interrupted`, `failed`, `stale`(revoke/supersede).  
진행 숫자는 `processed/total`만. 합성 percent 문구 금지.

### F. Work

`preview → start → queued → running → (completed | failed | cancelled | blocked)`  
개입: message `accepted|applied|queued|approval_required|rejected`.  
수정 차수는 같은 Work. 다른 목표는 `follow_up_required`이지 자동 생성 아님.  
workingContext: default `workspace_general`; 고급에서만 opaque `local_folder`.

## Edge Cases

- 신규 WorkOS 계정, 일정/메일/Wiki 0: 빈 캘린더 + 가이드. 합성 금지.
- 신규 계정 + Calendar만: Second Brain은 캘린더 근거만. Wiki 구조는 pending_local. 설정 완료 가능.
- 신규 계정 + Gmail만, Calendar 거부: 메일은 연결, 내부 캘린더는 사용 가능. Second Brain
  coverage에 gmail만. 사용자가 `내부 캘린더로 계속`을 선택하면 설정 완료가 가능하며 Google
  Calendar 연결 CTA는 캘린더에 남는다.
- Calendar 허용, Gmail 거부: 로그인·캘린더 유지, 메일 `not_linked`.
- Gmail Restricted scope, 테스트 사용자 아님: 정직한 Google 오류, 앱 잔류.
- 로컬 폴더 picker 취소: unbound 유지.
- 폴더 없는 작업이 Runner daemon cwd를 쓰지 않음.
- local_folder가 opaque handle 밖 경로를 요청하면 거부.
- Runner 미설치: 지식은 읽고 작업 생성은 막는다.
- Runner 설치·오프라인: 등록됨/오프라인. 새 실행 queued 또는 unavailable.
- capacity 1에 두 작업: 하나만 running.
- 전환 중 stream 실패: 해당 Work에만 부분/오류. 다른 Work composer 오염 금지.
- 미리보기 15분 만료 또는 source/profile 변경: `WORK_PREVIEW_STALE`. 동일 attestation 즉시 시작은 허용 (C8).
- 빈 deliverable: `{kind:'report', format:'markdown'}` (C10). 이상한 kind는 fail-closed.
- `automatic:profile_match`만 자동 배정으로 파싱 (C11).
- 완료 대화 200 + parser 거부는 회귀 FAIL (C9 역사).
- source-empty로 27건 historical record를 가진 현재 production 계정은 fixture로 쓰지 않는다. 신규 계정이 필요하다.

## 283-file Keep / Rewrite / Discard

분류 대상은 origin/main과 다른 283개 제품 path다. `.ouroboros/**`와 `docs/product/surfaces/**`는 카운트에서 제외하거나, 포함되더라도 아래와 같다.

### Keep — 통합한다 (의미 유지, 이 계획의 UX 구멍만 최소 수정)

Backend Module/route/contract:

- `apps/backend/app/lib/source-library.js`
- `apps/backend/app/lib/second-brain.js`
- `apps/backend/app/lib/context-assembler.js`
- `apps/backend/app/lib/work-intake.js`
- `apps/backend/app/lib/routine-planner.js`
- `apps/backend/app/lib/client-v1-contract.js` (second-brain, context-envelope, work-intake, mail-google, routine)
- `apps/backend/app/lib/production-route-registry.js` / `production-product-routes.js` (등록된 경로)
- `apps/backend/app/lib/google-calendar-adapter.js` (purpose별 scope)
- `apps/backend/app/lib/google-auth-callback-bridge.js`
- `apps/backend/app/lib/calendar-ai-service.js` (delegate_work → Work Intake)
- `apps/backend/app/lib/durable-execution.js`, `runner-control.js`, `agent-work-wiki-archive.js`
- `apps/backend/app/db/migrations/0035_agent_work_calendar_terminal_backfill.sql`
- `apps/backend/app/db/migrations/0036_user_mail_connections.sql`
- `apps/backend/app/db/migrations/0037_personal_second_brain.sql`
- `apps/backend/app/db/migrations/0038_context_envelopes.sql`
- dirty `0009`/`0010`/`0013`/`0014`/`0022` 중 `migration-replay-safety.test.cjs`가 잠그는 idempotent hunk만

Desktop/Electron:

- `apps/desktop/src/features/second-brain/secondBrainClient.ts`
- `apps/desktop/src/features/second-brain/secondBrainModel.ts`
- `apps/desktop/src/features/second-brain/SecondBrainOnboarding.tsx` (source_required/running/review)
- `apps/desktop/electron/mailOAuth.ts`, `localWikiWriter.ts`, `localWikiAsk.ts`
- Agent Work conversation parser/presentation/live stream/session rail (C10/C11 계약)
- `apps/desktop/src/features/knowledge/workResultWikiProjection.ts`

Tests (기준선으로 유지, 이 계획이 깨는 것만 의도적 RED):

- `orca-shell-calendar-design.test.mjs`
- `calendar-intelligence-release-a0.test.mjs`, `calendar-intelligence-release-a5.test.mjs`
- `second-brain-onboarding.test.mjs`, `playwright-second-brain-onboarding.cjs`
- `google-mail-oauth.test.mjs`, `gmail-user-oauth.test.cjs`, `gmail-readonly-connector.test.cjs`
- `work-intake-boundary.test.cjs`, `work-result-feedback.test.cjs`
- `second-brain-foundation.test.cjs`, `second-brain-activation-projection.test.cjs`
- `context-assembler-calendar-ai.test.cjs`
- `runner-capacity-boundary.test.cjs`, `execution-loop-work-context.test.cjs`
- `local-wiki-vault-selection.test.mjs`, `local-wiki-write-boundary.test.mjs`, `work-result-local-wiki-projection.test.mjs`
- `login-authkit-copy.test.mjs`
- `agent-work-conversation.test.mjs`, `interactive-agent-work-execution-state.test.cjs`

Docs keep: PRD, CONTEXT, C12 receipts, button matrix(역사), README/surfaces(origin/main merge).

### Rewrite — 계약/copy/조성만 바꾼다 (파일 삭제 금지)

| 파일 | 바꿀 점 |
| --- | --- |
| `apps/desktop/src/features/onboarding/onboardingReadiness.ts` | `wiki`·(신규 mail coverage) optional. `폴더 없이 계속` ready. `LLM_WIKI_VAULT` 제거. runner 제목 `실행 컴퓨터 (선택)` |
| `apps/desktop/src/features/onboarding/OnboardingGuide.tsx` | records 단계에 Gmail/폴더/파일/스킵. 개발자 env 문구 삭제 |
| `apps/desktop/tests/onboarding-readiness.test.mjs` | 위 계약으로 재작성. 기존 “others not optional”은 폐기 |
| `apps/desktop/src/features/communication/MailScreen.tsx` | 통합 consent 문장 삭제. 답장 초안=작업 |
| `apps/desktop/src/features/communication/ChatDrawer.tsx` | 승인 후 mission 이동은 App이 담당. 버튼 라벨 `작업 시작` 가능 |
| `apps/desktop/src/App.tsx` | `actOnCalendarAiDraft` approve 성공 시 `openScreen('agents')` + 해당 mission 선택. briefing import 계속 금지. 가이드 dismiss/complete → calendar |
| `apps/desktop/src/features/agent-operations/AgentWorkWorkspace.tsx` | `새 작업` / 엔진 비노출. isolation keying 확인 |
| `apps/desktop/src/features/agent-operations/useAgentWorkLiveTurn.ts` | draft/error/liveTurn missionId keyed (IDE QA FAIL 재현 후 수정) |
| `apps/desktop/src/features/knowledge/WikiScreen.tsx` | folderless 안내 한 줄. pending_local 정직 |
| `apps/desktop/src/api/hermesApi.ts` | 필요 시 work-intake client. Calendar AI 경로가 missionId를 돌려주면 최소 composition만 |
| `apps/desktop/tests/primary-agent-and-mail-connection.test.mjs` | 메일 copy, `작업 실행 중단` aria-label |
| `apps/desktop/src/features/second-brain/second-brain.css` | 온보딩 검토만. 캘린더 브리핑 스타일을 App에 연결하지 않음 |

### Discard / quarantine — 제품에 넣지 않거나 연결하지 않는다

- `apps/desktop/src/features/second-brain/SecondBrainCalendarBriefing.tsx`: **App에 import 금지.** 삭제해도 되고 unused로 남겨도 된다. 재연결은 회귀.
- `.ouroboros/**`: 커밋하지 않음.
- `scripts/macos-qa-click-control.swift`: 이번 여정에 불필요. 커밋하지 않음.
- `docs/qa/calendar-intelligence/2026-08-02/release-c/source-empty-journey.json`: source-empty 증거로 인용 금지.
- A6/B5/C7/C9 FAIL verdict: 역사. C12를 last-known-good으로만 사용.
- `docs/DESIGN.md`의 “first-run이 앱 셸을 대체하고 24px progress bar만 남긴다” 문장: 구현하지 않음. 문서 수정은 별도 docs chore.
- 새 `HomeScreen`, `Dashboard`, `SecondBrainScreen`, `AiStudio` route/파일: 만들지 않음.
- 레거시 Mode A/B 고급 위임 UI, provider session 1차 표면: 다시 켜지 않음.

### Docs/QA 자산

- `docs/qa/**` 스크린/receipt: 커밋 가능하나 새 freeze 증거로 재사용하지 않음. 새 증거는 `docs/qa/first-user-production/2026-08-16/`.
- `docs/product/surfaces/**`: origin/main README용. 코드 계약 아님.
- 2026-08-01/02/03 plans: 참고. 충돌 시 이 파일이 이긴다.

## Clean Main Integration Order

현재: branch는 origin/main에 2커밋 뒤 (README/web), 2커밋 앞 (Gmail/ready probe) + 대규모 dirty tree.
이 worktree는 source archive로 보존한다. dirty tree에 merge/rebase하지 않는다.

```text
0. 현재 worktree의 `git status --short`, local-only 목록, 파일 SHA manifest를 보존한다.
1. `origin/main`에서 새 top-level clean worktree/branch `first-user-production`을 만든다.
   현재 dirty worktree는 읽기 전용 source archive이며 merge/rebase/checkout하지 않는다.
2. Wave 0 characterization test와 이 계획만 먼저 이식한다.
3. Keep 목록을 backend contract → Electron boundary → Desktop UI → Runner 순으로 최소 이식한다.
   파일 전체 복사는 금지하고 각 Wave RED에 필요한 hunk만 가져온다.
4. Wave 1 onboarding/mail/copy 커밋.
5. Wave 2 Calendar AI → agents handoff 커밋.
6. Wave 3 Work isolation/folderless 잔여 커밋.
7. Wave 4 Wiki pending_local honesty 커밋.
8. 한 release commit SHA를 freeze.
9. 그 SHA만 Railway deploy + signed package.
10. 신규 WorkOS 계정 production QA.
11. QA 실패 시 제품 고침은 새 SHA. 현재 `d86a1ae` production을 rollback 기준으로 보존한다.
```

커밋 메시지 접두: `test:`, `fix:`, `feat:`만. 한 Wave에 한 의미.

Railway+package identity 공식:

```text
SOURCE_SHA=$(git rev-parse HEAD)
# Railway image label / gateway /api/gateway-status build == SOURCE_SHA
# apps/desktop package extraMetadata / embedded marker == SOURCE_SHA
# shasum -a 256 .../app.asar 를 docs/qa/first-user-production/2026-08-16/frozen-identity-receipt.json 에 기록
# codesign --verify --deep --strict  exit 0
# 세 값이 다르면 QA를 시작하지 않는다
```

## TDD Seams

구현자는 각 Wave에서 가장 위의 명령을 먼저 실행해 **예상 이유로 RED**인 것을 로그에 남긴다.

### Wave 0 — 기준선 (제품 코드 변경 없음)

```bash
node --test --test-concurrency=1 \
  apps/desktop/tests/orca-shell-calendar-design.test.mjs \
  apps/desktop/tests/calendar-intelligence-release-a0.test.mjs \
  apps/desktop/tests/calendar-intelligence-release-a5.test.mjs \
  apps/desktop/tests/login-authkit-copy.test.mjs
```

기대: GREEN. 깨지면 이 계획보다 먼저 기준선 회귀를 고친다.

### Wave 1 — 온보딩/메일/폴더리스 계약

**Create:** `apps/desktop/tests/first-user-journey-states.test.mjs`

RED 내용 (구현 전 실패해야 함):

```js
test('wiki and mail steps are optional so folderless setup can complete');
test('folderless continue does not start a Second Brain run');
test('source-empty run stays source_required and never says 파악 중');
test('mail empty copy does not claim Calendar and Gmail share one consent');
test('onboarding user copy does not mention LLM_WIKI_VAULT');
test('runner step title is 실행 컴퓨터 and does not block allReady');
```

기존 파일을 RED로 전환:

```bash
node --test --test-concurrency=1 \
  apps/desktop/tests/onboarding-readiness.test.mjs \
  apps/desktop/tests/first-user-journey-states.test.mjs \
  apps/desktop/tests/primary-agent-and-mail-connection.test.mjs \
  apps/desktop/tests/second-brain-onboarding.test.mjs
```

기대 RED 이유:

- `onboarding-readiness`: `others not optional` (wiki)
- `primary-agent-and-mail-connection` 또는 신규: MailScreen 통합 consent 문장
- `first-user-journey-states`: 아직 함수/copy 없음

GREEN 최소 구현: `onboardingReadiness.ts`, `OnboardingGuide.tsx`, `MailScreen.tsx` copy, 테스트 기대값 갱신.

### Wave 2 — Calendar AI → 작업 대화

**Modify tests:**

- `apps/desktop/tests/calendar-intelligence-release-a5.test.mjs`에 추가:
  - `actOnCalendarAiDraft` approve 성공 경로가 `openScreen('agents')`와 mission id를 쓴다
- `apps/backend/tests/phase6-calendar-ai.test.cjs` (이미 workIntake origin 검증 있음) — 승인 응답에 `missionId` 유지
- **Create:** `apps/desktop/tests/calendar-ai-work-handoff.test.mjs`

```js
test('approving delegate_work opens the existing agents conversation for that mission');
test('approving delegate_work without an execution computer does not look successful');
test('App still does not import SecondBrainCalendarBriefing');
```

```bash
node --test --test-concurrency=1 \
  apps/desktop/tests/calendar-ai-work-handoff.test.mjs \
  apps/desktop/tests/calendar-intelligence-release-a5.test.mjs \
  apps/backend/tests/phase6-calendar-ai.test.cjs
```

GREEN: `App.tsx` `actOnCalendarAiDraft`만. ChatDrawer 레이아웃 재설계 금지.

### Wave 3 — Work isolation / 폴더 / 병렬

**Modify:** `apps/desktop/tests/agent-work-live-stream.test.mjs`, `apps/desktop/tests/agent-work-conversation.test.mjs`

```js
test('rejected draft and request_failed stay on the work that produced them');
test('switching works clears the composer of the hidden work');
```

**Keep RED/GREEN already present:**

```bash
node --test --test-concurrency=1 \
  apps/backend/tests/work-intake-boundary.test.cjs \
  apps/backend/tests/interactive-agent-work-execution-state.test.cjs \
  apps/runner/tests/execution-loop-work-context.test.cjs \
  apps/backend/tests/runner-capacity-boundary.test.cjs
```

GREEN: `useAgentWorkLiveTurn.ts`, composer state를 `Map<missionId, …>`로. 전역 `request`/`error` 금지.

### Wave 4 — Wiki 환류 정직

```bash
node --test --test-concurrency=1 \
  apps/desktop/tests/local-wiki-write-boundary.test.mjs \
  apps/desktop/tests/work-result-local-wiki-projection.test.mjs \
  apps/backend/tests/work-result-feedback.test.cjs
```

추가 RED:

```js
test('folderless workspace keeps pending_local and does not claim wiki written');
test('failed and cancelled work do not create a success Source Record');
```

### Wave 5 — Playwright (로컬 렌더러, production 대체 아님)

```bash
node apps/desktop/tests/playwright-second-brain-onboarding.cjs
node apps/desktop/tests/playwright-calendar-crud.cjs
node apps/desktop/tests/playwright-agent-work-workspace.cjs
node apps/desktop/tests/playwright-release-c-existing-surface-integration.cjs
```

**Create:** `apps/desktop/tests/playwright-first-user-folderless.cjs`

시나리오: 가이드 → 폴더 없이 계속 → source_required → Calendar 연결 스텁 → 초안 citation → Calendar AI open → 13 nav 회귀.

### Wave 6 — frozen production QA (코드 수정 없는 QA dispatch)

증거 디렉터리: `docs/qa/first-user-production/2026-08-16/`

필수 계정:

1. **신규 WorkOS 계정** (진짜 empty Source Library)
2. **source-rich 계정** (현재 production 계정 재사용 가능, 단 empty 증거로 쓰지 않음)

필수 외부 권한:

- Railway Google OAuth client (Calendar + Gmail)
- Gmail Restricted test user
- 실제 Runner 1대, capacity 2 한 시나리오 / capacity 1 한 시나리오
- 로컬 폴더 하나, 폴더 없는 기기 프로필 하나

로컬 Vite 금지. 패키지 `file://.../app.asar/dist/index.html`만.

## Implementation Checklist

- [ ] Step 0: 현재 dirty source archive의 status/hash를 보존하고 `origin/main` 기반 clean top-level worktree를 만든다. 현재 worktree에는 merge/rebase하지 않는다.
- [ ] Step 1: Wave 0 기준선 명령을 GREEN으로 기록.
- [ ] Step 2: `first-user-journey-states.test.mjs` 작성 후 RED 확인.
- [ ] Step 3: onboarding wiki/mail optional + 폴더 없이 계속 + copy. 같은 테스트 GREEN.
- [ ] Step 4: MailScreen 독립 consent / 답장 초안 작업. `primary-agent-and-mail-connection` GREEN.
- [ ] Step 5: Calendar AI approve → agents mission handoff RED then GREEN.
- [ ] Step 6: Work isolation RED (IDE QA 재현) then GREEN.
- [ ] Step 7: folderless pending_local honesty RED then GREEN.
- [ ] Step 8: Agent 1차 copy `새 작업`, 엔진 비노출. 관련 design/create-readiness 테스트 GREEN.
- [ ] Step 9: `npm run backend:check` && focused backend tests.
- [ ] Step 10: `npm run typecheck` && `npm --workspace apps/desktop run test`.
- [ ] Step 11: `npm run test:runner` && `npm run build:desktop`.
- [ ] Step 12: `npm test`.
- [ ] Step 13: 한 SHA freeze, Railway deploy, signed package, identity receipt.
- [ ] Step 14: 신규 WorkOS 계정 + source-rich 계정으로 아래 매트릭스 클릭.
- [ ] Step 15: 앱/Gateway/Runner restart, source revoke, Gmail/Calendar 독립 거부.
- [ ] Step 16: 실패 항목만 fix Task. QA dispatch는 코드를 고치지 않는다.

## All-Button Acceptance Matrix

판정: `PASS` | `HONEST_DISABLED` | `EXTERNAL_BLOCKED` | `NOT_CLICKED`. 무반응·가짜 성공은 FAIL.

### Login / shell

| 컨트롤 | 기대 | 빈/오류 |
| --- | --- | --- |
| 로그인 | AuthKit 브라우저 → `agent-calendar://auth/callback` → signed-in | provider 미설정 한국어 |
| 로그인 취소 | signed-out 복귀 | timeout도 동일 |
| Calendar / 에이전트 / 자동화 / 오늘 / 다음 7일 / 기본함 / 메일함 / 칸반 / 위키 / 주간 회고 / 일기 / Runner 설정 / 위젯 | 해당 화면, 선택 상태 유지 | 로딩이 빈 셸을 지우지 않음 |
| Calendar AI topbar | ChatDrawer open | 소스 없으면 정직한 제한 답 |
| 가이드 나중에 | calendar | 필수 미완이어도 허용 |
| 설정 완료 | calendar, 가이드 숨김 | allReady 아니면 disabled |
| 검색 | 기존 exact task open | empty no-op |
| 프로필 설정 각 pane | 기존 동작, 원래 값 복구 | 업데이트 채널 없음=`EXTERNAL_BLOCKED` |

### Onboarding

| 컨트롤 | 기대 |
| --- | --- |
| Google Calendar 연결 | Calendar scope만. 로그인/Gmail 불변 |
| 지금 동기화 | lastSyncedAt 갱신 |
| Google 메일 연결 | gmail.readonly만 |
| 로컬 폴더 연결 | native picker. 취소=무변경 |
| 파일 추가 | 동의 없으면 disabled. 있으면 knowledge source |
| 폴더 없이 계속 | wiki step ready. Second Brain run 없음 |
| 원본 다시 확인 | source_required 재평가 |
| claim 확인/수정/제외 | 새 version, 충돌 시 conflict 메시지 |
| 검토 완료 및 활성화 | active snapshot, Wiki 초안, agent/routine draft, 실행 0 |
| Calendar AI 화면 열기 | calendar + drawer |
| 실행 컴퓨터 연결 | runner 화면 |

### Calendar

| 컨트롤 | 기대 |
| --- | --- |
| Me/Agent/All, Month/Week/Day, Today, prev/next | 기존 |
| 일정 생성/수정/삭제 | `/api/calendar/events` CRUD. A0 lock |
| 소스 연결/해제 | Calendar only |
| agent result row | 해당 Work Conversation |
| 빈 제출 | no-op |

### Mail

| 컨트롤 | 기대 |
| --- | --- |
| Google 메일 연결 / 다시 연결 | mail IPC only, Calendar IPC 금지 |
| 새로고침 | 목록 재조회 |
| 작업으로 추가 | tasks에 열린 일 |
| 에이전트에 위임 | agents, Runner 없으면 생성 막힘 정직 |
| 답장 초안 작업 | 새 작업 초안. Gmail send 0 |

### Wiki / Diary / Review

| 컨트롤 | 기대 |
| --- | --- |
| 로컬 폴더 연결 | vault persist |
| 파일 추가 / 연결 해제 | Workspace isolation |
| 질문 | 허용 소스 citation |
| 일기 저장 / 회고 저장 | 폴더 있으면 파일, 없으면 pending 또는 Workspace 문서 |

### Agent Work

| 컨트롤 | 기대 |
| --- | --- |
| 새 작업 전송 | preview/start 또는 레거시 create → 같은 대화 | Runner 없으면 HONEST_DISABLED |
| 세션 레일 항목 | 해당 대화, 다른 draft 비노출 |
| 새 작업 (레일) | Control Home |
| composer 보내기 | delivery `접수됨` 등 기존 한국어 |
| 작업 실행 중단 | 선택 Work만 cancelled |
| 재시도 | 같은 Work |
| 승인/거절 | 지원 동작만. 미지원 외부=거절 체크포인트 |
| 에이전트 설정 펼침 | draft review/test/activate |
| 기억 confirm/reject/delete | 다음 job snapshot에만 반영 |

### Automation / Runner / Widgets

| 컨트롤 | 기대 |
| --- | --- |
| 자동화 설정 펼침 | 초안 review |
| 활성화 | 담당 활성 필요. 아니면 정확 문구 |
| 1회 실행 | receipt. 실패 숨김 금지 |
| Runner 추가/테스트 | enrollment |
| Runner 해제 | 운영 러너는 `NOT_CLICKED` |
| 위젯 면 | 버튼 없음 |

## New-User Success Bar

아래를 **신규 WorkOS 계정 + signed package + Railway + 실 Runner**에서 한 세션에 통과해야 첫 사용자 production이다.

1. 패키지 앱 콜드 스타트 → AuthKit 로그인 → 빈 Workspace (일정/메일/Wiki/작업 0).
2. 가이드에서 Calendar 연결·동기화. Gmail은 따로 연결하거나 거부.
3. `폴더 없이 계속` 후 Second Brain이 캘린더 근거 초안을 보여 주거나, 소스가 아직 없으면 `source_required`.
4. citation 있는 claim 1개를 수정하고 활성화. Calendar에 브리핑 카드가 없다.
5. Calendar AI에 “이번 주 중요한 일 알려줘” → 근거 있는 답.
6. “이 내용을 한 장 문서로 정리해줘” → 초안 승인 → **에이전트 탭에서 그 작업 대화가 열린다.**
7. 폴더 없는 작업이 완료되고 잘리지 않은 결과가 대화와 캘린더 row에 있다. Wiki는 pending_local.
8. 같은 세션에서 로컬 폴더를 연결하면 동일 `workResultId` 파일이 write되고 재시작 후 replay.
9. 두 번째 작업을 병렬로 넣고 하나만 중단한다.
10. 앱 종료 후 재실행: 로그인 유지, snapshot, 두 작업, pending/written Wiki 유지.

측정 (PRD KR, 이 출시의 관측 가능 형태):

- 첫 세션 source 1+ 연결 + 초안 확인: QA 계정 2/2 (empty는 source_required 확인, rich는 초안 확인).
- 근거 없는 성격/관계 추정: 0.
- 완료 작업의 대화/결과/Wiki 또는 명시적 pending: 100%.
- 승인 없는 외부 전송/구매/삭제/새 권한: 0.
- 재시작 복구: 100%.

## Test Plan

- RED:
  - [ ] Wave 1–4의 명시 테스트가 예상 이유로 실패
- GREEN:
  - [ ] 같은 테스트가 최소 구현으로 통과
  - [ ] A0/A5/navigation/Calendar CRUD가 계속 GREEN
- REFACTOR:
  - [ ] green 범위에서 copy 중복만 정리. App.tsx 분할은 이 계획 밖
- Boundary:
  - [ ] Calendar AI approve ↔ Work Intake ↔ Desktop parser
  - [ ] Gmail authorize ↔ mail_connections ↔ MailScreen
  - [ ] pending_local ↔ localWikiWriter ↔ hydrate
- Production:
  - [ ] 신규 계정 여정 10단계
  - [ ] 버튼 matrix
  - [ ] SHA identity receipt

## Acceptance Gates

- [ ] `npm run backend:check`
- [ ] `npm run test:backend`
- [ ] `npm run typecheck`
- [ ] `npm --workspace apps/desktop run test`
- [ ] `npm run test:runner`
- [ ] `npm run build:desktop`
- [ ] `npm test`
- [ ] `codesign --verify --deep --strict` on signed `.app`
- [ ] Railway deployment SUCCESS, Railway metadata source == gateway build == package marker == git SHA
- [ ] `/api/ready` 200 또는 readiness가 요구하는 production operations 설정을 실제로 완료
- [ ] 신규 WorkOS 계정 여정 10단계 PASS
- [ ] source-rich 회귀 (C12 게이트 + 이 계획 handoff/folderless)
- [ ] 버튼 matrix에 FAIL/무반응 0

건너뛴 gate:

- Gate: Gmail Restricted 공개 검증 / 신규 Google Cloud 앱 리뷰
  - Reason: 운영자·Google 프로세스. 테스트 사용자로만 실사용 검증.
- Gate: Widget companion 재서명/DMG
  - Reason: 기존과 같이 별도 artifact. Desktop `.app`만 이번 여정.
- Gate: 원본 저장 위치 전략 재결정
  - Reason: 이미 adapter storage_mode로 고정. 인터뷰 안 함.

## Rollback / Fallback

- 현재 재현 가능한 Railway rollback: Git `d86a1aee4291ebc04dfd5a94debde2559c6b963b` /
  deployment `180de29c-7e2c-4aba-9af4-776d357dbd77`.
- C12 `f2a3b430…` / `08f238e7…` / `app.asar e40ab928…`는 기능 비교 증거다.
  `f2a3b430…`가 Git object가 아니므로 source rollback으로 주장하지 않는다.
- 새 패키지가 identity 불일치면 배포하지 않고 현재 production main을 유지한다.
- `VITE_SECOND_BRAIN_V1=0` / 서버 flag off: 기존 4보 가이드(calendar/runner/wiki/calendar_ai)와 기존 Calendar AI로 후퇴. 연결된 source row는 삭제하지 않음.
- Gmail 문제: mail route/IPC만 끄기. Calendar grant와 로그인 유지.
- Work Intake 문제: Calendar AI → Work 전환만 끄고 기존 Agent create/history/Runner enrollment 유지.
- Wiki writer 문제: pending_local 유지, Diary/Review/Second Brain 초기 writer는 유지.
- migration: additive only. rollback은 flag/route disable이지 DROP이 아님.
- 새 SHA QA 실패 시 traffic을 새 배포에 남기지 않는다.

## Remaining Risks

- Risk: 신규 WorkOS 계정이 다시 없으면 empty 게이트가 NOT RUN이 된다.
  - Mitigation: QA 시작 전 coordinator가 계정을 만든다. 없으면 succeeded로 위장하지 않고 external-blocked로 남긴다.
- Risk: dirty worktree 동시 편집.
  - Mitigation: 단일 editor, ownership 밖 hunk 금지, Wave 전후 `git diff --stat`.
- Risk: 283개 delta를 파일 단위로 복사하면 main의 이후 수정과 과거 실패를 함께 되살릴 수 있다.
  - Mitigation: origin/main clean worktree에서 RED 단위 hunk만 이식하고 Wave별 commit/review를 한다.
- Risk: Calendar AI approve가 missionId를 Desktop에 안 내려주면 handoff가 실패한다.
  - Mitigation: Wave 2 backend 응답 contract를 먼저 RED로 고정.
- Risk: Gmail Restricted가 테스트 사용자 밖에서 실패.
  - Mitigation: 정직한 오류 + Calendar 단독 경로로 첫 가치 유지.
- Risk: C12 이후 dirty 지능이 Railway에 부분 배포되면 SHA drift가 재발한다 (A6/B5 원인).
  - Mitigation: identity receipt 없이 QA 시작 금지.
- Risk: `폴더 없이 계속`가 Second Brain 합성으로 오용됨.
  - Mitigation: skip flag는 wiki ready만, run은 source inventory > 0일 때만.

## Verification Notes

- Command: `git rev-parse HEAD` / `origin/main` / unique path count
  - Result: `35748b2` / `d86a1ae` / 303 unique (283 excluding ouroboros+surfaces)
- Command: 제품 코드 변경
  - Result: 이 계획 작성에서 없음. backend:check / desktop test / packaged QA 미실행 (설계 전용).
- Command: C12 receipt 읽기
  - Result: 2026-08-03 frozen triple PASS. 신규 계정 NOT RUN. 현재 worktree와 SHA 불일치.
- 구현 시작 시 Step 0 스냅샷으로 이 절을 갱신한다.
