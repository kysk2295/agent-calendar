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
> Wave 1(`bda4a7c`)은 온보딩 skip/copy만 닫았다. 다음 제품 Wave는 **Wave 0R가 GREEN인 뒤에만**
> 시작한다. Gmail OAuth(Wave G)와 Second Brain(Wave S)은 Wave 1 copy가 아니라 독립 TDD Wave다.
> dirty archive `escolar`의 `0f8bee3`와 uncommitted Gmail/Second Brain 파일은 읽기 전용 참고다.
> 파일 전체 복사를 하지 말고, 각 Wave RED가 요구하는 hunk만 이식한다.

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

## Evidence Snapshot (2026-08-16, clean worktree `first-user-production`)

구현 Wave를 시작하기 전 `git status`로 다시 찍는다. 다른 작업자가 파일을 추가해도 이 계획의 keep/rewrite 규칙을 적용한다. 이 표의 dirty archive 숫자는 역사다. **현재 구현 worktree는 origin/main + Wave 1만** 가진다.

| 항목 | 관측 |
| --- | --- |
| Implementation branch | `kysk2295/first-user-production` |
| Implementation HEAD | `bda4a7c6821785667c447e865731cfd25f14fc27` `feat: make first-user setup connections optional` |
| origin/main | `d86a1aee4291ebc04dfd5a94debde2559c6b963b` |
| origin/main...HEAD | Wave 1 7 files (onboarding/mail copy + 이 계획). 최신 committed migration은 `0034`. |
| 이 worktree의 unrelated dirty | `apps/runner/bin/agent-calendar-runner.js`, `apps/runner/bin/agent-calendar-runner-update.js` — **다른 작업자 hunk. revert 금지.** |
| Dirty source archive | `/Users/koyunseo/orca/workspaces/agent-calendar/escolar` HEAD `35748b2`, Gmail commit `0f8bee3`, plus uncommitted `mailOAuth.ts` / `0036`–`0038` / `second-brain.js` / `source-library.js` / second-brain desktop. **읽기 전용. 파일 전체 복사 금지.** |
| 과거 dirty-archive snapshot | branch `kysk2295/agent-control-p0-wave1` @ `35748b2`, local modified+untracked ≈ 299. C12/Railway 숫자는 아래 행과 같다. |
| 과거 C12 frozen triple | marker `f2a3b430bdc0`, Railway `08f238e7-5757-496d-b97a-67b5033853b0`, `app.asar` `e40ab9286f4199c635335ca636e608f6e74d3051e31698db08b2d25206e3c703`. `f2a3b430…`는 현재 Git object가 아니므로 재현 가능한 rollback이 아니라 참고 증거다. |
| 현재 Railway source | deployment `180de29c-7e2c-4aba-9af4-776d357dbd77`, Git `d86a1aee4291ebc04dfd5a94debde2559c6b963b`; `/api/gateway-status`의 `f2a3b430bdc0` 표시는 stale marker다. |
| Production gateway | `https://hermes-os-production-e174.up.railway.app` |
| 신규 WorkOS 계정 | C12 `NOT RUN / external authority` |
| 진짜 source-empty | C7/C9의 `source-empty-journey.json`은 connector 0이어도 Source Library 27건. **빈 계정 증거가 아님** |
| origin/main 기준선 3 RED (2026-08-16 이 worktree에서 재현) | `login-authkit-copy`는 `auth.ts`에서 `WORKOS_CONFIG_MISSING` 문자열을 찾고, `agent-work-live-stream` fixture는 `handoffGraph.handoffs`가 없고, `agent-worker-strip` fixture는 `mission.deliverable.kind`가 없다. |

코드에서 확인한 첫 사용자 구멍 (이 계획이 닫는다):

1. `buildOnboardingReadiness()`에서 `wiki`는 required다. 폴더/지식 소스 없으면 `allReady=false`. 폴더 없는 첫 사용자가 설정 완료를 못한다 (`apps/desktop/tests/onboarding-readiness.test.mjs` 244–254행이 이 계약을 잠근다).
2. 온보딩에 Gmail 단계가 없고, `MailScreen.tsx` 빈 상태 copy가 “Google Calendar와 Gmail 읽기 전용 권한을 한 번에 연결합니다”라고 거짓말한다. 실제 scope는 `google-calendar-adapter.js`에서 Calendar=`calendar`, Mail=`gmail.readonly`로 분리되어 있다.
3. Wiki/온보딩 copy가 `LLM_WIKI_VAULT`를 쓴다. 비개발자 언어가 아니다.
4. `SecondBrainCalendarBriefing.tsx`는 남아 있으나 `App.tsx`는 import하면 안 된다 (`calendar-intelligence-release-a5.test.mjs`). C5/C12는 캘린더 기본 화면의 브리핑 카드 부재를 PASS로 고정했다.
5. Calendar AI `delegate_work` 승인은 backend에서 Work Intake preview/start를 탄다 (`calendar-ai-service.js` 1066–1118). Desktop `actOnCalendarAiDraft`는 hydrate만 하고 `agents` 화면·해당 mission을 열지 않는다. 첫 사용자는 승인 뒤 작업 대화를 보지 못한다.
6. Desktop `hermesApi.ts`에 `work-intake.preview/start` client가 없다. 직접 시작 경로는 레거시 `agent-work.create`다.
7. Agent Control Home 1차 copy가 `새 위임 작업`, `실행 엔진`을 노출한다. `CONTEXT.md`는 `새 작업`과 엔진 비노출을 요구한다.
8. 2026-08-02 Agent IDE QA는 Work 전환 시 `request_failed` draft 누출을 FAIL로 남겼다. C12는 완료 대화 복원만 재검증했다. isolation은 첫 사용자 acceptance에 다시 넣는다.

### Wave 1 검토 (`bda4a7c`) — 닫힌 것 / 아직 구멍

Wave 1은 온보딩 **선택/skip/copy 계약**만 닫았다. Gmail 연결과 Second Brain run은 닫지 않았다.

닫힘:

- `wiki` / `mail` / `runner` optional. `폴더 없이 계속`와 step skip이 `allReady`를 막지 않는다.
- skip만으로 `secondBrainSourceAvailable`이 true가 되지 않는다 (`first-user-journey-states`).
- `LLM_WIKI_VAULT` 사용자 copy 제거. runner 제목 `실행 컴퓨터 (선택)`.
- MailScreen 연결 안내가 Calendar+Gmail 통합 consent를 주장하지 않는다. `답장 초안 작업`.

아직 구멍 (Wave 0R / G / S가 닫는다):

9. `OnboardingGuide`는 `actionKind === 'mail_open'`이면 **primary CTA를 렌더하지 않는다.** `runAction`도 mail을 다루지 않고 `onConnectMail` prop이 없다. 사용자는 skip만 할 수 있다.
10. `App.tsx`의 `buildOnboardingReadiness()`가 `mailConnected`를 넘기지 않는다. 메일이 연결되어도 가이드는 `메일 연결 안 됨`이다.
11. MailScreen 빈 상태가 여전히 `계정별 OAuth 메일 연결은 준비 중입니다`라고 말한다. `not_linked → authorizing → connected` CTA/IPC/route가 이 worktree에 없다.
12. origin/main `GET /api/mail/messages`만 있고 `POST /api/mail/google/authorize|callback`이 없다. `mail_connections` 테이블도, adapter `purpose: 'mail'`도 없다. callback bridge는 login `agent-calendar://auth/callback`만 연다.
13. Second Brain Module/route/UI/`second_brain` onboarding step이 없다. `secondBrainSourceAvailable`은 로컬 boolean일 뿐 run이 아니다. work_result·skip·historical Source Library로 `active`를 합성할 경로를 아직 잠그지 않았다.

## Touched Boundaries

- Backend gateway: `apps/backend/app/lib/production-product-routes.js`, `production-route-registry.js`, `phase1-auth-routes.js`, `apps/backend/app/railway-gateway-server.js` (composition only)
- Backend library: `source-library.js`, `second-brain.js`, `context-assembler.js`, `work-intake.js`, `calendar-ai-service.js`, `google-calendar-adapter.js`, `google-auth-callback-bridge.js`, `client-v1-contract.js`, `workspace-scoped-product-service.js`, `agent-work-wiki-archive.js`, `runner-control.js`
- DB/migrations: 이 worktree latest committed는 `0034`. Wave G가 `0036_user_mail_connections`를, Wave S가 `0037_personal_second_brain`을 additive로 추가한다. `0035_agent_work_calendar_terminal_backfill`과 `0038_context_envelopes`는 해당 Wave(작업 환류 / Calendar AI envelope) RED가 요구할 때만 이식한다. `0009`/`0010`/`0013`/`0014`/`0022` dirty hunk는 replay-safety만 살리고 스키마 재해석 금지
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
      2. 기록 연결                     [선택: 로컬 폴더 / 파일 / 폴더 없이 계속]
      3. Google 메일                   [선택: gmail.readonly 연결 / 나중에]
      4. Second Brain 초안 검토        [허용 source 있으면 run, 없으면 source_required]
      5. Calendar AI 열기              [기존 topbar chat-fab / 가이드 CTA]
      6. 실행 컴퓨터                   [선택; 작업 전에만 필요]
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
| `records` (기존 `wiki` id 유지, 라벨만 변경) | 기록 연결 (선택) | local vault **또는** ready knowledge source **또는** 사용자가 `폴더 없이 계속`를 누름 | `LLM_WIKI_VAULT` 금지. 폴더 취소는 실패가 아님. skip은 Second Brain source가 아님 | `로컬 폴더 연결`, `파일 추가`(암호화 동의 후), `폴더 없이 계속` |
| `mail` (Wave 1이 분리한 step id. 되돌리지 않음) | Google 메일 (선택) | backend `listMailMessages.connector === 'connected'` **또는** skip | Wave 1은 skip만 동작. Wave G가 CTA를 실제 authorize로 연다. `준비 중입니다` 문구 삭제 | `Google 메일 연결` → mail IPC only. 이미 연결되면 `메일 화면 열기` |
| `second_brain` (Wave S가 추가) | 나를 이해하기 | snapshot.status=`active` **또는** `source_required` 확인 후 나중에 만들기 선택 | `source_required`: 연결 CTA와 `자료를 연결한 뒤 만들기`. `running/queued`: 실제 stage+processed/total. `failed/interrupted`: 저장 지점부터 재시작. citation 없는 claim 숨김 | `검토 완료 및 활성화`, claim별 확인/수정/제외, `나중에 만들기` |
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
| `not_linked` | `Google 메일 읽기 전용`. **Calendar와 한 번에 연결한다는 문장 삭제. `준비 중입니다` 삭제** | Wave G: `Google 메일 연결` → mail IPC. Wave 1 copy만으로는 연결되지 않음 |
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
- `0035`–`0038`는 이 worktree에 아직 없다. escolar uncommitted 참고용. Wave G=`0036`, Wave S=`0037`, Wave 4=`0035`(필요 시), Wave 2=`0038`(필요 시). 파일 전체 복사 금지.
- dirty `0009`/`0010`/`0013`/`0014`/`0022` 중 `migration-replay-safety.test.cjs`가 잠그는 idempotent hunk만 (이 worktree에 없으면 이식하지 않음)

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

현재 구현 위치: clean worktree `kysk2295/first-user-production` @ `bda4a7c` (Wave 1 완료).
dirty archive `escolar`에는 merge/rebase/checkout하지 않는다.

```text
0. dirty archive status/hash는 이미 보존됨. 이 worktree에서 다른 작업자 runner dirty를 건드리지 않는다.
1. Wave 0으로 origin/main 기준선 3 RED를 기록한다 (제품 코드 금지).
2. Wave 0R로 그 3개를 원인별로 고치고 GREEN을 남긴다.
3. Wave G: Gmail OAuth e2e. escolar에서 authorize/callback/mailOAuth hunk만 이식.
4. Wave S: 허용 source Second Brain. escolar에서 source-library/second-brain hunk만 이식.
   Wave S의 mail-origin 케이스는 Wave G connector 뒤에 둔다. calendar/file/source_required는 병렬 가능.
5. Wave 2 Calendar AI → agents handoff.
6. Wave 3 Work isolation/folderless.
7. Wave 4 Wiki pending_local honesty.
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
한 Wave의 공개 seam RED가 예상 이유로 실패하기 전에 다음 Wave 제품 코드를 쓰지 않는다.
각 Wave 블록의 **Files**는 hunk 단위다. dirty archive 파일을 통째로 덮어쓰지 않는다.

참고 전용 (복사 금지):

- `escolar@0f8bee3` committed: purpose별 Calendar/Mail scope, `gmail-readonly-connector.test.cjs` 초안
- `escolar` uncommitted: `apps/desktop/electron/mailOAuth.ts`, `0036_user_mail_connections.sql`, `0037_personal_second_brain.sql`, `0038_context_envelopes.sql`, `apps/backend/app/lib/second-brain.js`, `apps/backend/app/lib/source-library.js`, `apps/backend/tests/gmail-user-oauth.test.cjs`, `apps/backend/tests/second-brain-foundation.test.cjs`, `apps/desktop/tests/google-mail-oauth.test.mjs`, `apps/desktop/src/features/second-brain/**`

### Wave 0 — 기준선 기록 (제품 코드 변경 없음)

**Depends on:** none  
**Public seams:** 13 nav / login copy / A0 Calendar CRUD / A5 no briefing card  
**Files:** 없음  
**First RED (이미 존재, 2026-08-16 재현):**

1. `apps/desktop/tests/login-authkit-copy.test.mjs` — `auth.ts` 원문에 `/WORKOS_CONFIG_MISSING/` 없음. 실제 정책은 `loginFailure.ts`의 `desktopLoginStartFailureMessage()`.
2. `apps/desktop/tests/agent-work-live-stream.test.mjs` — `a failed automatic plan…` fixture `conversation`에 `handoffGraph`가 없어 `AgentWorkConversationView`가 `handoffs`를 읽다 throw.
3. `apps/desktop/tests/agent-worker-strip.test.mjs` — `Work Conversation mounts the worker strip…`의 `mission`에 `deliverable.kind`가 없어 `AgentWorkDetails`가 throw.

**Narrow command:**

```bash
node --test --test-concurrency=1 \
  apps/desktop/tests/orca-shell-calendar-design.test.mjs \
  apps/desktop/tests/calendar-intelligence-release-a0.test.mjs \
  apps/desktop/tests/calendar-intelligence-release-a5.test.mjs \
  apps/desktop/tests/login-authkit-copy.test.mjs \
  apps/desktop/tests/login-failure-message.test.mjs \
  apps/desktop/tests/agent-work-live-stream.test.mjs \
  apps/desktop/tests/agent-worker-strip.test.mjs
```

기대: A0/A5/design/`login-failure-message`는 GREEN. 위 3개는 RED로 기록하고 Wave 0R로 넘긴다. 제품 코드로 기준선을 약화하지 않는다.

**Rollback:** 해당 없음 (기록만).

### Wave 0R — origin/main 기준선 3 RED 원인별 수리 (선행, 제품 동작 변경 금지)

**Depends on:** Wave 0 기록  
**Public seams:** 테스트 fixture와 login 실패 copy 정책. Calendar/Mail/Second Brain 동작 변경 없음.  
**Files (modify only):**

- `apps/desktop/tests/login-authkit-copy.test.mjs`
- `apps/desktop/electron/loginFailure.ts` (읽기; 문자열을 `auth.ts`에 다시 심지 않음)
- `apps/desktop/electron/auth.ts` (읽기; `desktopLoginStartFailureMessage` 호출 유지)
- `apps/desktop/tests/agent-work-live-stream.test.mjs`
- `apps/desktop/tests/agent-worker-strip.test.mjs`

**First RED:** 위 3개 기존 테스트. 새 제품 테스트는 만들지 않는다.

원인별 GREEN:

1. `WORKOS_CONFIG_MISSING` — 테스트가 `auth.ts`에 코드 문자열이 있다고 가정한다. 구현은 이미 `loginFailure.ts`로 옮겼다. 테스트를 `loginFailure.ts`의 한국어 미설정 copy와 `auth.ts`가 `desktopLoginStartFailureMessage(response.status, …)`를 호출한다는 사실에 맞춘다. `auth.ts`에 dead string을 넣지 않는다.
2. missing `handoffs` fixture — `AgentWorkConversationView` L429 `props.conversation.handoffGraph.handoffs.length`. fixture `conversation`에 `handoffGraph: { rootMissionId, rootAgentId, maxDepth: 0, maxFanOut: 0, handoffs: [] }`와 빈 `providerSessions` / `comparison.outcomes`를 채운다. View를 optional-chain으로 약화하지 않는다.
3. missing `kind` fixture — `AgentWorkDetails` L75 `props.mission.deliverable.kind`. worker-strip 테스트의 `mission`에 `deliverable: { kind: 'file', format: 'auto' }`를 넣는다. Details를 가드하지 않는다.

**Narrow command:**

```bash
node --test --test-concurrency=1 \
  apps/desktop/tests/login-authkit-copy.test.mjs \
  apps/desktop/tests/login-failure-message.test.mjs \
  apps/desktop/tests/agent-work-live-stream.test.mjs \
  apps/desktop/tests/agent-worker-strip.test.mjs
```

**Rollback:** 이 Wave 커밋만 revert. 제품 파일이 바뀌면 이 Wave가 아니다.

### Wave 1 — 온보딩/메일/폴더리스 계약 [SHIPPED `bda4a7c`]

**Depends on:** none (0R와 독립적으로 이미 합쳐짐)  
**Public seams:** `OnboardingGuide` skip CTA, `buildOnboardingReadiness` optional steps, MailScreen 독립 consent copy  
**Files (이미 커밋):** `onboardingReadiness.ts`, `OnboardingGuide.tsx`, `MailScreen.tsx` copy, `first-user-journey-states.test.mjs`, `onboarding-readiness.test.mjs`, `primary-agent-and-mail-connection.test.mjs`

**남은 RED는 Wave G/S로 이동.** Wave 1을 재작업하거나 skip 계약을 되돌리지 않는다.

**Narrow command (회귀):**

```bash
node --test --test-concurrency=1 \
  apps/desktop/tests/onboarding-readiness.test.mjs \
  apps/desktop/tests/first-user-journey-states.test.mjs \
  apps/desktop/tests/primary-agent-and-mail-connection.test.mjs
```

**Rollback:** `bda4a7c` revert. origin/main 4-step required wiki로 돌아간다.

### Wave G — Gmail OAuth e2e (`not_linked → authorizing → connected` / revoke / retry)

**Depends on:** Wave 0R GREEN. Wave 1 copy는 유지.  
**Public seams:**

- `POST /api/mail/google/authorize` → `{ state, authorizationUrl }` (`state` prefix `mail.`)
- `POST /api/mail/google/callback` `{ code, state }` → `{ connection: { provider:'google', status } }`
- `GET /api/mail/messages` → `{ connector: 'not_linked'|'connected'|'reauthorization_required', items }`
- Electron IPC `mail:google-connect` / deep link `agent-calendar://mail/google/callback`
- Gateway HTTPS callback이 `state` prefix로 mail vs calendar vs login deep link를 고른다
- Desktop: OnboardingGuide `Google 메일 연결` CTA, MailScreen connect/retry, `mailConnected`는 `connector === 'connected'`만

**Files (create — 최소 신규 파일만):**

- `apps/backend/app/db/migrations/0036_user_mail_connections.sql`
- `apps/desktop/electron/mailOAuth.ts`
- `apps/backend/tests/gmail-user-oauth.test.cjs` (user-bound state; 통째 복사 금지)
- `apps/desktop/tests/google-mail-oauth.test.mjs` (IPC/authorize/callback only)
- `apps/desktop/tests/first-user-gmail-connect.test.mjs` (가이드 CTA + backend truth)

**Files (modify — hunk only):**

- `apps/backend/app/lib/google-calendar-adapter.js` — `getAuthorizationUrl({ purpose })`, `listMailMessages`
- `apps/backend/app/lib/unified-calendar.js` — `startGoogleMailAuthorize`, `finalizeGoogleMailOAuth`, `listMailMessages` connector
- `apps/backend/app/lib/production-route-registry.js` / `production-product-routes.js` / `client-v1-contract.js`
- `apps/backend/app/lib/google-auth-callback-bridge.js` — `mail.` → `agent-calendar://mail/google/callback`
- `apps/desktop/electron/deepLink.ts`, `deepLinkMain.ts`, `preload.ts`, `preload.cts`, `main.ts`, `vite-env.d.ts`
- `apps/desktop/src/features/onboarding/OnboardingGuide.tsx` — `mail_open` CTA 복구, `onConnectMail`
- `apps/desktop/src/features/onboarding/onboardingReadiness.ts` — `mailConnected`는 caller가 넣은 backend truth만
- `apps/desktop/src/features/communication/MailScreen.tsx` — connector/CTA, `준비 중입니다` 삭제
- `apps/desktop/src/App.tsx` — `connectGoogleMail`, hydrate `inbox.connector`, readiness `mailConnected: mailConnector === 'connected'`
- `apps/backend/tests/gmail-readonly-connector.test.cjs` (origin/main에 있으면 확장, 없으면 최소 생성)
- `apps/desktop/tests/primary-agent-and-mail-connection.test.mjs`

**First RED (이 순서로 하나만 먼저 실패시킬 것):**

`apps/desktop/tests/first-user-gmail-connect.test.mjs`

```js
test('OnboardingGuide mail CTA renders and invokes onConnectMail, not calendar IPC');
test('mailConnected is true only when backend connector is connected');
test('MailScreen not_linked shows Google 메일 연결 and never says 준비 중입니다');
```

기대 RED 이유: `OnboardingGuide`가 `mail_open` 버튼을 숨기고, `App.tsx`가 `mailConnected`/`onConnectMail`을 넘기지 않으며, MailScreen에 connector CTA가 없다.

바로 이어서 backend seam RED:

```js
// apps/backend/tests/gmail-readonly-connector.test.cjs
test('Google Calendar and Gmail consent request separate minimum scopes');
test('production exposes authenticated Gmail authorize and callback routes');
```

기대 RED 이유: `getAuthorizationUrl`에 `purpose`가 없고 `/api/mail/google/authorize`가 registry에 없다.

**Narrow command:**

```bash
node --test --test-concurrency=1 \
  apps/desktop/tests/first-user-gmail-connect.test.mjs \
  apps/desktop/tests/google-mail-oauth.test.mjs \
  apps/desktop/tests/primary-agent-and-mail-connection.test.mjs \
  apps/backend/tests/gmail-readonly-connector.test.cjs \
  apps/backend/tests/gmail-user-oauth.test.cjs \
  apps/backend/tests/google-auth-callback-bridge.test.cjs
```

GREEN 최소: mail route + `0036` + purpose=mail scope + Electron mail coordinator + 가이드/MailScreen CTA가 그 IPC를 연다. Calendar grant, login, 13 nav를 바꾸지 않는다. Gmail send/delete/star 없음.

상태 기계: `not_linked → authorizing → connected`. 가지 `denied` / `admin_unconfigured` / `reauthorization_required` / `empty_inbox`. revoke/retry는 같은 mail IPC. Calendar sync를 트리거하지 않는다.

**Rollback:** Desktop `mail:google-connect` IPC와 `/api/mail/google/*` route만 끈다. `0036`은 DROP하지 않는다. Calendar source와 WorkOS 세션은 유지.

### Wave S — 허용 source Second Brain (`source_required → collecting → review → active`)

**Depends on:** Wave 0R GREEN. mail-origin 케이스는 Wave G connector 이후. calendar/file/`source_required`는 Wave G와 병렬 가능.  
**Public seams:**

- `POST /api/second-brain/runs` `{ idempotencyKey, sourceIds? }`
- `GET /api/second-brain/runs/:id`, `GET /api/second-brain/current`
- `POST /api/second-brain/snapshots/:id/review`
- bootstrap 허용 origin: `calendar`, `mail`, `file` (ready knowledge / local vault). `work_result`는 환류이지 bootstrap이 아니다.
- skip / `폴더 없이 계속` / empty inbox / 내부 캘린더 skip은 source row를 만들지 않는다.
- Desktop: onboarding step `second_brain` in-place. `source_required`는 “파악 중”/가짜 % 금지. running은 `stage` + `processed/total`.

**Files (create):**

- `apps/backend/app/db/migrations/0037_personal_second_brain.sql`
- `apps/backend/app/lib/source-library.js` (허용 adapter만: knowledge file, calendar, mail)
- `apps/backend/app/lib/second-brain.js`
- `apps/backend/tests/second-brain-foundation.test.cjs` 중 source-empty / provenance 테스트만
- `apps/desktop/src/features/second-brain/secondBrainClient.ts`
- `apps/desktop/src/features/second-brain/secondBrainModel.ts`
- `apps/desktop/src/features/second-brain/SecondBrainOnboarding.tsx`
- `apps/desktop/src/features/second-brain/second-brain.css`
- `apps/desktop/tests/second-brain-onboarding.test.mjs`
- `apps/desktop/tests/first-user-second-brain-states.test.mjs`

**Files (modify — hunk only):**

- `production-route-registry.js`, `production-product-routes.js`, `client-v1-contract.js`
- `onboardingReadiness.ts` — step `second_brain` 추가. `ready`는 `active` 또는 `source_required_acknowledged`. skip은 run을 시작하지 않음
- `OnboardingGuide.tsx` — in-place review panel. 새 route/nav 없음
- `App.tsx` — current snapshot hydrate. `SecondBrainCalendarBriefing` import 계속 금지
- `0038_context_envelopes.sql`은 이 Wave가 아니라 Wave 2 envelope RED가 요구할 때만

**First RED:**

`apps/backend/tests/second-brain-foundation.test.cjs`

```js
test('source-empty Second Brain does not infer from derived Work results');
```

기대 RED 이유: `SecondBrain` / `SourceLibrary` / `0037` / `second_brain_run_start` route가 없다.

바로 이어서 Desktop:

```js
// apps/desktop/tests/first-user-second-brain-states.test.mjs
test('folderless continue does not start a Second Brain run');
test('source-empty run stays source_required and never says 파악 중');
test('only calendar, mail, and file origins can leave source_required');
```

기대 RED 이유: `second_brain` step과 run client가 없다. Wave 1의 `secondBrainSourceAvailable`만으로는 부족하다.

**Narrow command:**

```bash
node --test --test-concurrency=1 \
  apps/backend/tests/second-brain-foundation.test.cjs \
  apps/desktop/tests/first-user-second-brain-states.test.mjs \
  apps/desktop/tests/second-brain-onboarding.test.mjs \
  apps/desktop/tests/first-user-journey-states.test.mjs \
  apps/desktop/tests/calendar-intelligence-release-a5.test.mjs
```

GREEN 최소: 허용 source 0이면 `source_required` + inference 0회. 허용 source가 있으면 `collecting → indexing → extracting → linking → ready_for_review → active`. citation 없는 claim 숨김. confirm/correct/reject가 snapshot version을 바꾼다. Calendar 기본 화면에 브리핑 카드 없음.

금지: work_result·historical Source Library·skip flag로 inventory를 채우기. `source-empty-journey.json`을 fixture로 쓰지 않기. `SecondBrainCalendarBriefing`을 App에 연결하지 않기.

**Rollback:** `VITE_SECOND_BRAIN_V1=0` 및 `second_brain_*` route disable. `0037` DROP 금지. 연결된 calendar/mail/file source row는 삭제하지 않음.

### Wave 2 — Calendar AI → 작업 대화

**Depends on:** Wave 0R. Second Brain citation은 Wave S 이후 회귀에만 필요.  
**Public seams:** Calendar AI approve 응답 `missionId` → Desktop `openScreen('agents')` + 해당 conversation.  
**Files:** `apps/desktop/src/App.tsx` (`actOnCalendarAiDraft` only), `apps/desktop/src/api/hermesApi.ts` (필요 시 work-intake client), `apps/backend/app/lib/calendar-ai-service.js` (응답 contract), `apps/desktop/tests/calendar-ai-work-handoff.test.mjs`, `calendar-intelligence-release-a5.test.mjs`, `apps/backend/tests/phase6-calendar-ai.test.cjs`. `0038`는 envelope RED가 요구할 때만.

**First RED:**

```js
test('approving delegate_work opens the existing agents conversation for that mission');
```

**Narrow command:**

```bash
node --test --test-concurrency=1 \
  apps/desktop/tests/calendar-ai-work-handoff.test.mjs \
  apps/desktop/tests/calendar-intelligence-release-a5.test.mjs \
  apps/backend/tests/phase6-calendar-ai.test.cjs
```

GREEN: `App.tsx` `actOnCalendarAiDraft`만. ChatDrawer 레이아웃 재설계 금지.  
**Rollback:** Calendar AI → Work 전환만 끄고 기존 Agent create/history 유지.

### Wave 3 — Work isolation / 폴더 / 병렬

**Wave 3A [SHIPPED `46f802c`]:** `WorkIntake` 모듈, ProductService `previewAgentWork`/`startAgentWork`, `acceptPreviewedWork`, `WORK_PREVIEW_ATTESTATION_REQUIRED`, unit/pool/attestation 테스트. HTTP route/composition/Desktop client/`previewWork`는 없다.  
**3B와 3C는 3A 이후 독립이다.** 3B = HTTP preview/start compose. 3C = Runner cwd/capacity/interrupt (이미 `46f802c`부터 병렬 실행 중). 3C는 3B route/runtime compose를 기다리지 않는다. 배포 identity는 3B와 3C가 둘 다 GREEN인 SHA만 쓴다.

**Depends on:** Wave 0R GREEN. Wave 2 handoff(`ece6275`)는 이미 있다. Work Intake route는 Wave 2가 열지 않았다.
**2026-08-16 gap (clean `ece6275`):** 아래 4개 테스트와 `work-intake.js`는 clean에 **없다**. escolar untracked만 있다. `node --test`는 없는 경로를 조용히 건너뛴다. 2026-08-16 재현: `calendar-ai-work-handoff.test.mjs` + 없는 `work-intake-boundary.test.cjs` → exit 0, tests 1. Desktop만 돌리면 거짓 GREEN이다.

**Public seams:**

- API: `POST /api/work-intake/preview`, `POST /api/work-intake/start` (`work-intake.preview` / `work-intake.start`). scoped_product, member. Workspace RLS.
- DB: 새 working-context 테이블 없음. `agent_missions` + `execution_jobs` (+ offer/attempt load count). `workingContext`는 job/mission payload. **`0038_context_envelopes`는 이 Wave 금지.** persisted envelope RED가 따로 있기 전에 이식하지 않는다.
- Electron: 새 settings/dashboard/IPC path 없음. `local_folder.handle`은 이미 있는 Runner `registerKnowledgeSource` `sourceId`다. Railway/Desktop에 raw path 금지.
- Runner: `workspace_general` = `stateDir/execution-workspaces/<workspaceHash>/<workHash>` (daemon cwd 아님). `local_folder` = opaque handle만. capacity 1 = lease 1 + 나머지 queued. capacity 2 = 두 lease overlap. cancel은 그 mission만.

**UI:** 기존 세션 레일 + 대화 + composer. Codex/Claude처럼. 용량 설정 벽, working-context 화면, 새 홈/대시보드 없음. Desktop `useAgentWorkLiveTurn`은 이미 `missionId` owned다. **회귀 게이트이지 UI churn이 아니다.** composer를 `Map`으로 재설계하지 않는다. `key={missionId}`는 draft leak RED가 있을 때만.

**Selective port (escolar 읽기 전용. 통째 복사 금지):**

| 대상 | 출처 | 이식 |
| --- | --- | --- |
| create | `escolar` `?? apps/backend/app/lib/work-intake.js` | 모듈 전체 (clean에 없음, 테스트가 require) |
| create | `escolar` `?? apps/backend/tests/work-intake-boundary.test.cjs` | **앞 8개 unit 테스트만.** 마지막 `real durable boundary persists one isolated Work…`는 `ContextAssembler.assemble`이 `context_envelopes` INSERT를 하므로 **Wave 3 required GREEN에서 제외** |
| create | `escolar` `?? apps/backend/tests/interactive-agent-work-execution-state.test.cjs` | 파일 전체 (31줄, `normalizeExecutionState`) |
| create | `escolar` `?? apps/backend/tests/runner-capacity-boundary.test.cjs` | 파일 전체 |
| create | `escolar` `?? apps/runner/tests/execution-loop-work-context.test.cjs` | 파일 전체 |
| create | 이 계획 | `apps/backend/tests/runner-interrupt-isolation.test.cjs` (역사 파일에 interrupt-one-with-other-running 없음) |
| hunk | `public-agent-records.js` | `normalizeExecutionState` + export + `publicMissionRecord.executionState` |
| hunk | `runner-control.js` | `normalizeRunnerCapacity` (1–8), `deviceCapabilities.maxConcurrentWork`, `publicRunnerRow.maxConcurrentWork`, export |
| hunk | `durable-execution.js` | `acquireRunnerCapacitySlot` / `runnerCapacity`; `previewWork`; `acceptPreviewedWork`; `acceptWork`의 `WORK_PREVIEW_ATTESTATION_REQUIRED`; `nextOffer`/`leaseOffer`의 `runner_capacity_reached` / `RUNNER_CAPACITY_REACHED` |
| hunk | `workspace-scoped-product-service.js` | `setWorkIntake`, `previewAgentWork`, `startAgentWork` |
| hunk | `production-route-registry.js`, `production-product-routes.js`, `client-v1-contract.js` | preview/start 두 경로만 |
| hunk | `phase1-auth-routes.js` | `WorkIntake` compose. Calendar AI를 Work Intake 필수로 다시 쓰지 않음 (Wave 2 handoff 유지) |
| hunk | `apps/runner/lib/execution-loop.js` | `activeAttempts` map, `stableWorkDirectory`, `resolveWorkingContext`, `runOnce` capacity>1 |
| hunk | `apps/runner/lib/capabilities.js` | `normalizeMaxConcurrentWork` + capability report |
| hunk | `apps/runner/lib/client.js` | `reportCapabilities.maxConcurrentWork` |

이식 금지: `0038`, `context-assembler.js` 전체, escolar `durable-execution.js`/`runner-control.js`/`execution-loop.js` 파일 덮어쓰기, Desktop 레이아웃 재설계, runner bin dirty.

**First genuine RED (이 순서. 제품 코드 전에 테스트 파일만):**

1. Existence — 아래 `assert-wave3-files`가 `MISSING`을 찍는다. 없는 파일을 `node --test`에 넣지 않는다.
2. `work-intake-boundary.test.cjs`를 앞 8개 unit만 이식한 뒤 첫 테스트만:

```js
test('Calendar AI draft preview rejects a stale context/configuration snapshot before creating Work');
```

기대: `Cannot find module '../app/lib/work-intake'`. 이것이 첫 제품 RED다. Desktop `rejected draft and request_failed…`는 **이 이름 테스트가 clean에 없고**, live turn은 이미 mission-keyed라서 first RED가 아니다.

이어서 같은 파일, 제품 코드는 아직 `WorkIntake` require를 통과시키는 최소만:

```js
test('local_folder keeps only an opaque handle and rejects raw local paths');
test('two Work starts preserve isolated origin, envelope, and execution payload state');
test('Workspace product service exposes narrow Work Intake preview/start entries');
```

3. `interactive-agent-work-execution-state.test.cjs`

```js
test('Agent Work execution statuses project to the normalized public contract');
```

기대: `normalizeExecutionState` export 없음. `accepted|waiting_runner|offered → queued`, `leased|running → running`.

4. `runner-capacity-boundary.test.cjs` 첫 테스트:

```js
test('Gateway persists a bounded Runner capacity report');
```

기대: `normalizeRunnerCapacity` / `maxConcurrentWork` persist 없음. 이어서 `acquireRunnerCapacitySlot` load=capacity에서 `available:false`, `nextOffer`가 `runner_capacity_reached`로 job scan 없이 멈춤.

5. `execution-loop-work-context.test.cjs` 이 순서:

```js
test('workspace_general Work uses a stable per-Work directory independent of daemon cwd');
test('local_folder resolves only a registered opaque handle and rejects raw or unknown paths');
test('Runner capacity 2 overlaps two leases while capacity 1 leaves the second Work queued');
test('an interrupted attempt remains durable and a restarted retry clears only that Work');
```

기대: clean `runOnce`는 단일 `activeAttempt` + `cwd: process.cwd()`/`options.cwd`. `execution-workspaces` 없음.

6. **새 파일** `apps/backend/tests/runner-interrupt-isolation.test.cjs` (역사 테스트에 없음):

```js
test('requestCancel on one running Work leaves the other running Work leased');
```

기대: `requestCancel(scope, missionA)`가 `mission_id = missionA` job에만 `cancellation_requested`. missionB attempt/heartbeat는 그대로. capacity 2 + 두 live attempt fixture.

**User / session isolation (같은 Wave에서 잠글 것):**

- `preview`/`start`는 `assertWorkspaceScope`. 다른 workspace `execution_jobs` count 0 (unit: 두 start의 envelope/origin/runtimeState가 섞이지 않음. persisted last test는 0038 없이 강제하지 않음).
- `acceptWork`에 클라이언트가 넣은 `payload.workIntake`는 `WORK_PREVIEW_ATTESTATION_REQUIRED`.
- Desktop 회귀: `useAgentWorkLiveTurn` owned `missionId` 유지. 전환 시 다른 Work composer/live/error가 보이지 않음. 새 화면 없음.
- Runner `activeAttempts`는 attemptId keyed. 한 job의 retry는 그 job의 이전 attempt만 clear.

**GREEN 최소:**

- default workingContext `{ kind: 'workspace_general' }`. 같은 `jobId` 재실행 cwd가 같고 daemon cwd가 아니다.
- `local_folder`는 `folder_[A-Za-z0-9_-]{…}` handle + 선택 `label`. `path|cwd|root|wikiRoot|localPath|absolutePath` → `WORKING_CONTEXT_RAW_PATH_FORBIDDEN`. 미등록 handle → `LOCAL_FOLDER_HANDLE_NOT_FOUND`.
- capacity 1: lease 1, 두 번째 offer는 queued/`runner_capacity_reached`. capacity 2: 동시 lease 2, 세 번째는 거부.
- interrupt-one: 한 Work cancel이 다른 running Work를 바꾸지 않음.
- restart: crash 후 `activeAttempts[interrupted]` 유지, retry 성공 후 그 Work attempt만 clear.
- Desktop 기존 live-stream / conversation 테스트 GREEN. UI 재설계 없음.

**Existence gate + narrow commands (파일을 먼저 확인한다):**

```bash
assert_wave3_files() {
  missing=0
  for f in "$@"; do
    if [ ! -f "$f" ]; then echo "MISSING $f"; missing=1; fi
  done
  if [ "$missing" -ne 0 ]; then
    echo "node --test skipped; missing files would false-green"
    return 1
  fi
}
```

RED 0 — 이식 전 (지금 clean에서 실패해야 함):

```bash
assert_wave3_files \
  apps/backend/app/lib/work-intake.js \
  apps/backend/tests/work-intake-boundary.test.cjs \
  apps/backend/tests/interactive-agent-work-execution-state.test.cjs \
  apps/backend/tests/runner-capacity-boundary.test.cjs \
  apps/runner/tests/execution-loop-work-context.test.cjs \
  apps/backend/tests/runner-interrupt-isolation.test.cjs
```

RED/GREEN 1 — intake unit (마지막 postgres 테스트 제외):

```bash
assert_wave3_files \
  apps/backend/app/lib/work-intake.js \
  apps/backend/tests/work-intake-boundary.test.cjs
node --test --test-concurrency=1 --test-name-pattern='stale context/configuration|opaque handle|isolated origin|preview/start entries' \
  apps/backend/tests/work-intake-boundary.test.cjs
```

RED/GREEN 2 — public execution state:

```bash
assert_wave3_files apps/backend/tests/interactive-agent-work-execution-state.test.cjs
node --test --test-concurrency=1 apps/backend/tests/interactive-agent-work-execution-state.test.cjs
```

RED/GREEN 3 — gateway capacity:

```bash
assert_wave3_files apps/backend/tests/runner-capacity-boundary.test.cjs
node --test --test-concurrency=1 apps/backend/tests/runner-capacity-boundary.test.cjs
```

RED/GREEN 4 — Runner cwd / handle / capacity / restart:

```bash
assert_wave3_files apps/runner/tests/execution-loop-work-context.test.cjs
node --test --test-concurrency=1 apps/runner/tests/execution-loop-work-context.test.cjs
```

RED/GREEN 5 — interrupt-one-with-other-running:

```bash
assert_wave3_files apps/backend/tests/runner-interrupt-isolation.test.cjs
node --test --test-concurrency=1 apps/backend/tests/runner-interrupt-isolation.test.cjs
```

회귀 (이미 있는 Desktop 파일만. 없는 backend 파일을 넣지 말 것):

```bash
assert_wave3_files \
  apps/desktop/tests/agent-work-live-stream.test.mjs \
  apps/desktop/tests/agent-work-conversation.test.mjs
node --test --test-concurrency=1 \
  apps/desktop/tests/agent-work-live-stream.test.mjs \
  apps/desktop/tests/agent-work-conversation.test.mjs
```

한 묶음 GREEN (모든 파일이 생긴 뒤에만):

```bash
assert_wave3_files \
  apps/backend/app/lib/work-intake.js \
  apps/backend/tests/work-intake-boundary.test.cjs \
  apps/backend/tests/interactive-agent-work-execution-state.test.cjs \
  apps/backend/tests/runner-capacity-boundary.test.cjs \
  apps/runner/tests/execution-loop-work-context.test.cjs \
  apps/backend/tests/runner-interrupt-isolation.test.cjs \
  apps/desktop/tests/agent-work-live-stream.test.mjs \
  apps/desktop/tests/agent-work-conversation.test.mjs
node --test --test-concurrency=1 \
  apps/backend/tests/work-intake-boundary.test.cjs \
  apps/backend/tests/interactive-agent-work-execution-state.test.cjs \
  apps/backend/tests/runner-capacity-boundary.test.cjs \
  apps/runner/tests/execution-loop-work-context.test.cjs \
  apps/backend/tests/runner-interrupt-isolation.test.cjs \
  apps/desktop/tests/agent-work-live-stream.test.mjs \
  apps/desktop/tests/agent-work-conversation.test.mjs
```

intake 묶음이 마지막 postgres 테스트를 실행해 `context_envelopes` / `0038`로 실패하면 그 테스트를 Wave 3에서 skip/분리한다. `0038`을 심어 통과시키지 않는다.

**Rollback:** Work Intake route/IPC client와 Runner working-context/capacity hunk만 revert. `0038` DROP 없음 (이식하지 않음). 기존 `POST /api/agent-operations/work`, Wave 2 Calendar AI → agents, Desktop 대화 UI, runner bin dirty는 유지. migration additive only — 이 Wave는 payload 계약이지 새 테이블이 아니다.

### Wave 3B — Work Intake HTTP compose (`preview` / `start`)

**Depends on:** Wave 3A GREEN `46f802c`만. 3C와 병렬·독립. 3C GREEN을 기다리지 않는다.  
**Work size:** Boundary. 제품 코드는 아래 Files만. runner bin dirty / 다른 Wave hunk revert 금지.

**2026-08-16 evidence (`46f802c`):**

| Seam | 관측 |
| --- | --- |
| `WorkIntake` / ProductService `previewAgentWork`/`startAgentWork` | 있음. `workIntake` 없으면 `work_intake_unavailable` 503 |
| `DurableExecution.acceptPreviewedWork` + `WORK_PREVIEW_ATTESTATION_REQUIRED` | 있음 |
| `DurableExecution.previewWork` | **없음.** `WorkIntake` constructor는 `previewWork`를 요구한다. 실 `durableExecution`로 compose하면 boot throw |
| `createPhase1Runtime` | `new DurableExecution` 1회, `new WorkspaceScopedProductService` 1회. `WorkIntake` / `setWorkIntake` / `runtime.workIntake` **없음** |
| `production-route-registry.js` / `client-v1-contract.js` | `POST /api/work-intake/preview`·`/start` **없음**. 있는 create는 `POST /api/agent-operations/work` |
| `production-product-routes.js` | `agent_work_create_deferred`만 `createDeferredAgentWork`. work_intake action **없음** |
| Desktop `hermesApi.ts` | `createAgentWork` → `/api/agent-operations/work`. preview/start **없음** |
| `ContextAssembler` / `0038_context_envelopes` | **없음.** latest committed migration `0037` |
| `WorkIntake.#resolveContextEnvelope` | `contextEnvelopeId` 없으면 `contextAssembler.assemble`. id가 있으면 `context_envelopes` SELECT (테이블 없음) |
| Calendar AI / Desktop | `contextEnvelopeId`를 보내지 않음. Wave 2 approve는 기존 create + `openScreen('agents')` |

**0038 / persisted envelope — EXCLUDE (genuine persisted-contract RED 없음):**

- 첫 사용자 Desktop/Railway 경로는 `contextEnvelopeId`를 만들지 않고 보내지 않는다.
- assemble은 **상수/`ctx-1`/`digest-1`/합성 claim 금지.** caller Workspace+user의 `second_brain_snapshots` (`status='active'`, 이미 `0037`)만 읽는다. `context_envelopes` INSERT/SELECT 없음.
- HTTP body에 `contextEnvelopeId`가 오면 **테이블을 만들지 말고** `CONTEXT_ENVELOPE_UNAVAILABLE` 409. 없는 `context_envelopes`에 SQL 하지 않는다.
- `0038`과 escolar `context-assembler.js` 전체 이식은 Calendar AI가 persisted envelope id를 생산·전달하는 **별 RED**가 있을 때만. 이 assemble seam은 그 RED가 아니다.

**Public seams:**

- `POST /api/work-intake/preview` → `{ ok, preview, workspaceId }`
- `POST /api/work-intake/start` `{ previewSnapshotId, … }` → `{ ok, work, conversation, message, idempotentReplay, workspaceId }` (`parseAgentWorkCreateResponse`가 요구하는 `work`/`conversation`/`message` 유지)
- 둘 다 `class: scoped_product`, `role: member`, `persistence: write`, `idempotent: true`
- Gateway 인증 + `assertWorkspaceScope`. 익명 401. Workspace A 세션으로 B row 0
- Runtime은 `WorkIntake`를 **한 번** compose: `WorkContextAssembler` + `durableExecution` + `product.setWorkIntake` + `runtime.workIntake`
- `WorkContextAssembler.assemble(scope, { purpose: 'work', … })` (새 모듈 `apps/backend/app/lib/work-context-assembler.js`):
  - `assertWorkspaceScope` 후 `withAppRoleWorkspaceTransaction`으로 `second_brain_snapshots`를 `workspace_id=$1 and user_id=$2 and status='active' order by created_at desc, version desc limit 1` (SecondBrain `getCurrent`와 같은 키)
  - 활성 row 없음 또는 `claims=[]` (**source-empty / source_required / 미활성화**): `citations: []`, `snapshotVersion: 0`, `digest` = sha256(stable `{ workspaceId, userId, snapshotId: null, version: 0, claims: [] }`), `id` = `wctx_${digest[0..32]}`. claim/label/handle을 만들지 않는다
  - 활성 row 있음: `snapshotVersion = version`. citation은 각 claim의 기존 `citation`+`provenance.evidenceHandle`(없으면 claim `id`)만 `{ handle, label }`. 없는 근거를 채우지 않는다
  - `digest` = sha256(stable `{ workspaceId, userId, snapshotId, version, claims: [{ id, text, evidenceHandle, citation }] }`). 활성 snapshot version/claim이 바뀌면 digest·id·snapshotVersion이 바뀌고, 기존 preview는 `WORK_PREVIEW_STALE`
  - 다른 user/workspace active snapshot을 읽지 않는다. `context_envelopes`에 쓰지 않는다
- Desktop: `hermesApi.previewAgentWork` / `startAgentWork`. `workConversationClient.create`가 preview→start. 기존 `/api/agent-operations/work`는 레거시 유지 (phase3 테스트)

**Files (create):**

- `apps/backend/app/lib/work-context-assembler.js` — `assemble`만. escolar `context-assembler.js` 복사 금지
- `apps/backend/tests/work-context-assembler.test.cjs`
- `apps/backend/tests/work-intake-http-boundary.test.cjs`
- `apps/desktop/tests/work-intake-desktop-client.test.mjs`

**Files (modify — hunk only):**

- `production-route-registry.js` — preview/start 두 route + `DESKTOP_API_PATHS` 두 줄 (`POST /api/work-intake/preview`, `POST /api/work-intake/start`). 위치: agent-operations 블록 앞
- `client-v1-contract.js` — `family('agent-work')`에 `work-intake.preview` / `work-intake.start` (`work_intake_preview` / `work_intake_start`)
- `production-product-routes.js` — `work_intake_preview` / `work_intake_start`. `runtime.workIntake` 또는 `product.previewAgentWork`/`startAgentWork`. `contextEnvelopeId` 있으면 409 `CONTEXT_ENVELOPE_UNAVAILABLE`
- `phase1-auth-routes.js` — `WorkContextAssembler` + `WorkIntake`. `createPhase1Runtime`에서 각각 **1회**. `new WorkIntake({ pool, contextAssembler: workContextAssembler, durableExecution })`, `product.setWorkIntake(workIntake)`, return에 `workIntake`. 상수 assemble 람다 금지. Calendar AI를 Work Intake 필수로 다시 쓰지 않음
- `durable-execution.js` — `previewWork(scope, input)` hunk만 (escolar `previewWork` 의미: Workspace agent lookup, persist 없음, `{ responsibleAgent, effectiveConfiguration: { snapshotId, executable } }`). 파일 덮어쓰기 금지
- `apps/desktop/src/api/hermesApi.ts` — `previewAgentWork` / `startAgentWork` POST. `createAgentWork` 레거시 경로는 유지하되 `workConversationClient.create`만 preview→start
- `workConversationClient.ts` — `objective`→`goal`, default `workingContext: { kind: 'workspace_general' }`, raw path 필드 없음. UI/composer 변경 없음

이식 금지: `0038`, escolar `context-assembler.js` 전체, escolar `durable-execution.js` 전체, Calendar AI handoff 재작성, Desktop 레이아웃, runner bin dirty, 병렬 3C capacity/cwd 파일(이미 실행 중일 수 있음 — revert 금지).

**UI / no-churn:** 세션 레일 + 대화 + composer 유지. 용량/envelope/설정 벽 없음. `useAgentWorkLiveTurn` mission-keyed는 회귀만. App.tsx handoff 테스트 GREEN 유지.

**First genuine RED (제품 코드 전에 테스트 파일만, 이 순서):**

1. Existence — 아래 `assert_wave3b_files`가 `MISSING`을 찍는다. 없는 파일을 `node --test`에 넣지 않는다 (3A 거짓 GREEN과 같은 구멍).
2. `work-context-assembler.test.cjs` (상수 envelope를 막는 첫 assemble RED):

```js
test('source-empty assemble has empty citations and does not fabricate claims');
test('assemble digest snapshotVersion and citations follow the caller active second_brain snapshot');
test('assemble digest and snapshotVersion change when the active snapshot changes');
test('assemble does not read another user or workspace active snapshot');
```

기대: `../app/lib/work-context-assembler` 없음. fixture는 pool mock: (a) active row 없음 → citations `[]`, version `0`, digest가 고정 문자열이 아님 (같은 empty input이면 결정적). (b) workspace A user A active version 2 + claim `{ id, text, citation, provenance.evidenceHandle }` → 그 handle/label만. (c) version 3으로 바꾸면 digest·snapshotVersion이 다름. (d) workspace B 또는 user B row는 쿼리 params에 안 들어감.

3. `work-intake-http-boundary.test.cjs`:

```js
test('production exposes authenticated Work Intake preview and start routes');
```

기대: `matchProductionRoute('POST', '/api/work-intake/preview')` 가 `null`.

```js
test('createPhase1Runtime composes one WorkIntake and setWorkIntake');
```

기대: `createPhase1Runtime` 소스에 `new WorkIntake` 0회, `new WorkContextAssembler` 0회, `runtime.workIntake` 없음. `product.previewAgentWork` → `work_intake_unavailable`. GREEN 때 assemble 람다/`digest: 'digest-1'` 금지.

```js
test('WorkIntake cannot be composed onto DurableExecution until previewWork exists');
```

기대: `new WorkIntake({ pool, contextAssembler: { assemble }, durableExecution: new DurableExecution({ pool: {} }) })` throw `WorkIntake requires durableExecution preview/start boundary`.

```js
test('unauthenticated Work Intake preview is rejected');
test('Work Intake start stays inside the caller Workspace scope');
test('Work Intake HTTP rejects contextEnvelopeId without a context_envelopes table');
```

4. `work-intake-desktop-client.test.mjs`:

```js
test('Desktop create previews then starts Work Intake and never posts a raw local path');
```

기대: `hermesApi.ts`에 `/api/work-intake/preview` 없음. `create`가 `/api/agent-operations/work`만 친다.

**GREEN 최소:**

- 두 route가 scoped_product/member. client-v1 + `DESKTOP_API_PATHS`와 일치 (`phase10-client-v1-contract` GREEN)
- `createPhase1Runtime`에서 `new WorkIntake` === 1, `new WorkContextAssembler` === 1, `new DurableExecution` === 1 유지
- `previewWork` persist 0. start는 `acceptPreviewedWork`만
- 익명 preview/start 401. 다른 workspace job 0
- `contextEnvelopeId` → 409 `CONTEXT_ENVELOPE_UNAVAILABLE`. `0038` 없음
- `WorkContextAssembler`가 활성 snapshot claim만 citation으로 쓰고, source-empty는 빈 citations. 합성 claim 0
- Desktop create = preview then start. 응답은 기존 `parseAgentWorkCreateResponse`. 새 화면 없음
- 레거시 `POST /api/agent-operations/work`와 Wave 2 handoff GREEN

**Existence gate + narrow commands:**

```bash
assert_wave3b_files() {
  missing=0
  for f in "$@"; do
    if [ ! -f "$f" ]; then echo "MISSING $f"; missing=1; fi
  done
  if [ "$missing" -ne 0 ]; then
    echo "node --test skipped; missing files would false-green"
    return 1
  fi
}
```

RED 0 — 지금 clean에서 실패해야 함:

```bash
assert_wave3b_files \
  apps/backend/app/lib/work-context-assembler.js \
  apps/backend/tests/work-context-assembler.test.cjs \
  apps/backend/tests/work-intake-http-boundary.test.cjs \
  apps/desktop/tests/work-intake-desktop-client.test.mjs
```

RED/GREEN 1 — honest assemble (0037 snapshot, no 0038):

```bash
assert_wave3b_files \
  apps/backend/app/lib/work-context-assembler.js \
  apps/backend/tests/work-context-assembler.test.cjs
node --test --test-concurrency=1 apps/backend/tests/work-context-assembler.test.cjs
```

RED/GREEN 2 — HTTP/auth/compose:

```bash
assert_wave3b_files apps/backend/tests/work-intake-http-boundary.test.cjs
node --test --test-concurrency=1 apps/backend/tests/work-intake-http-boundary.test.cjs
```

RED/GREEN 3 — Desktop client:

```bash
assert_wave3b_files apps/desktop/tests/work-intake-desktop-client.test.mjs
node --test --test-concurrency=1 apps/desktop/tests/work-intake-desktop-client.test.mjs
```

회귀 (있는 파일만):

```bash
assert_wave3b_files \
  apps/backend/tests/work-intake-boundary.test.cjs \
  apps/backend/tests/work-intake-attestation.test.cjs \
  apps/backend/tests/work-intake-pool-boundary.test.cjs \
  apps/backend/tests/phase10-client-v1-contract.test.cjs \
  apps/desktop/tests/calendar-ai-work-handoff.test.mjs \
  apps/desktop/tests/agent-work-live-stream.test.mjs \
  apps/desktop/tests/agent-work-conversation.test.mjs
node --test --test-concurrency=1 \
  apps/backend/tests/work-intake-boundary.test.cjs \
  apps/backend/tests/work-intake-attestation.test.cjs \
  apps/backend/tests/work-intake-pool-boundary.test.cjs \
  apps/backend/tests/phase10-client-v1-contract.test.cjs \
  apps/desktop/tests/calendar-ai-work-handoff.test.mjs \
  apps/desktop/tests/agent-work-live-stream.test.mjs \
  apps/desktop/tests/agent-work-conversation.test.mjs
```

한 묶음 (모든 3B 파일이 생긴 뒤에만):

```bash
assert_wave3b_files \
  apps/backend/app/lib/work-context-assembler.js \
  apps/backend/tests/work-context-assembler.test.cjs \
  apps/backend/tests/work-intake-http-boundary.test.cjs \
  apps/desktop/tests/work-intake-desktop-client.test.mjs \
  apps/backend/app/lib/work-intake.js
node --test --test-concurrency=1 \
  apps/backend/tests/work-context-assembler.test.cjs \
  apps/backend/tests/work-intake-http-boundary.test.cjs \
  apps/desktop/tests/work-intake-desktop-client.test.mjs \
  apps/backend/tests/phase10-client-v1-contract.test.cjs
```

3C 파일(`runner-capacity-boundary`, `execution-loop-work-context`)을 이 3B 명령에 넣지 않는다. 3C는 별도 병렬 Wave다.

**Rollback:** preview/start route, client-v1 op, `WorkContextAssembler` 모듈, `createPhase1Runtime` WorkIntake compose, Desktop preview/start client만 끈다. `0037` second_brain row는 삭제하지 않는다. `createAgentWork` 레거시와 `POST /api/agent-operations/work` 유지. `0038` DROP 없음 (이식하지 않음). `previewWork` hunk revert는 compose를 끈 뒤에만.

**Unresolved risks:**

- Desktop create를 preview→start로 바꾸면 start JSON이 `parseAgentWorkCreateResponse`와 어긋날 수 있다. HTTP start는 acceptWork의 `work`/`conversation`/`message`를 그대로 통과시킨다.
- Calendar AI approve는 아직 레거시 create다. 3B는 그걸 Work Intake 필수로 만들지 않는다. 첫 사용자 `새 작업`만 preview/start를 탄다.
- `previewWork` 없이 compose하면 Railway boot가 죽는다. 3B first RED 3번이 그 순서를 잠근다.
- persisted envelope를 나중에 열면 그때 `0038` + 진짜 stale-envelope RED. 3B assemble은 `0037` active snapshot만 읽고 테이블을 미리 만들지 않는다.
- source-empty를 “빈 이해”로 채우면 첫 사용자 거짓 GREEN이 된다. assembler RED가 citations `[]`를 잠근다.

### Wave 4 — Wiki 환류 정직 (`pending_local`)

**Depends on:** 완료 current result가 있는 제품 (origin/main + Wave 2). **3B/3C와 독립.** 3C Runner cwd를 기다리지 않는다.  
**HEAD evidence (`336a531`):** 아래 파일이 **없다.** `node --test`는 없는 경로를 건너뛴다. Desktop만 돌리면 거짓 GREEN.

| Seam | 관측 |
| --- | --- |
| `localWikiWriter.ts` / `workResultWikiProjection.ts` | 없음. escolar untracked만 |
| `local-wiki-write-boundary.test.mjs` / `work-result-local-wiki-projection.test.mjs` / `work-result-feedback.test.cjs` | 없음 |
| `agent-work-wiki-archive.js` | `wikiRoot` 절대경로로 Gateway가 파일을 씀. 폴더 없으면 `skipped_no_wiki` (내구성 있는 pending 아님). `buildCompletedWorkResultProjection` 없음 |
| `PUBLIC_WIKI_ARCHIVE_STATUSES` / UI | `written` / `skipped_no_wiki` / `failed`. `pending_local` 없음. copy는 “다음 완료부터” |
| Calendar | `projectAgentWorkCalendarState`가 `lifecycleStatus`만 넣음. `workResult`/`workResultId` 없음. `queryRange`도 노출 안 함 |
| Desktop settings / IPC | `wikiVaultPath` / `wiki:choose-vault` / `wiki:apply-work-result-projection` **없음**. `localWikiAsk`는 `LLM_WIKI_VAULT` env |
| `WikiScreen` | `LLM_WIKI_VAULT` 안내 잔존. `로컬 폴더 연결` / pending 한 줄 없음 |
| `0035_agent_work_calendar_terminal_backfill.sql` | 없음. escolar은 기존 `calendar_events` lifecycleStatus **backfill**뿐 |
| `workspace_source_records` | migration 없음. Wave S `SourceLibrary` bootstrap은 `calendar`/`mail`/`file`만. `work_result`는 bootstrap이 아님 |
| `agent_work_current_results` | `0034`에 이미 있음 (mission→current report). 새 테이블 불필요 |

**0035 / 새 migration — EXCLUDE:**

- `0035`는 옛 agent-work 캘린더 row의 `lifecycleStatus` 패치다. 신규 WorkOS 계정은 row가 없고, 새 complete는 `projectAgentWorkCalendarState` hunk로 `workResult`를 넣으면 된다.
- `workspace_source_records` / `0038`은 ContextAssembler 환류 RED가 있을 때만. Wave 4 durable pending은 **mission `wikiArchive` + calendar payload `workResult` + `0034` current report**면 충분하다. Railway에 vault path를 저장하지 않는다.

**Public seams:**

- 완료 + `currentResultReportId`가 가리키는 ready report만 projection. failed/cancelled/stale report → projection `null`, 캘린더에 `workResultId` 없음
- folderless: `wikiArchive.status = 'pending_local'`. `written` 주장 금지. markdown은 잘리지 않은 `finalText` + `work_result_id`
- identity: `workResultId` = `work_result_[a-f0-9]{28}`, `projectionId` = `work-result-wiki:${workResultId}`, `relativePath` = `5_conversation/agent-runs/${workResultId}.md`
- Railway/API는 절대 경로·`wikiRoot`를 받지 않음. 로컬 write는 packaged Electron이 `readSettings().wikiVaultPath`만 사용
- 폴더 연결 후 같은 identity를 `wx`로 1회 write. 같은 digest면 replay. traversal / id mismatch / digest conflict는 throw, pending 유지, 기존 파일 불변
- Workspace/user: snapshot은 scoped. 다른 workspace pending을 hydrate하지 않음
- UI: 기존 Wiki/대화. 새 nav/대시보드/설정 벽 없음. copy: `폴더 미연결 · 보관 대기`, `로컬 폴더 연결`. `LLM_WIKI_VAULT` 사용자 copy 삭제
- Production: signed package + Railway + 신규 계정. Vite를 완료 증거로 쓰지 않음

**Selective port (escolar 읽기 전용):**

| 대상 | 이식 |
| --- | --- |
| create `apps/backend/tests/work-result-feedback.test.cjs` | **앞 2개 unit만** (`buildCompletedWorkResultProjection`, calendar completed-only). 마지막 ContextAssembler/source-record 테스트는 `workspace_source_records`+assembler가 없어 **Wave 4 required GREEN 제외** |
| create `workResultWikiProjection.ts` | escolar 47줄 그대로 가능 (필터만) |
| create `localWikiWriter.ts` | **`saveWorkResultWikiProjection` + path confine.** diary/review/Second Brain writer는 이 Wave RED가 요구할 때만 |
| create `apps/desktop/tests/work-result-local-wiki-projection.test.mjs` | 3개 테스트 중 renderer filter + IPC wiring은 Vite/`dist-electron` 없이 **소스 assert**로 다시 쓴다. writer 함수 테스트는 모듈을 직접 import |
| create `apps/desktop/tests/local-wiki-write-boundary.test.mjs` | work-result confine/`wx`/replay만. diary/review/Second Brain 테스트는 이 Wave 필수 아님 |
| create `apps/desktop/tests/first-user-wiki-pending.test.mjs` | 폴더리스 copy + picker CTA + `pending_local`이 `written`이 아님 |
| hunk `agent-work-wiki-archive.js` | `buildCompletedWorkResultProjection`. folderless는 `pending_local`이지 `skipped_no_wiki`가 아님. **Gateway `writeFile(wikiRoot)` 경로를 새 complete에 쓰지 않음** |
| hunk `public-agent-records.js` | status `pending_local` 허용. 절대경로 필드 금지 |
| hunk `durable-execution.js` `projectAgentWorkCalendarState` | complete일 때만 `workResult` payload. failed/cancelled는 넣지 않음 |
| hunk `unified-calendar.js` `queryRange` | `lifecycleStatus==='completed'`일 때만 `workResultId`/`result`. 잘린 summary만으로 성공 위장 금지 |
| hunk `wikiArchiveStatusLabel` + `AgentWorkConversationView` | `pending_local` → `폴더 미연결 · 보관 대기`. “다음 완료부터” 금지 |
| hunk `settings.ts` / `main.ts` / `preload.ts` / `preload.cts` / `vite-env.d.ts` | `wikiVaultPath` persist, `wiki:choose-vault` (`openDirectory`), `wiki:apply-work-result-projection`. path는 main에만 |
| hunk `App.tsx` | snapshot/calendar에서 `pendingWorkResultWikiProjections` → vault 있으면 apply. hydrate 후 같은 id replay |
| hunk `WikiScreen.tsx` | pending 한 줄 + `로컬 폴더 연결`. `LLM_WIKI_VAULT` 삭제. 새 화면 없음 |

이식 금지: `0035`, `0038`, `context-assembler.js`, escolar `localWikiWriter` 전체 중 Second Brain/diary를 강제하는 UI, runner bin dirty, 3B/3C 파일 revert.

**First genuine RED (제품 코드 전, 이 순서):**

1. Existence — `assert_wave4_files`가 `MISSING`. 없는 파일을 `node --test`에 넣지 않는다.
2. `work-result-feedback.test.cjs`:

```js
test('completed Work projection preserves one current result identity, citations, artifacts, and full Markdown');
```

기대: `buildCompletedWorkResultProjection` export 없음. failed mission / stale reportId → `null`. folderless `wiki.status === 'pending_local'`. markdown에 잘리지 않은 본문 + `work_result_id`.

3. 같은 파일 (calendar, ephemeral postgres **기존** `calendar_events`만):

```js
test('Unified Calendar exposes completed terminal result identity but never projects failed or cancelled as success');
```

기대: `queryRange`에 `workResultId` 없음. **`0035`를 추가해서 통과시키지 않는다.**

4. `work-result-local-wiki-projection.test.mjs`:

```js
test('renderer selects only unique completed Work pending-local Wiki manifests');
test('Desktop routes completed Work Wiki manifests through the trusted Electron writer');
```

기대: 모듈/IPC 문자열 없음. `written`/`active`/비-agent_work는 제외.

5. writer + confine:

```js
test('packaged writer stores one exact completed Work result idempotently');
```

기대: `saveWorkResultWikiProjection` 없음. GREEN 때 `../escape.md` / 잘못된 `projectionId`는 throw, 기존 파일 불변.

6. `first-user-wiki-pending.test.mjs`:

```js
test('folderless workspace keeps pending_local and does not claim wiki written');
test('Wiki folder picker uses main-process directory dialog and never posts a raw path to Railway');
```

기대: UI가 `skipped_no_wiki`/LLM_WIKI_VAULT. `chooseWikiVault` 없음.

**GREEN 최소:**

- 완료 current result만 projection. failed/cancelled는 지식/캘린더 성공으로 안 올라감
- folderless durable `pending_local` (재시작 후 Railway snapshot에 남음). `written`/`skipped_no_wiki` 위장 없음
- 폴더 연결 → 같은 `workResultId`/`projectionId` 1회 write, 재시작 replay
- Railway에 vault path 0. Electron opaque binding만
- traversal/id mismatch/write 실패 → pending 유지, 기존 파일 불변
- Wiki/대화 copy만. 13 nav 유지
- packaged `file://.../app.asar` + Railway에서 신규 계정 여정 7–8단계

**Existence gate + narrow commands:**

```bash
assert_wave4_files() {
  missing=0
  for f in "$@"; do
    if [ ! -f "$f" ]; then echo "MISSING $f"; missing=1; fi
  done
  if [ "$missing" -ne 0 ]; then
    echo "node --test skipped; missing files would false-green"
    return 1
  fi
}
```

RED 0 — 지금 `336a531`에서 실패해야 함:

```bash
assert_wave4_files \
  apps/backend/app/lib/agent-work-wiki-archive.js \
  apps/backend/tests/work-result-feedback.test.cjs \
  apps/desktop/src/features/knowledge/workResultWikiProjection.ts \
  apps/desktop/electron/localWikiWriter.ts \
  apps/desktop/tests/work-result-local-wiki-projection.test.mjs \
  apps/desktop/tests/local-wiki-write-boundary.test.mjs \
  apps/desktop/tests/first-user-wiki-pending.test.mjs
```

(`agent-work-wiki-archive.js`는 존재. 나머지 MISSING이 RED 0.)

RED/GREEN 1 — backend projection:

```bash
assert_wave4_files \
  apps/backend/tests/work-result-feedback.test.cjs \
  apps/backend/app/lib/agent-work-wiki-archive.js
node --test --test-concurrency=1 --test-name-pattern='completed Work projection|never projects failed' \
  apps/backend/tests/work-result-feedback.test.cjs
```

RED/GREEN 2 — Desktop filter + IPC:

```bash
assert_wave4_files \
  apps/desktop/tests/work-result-local-wiki-projection.test.mjs \
  apps/desktop/src/features/knowledge/workResultWikiProjection.ts
node --test --test-concurrency=1 apps/desktop/tests/work-result-local-wiki-projection.test.mjs
```

RED/GREEN 3 — writer confine:

```bash
assert_wave4_files \
  apps/desktop/tests/local-wiki-write-boundary.test.mjs \
  apps/desktop/electron/localWikiWriter.ts
node --test --test-concurrency=1 --test-name-pattern='completed Work result|exact completed' \
  apps/desktop/tests/local-wiki-write-boundary.test.mjs
```

RED/GREEN 4 — folderless honesty + picker:

```bash
assert_wave4_files apps/desktop/tests/first-user-wiki-pending.test.mjs
node --test --test-concurrency=1 apps/desktop/tests/first-user-wiki-pending.test.mjs
```

회귀 (있는 파일만):

```bash
assert_wave4_files \
  apps/backend/tests/agent-work-wiki-archive.test.cjs \
  apps/desktop/tests/agent-work-wiki-archive-presentation.test.mjs \
  apps/desktop/tests/calendar-intelligence-release-a5.test.mjs \
  apps/desktop/tests/onboarding-readiness.test.mjs
node --test --test-concurrency=1 \
  apps/backend/tests/agent-work-wiki-archive.test.cjs \
  apps/desktop/tests/agent-work-wiki-archive-presentation.test.mjs \
  apps/desktop/tests/calendar-intelligence-release-a5.test.mjs \
  apps/desktop/tests/onboarding-readiness.test.mjs
```

한 묶음 (모든 4 파일이 생긴 뒤에만). ContextAssembler 테스트와 `0035`를 넣지 않는다.

**Rollback:** Desktop apply IPC + vault picker + `pending_local` projection hunk만 끈다. mission/calendar에 남은 `pending_local`은 유지 (DROP/`0035` 없음). 레거시 `skipped_no_wiki` 읽기는 깨지 않음. runner bin dirty 미터치.

**Production acceptance:** signed package + Railway + 신규 WorkOS. 폴더 없이 완료 → 대화/캘린더에 잘리지 않은 결과 + `폴더 미연결 · 보관 대기`. 폴더 연결 → 같은 `workResultId` 파일. 앱/Gateway 재시작 후 pending 또는 written replay. Vite 금지.

**Unresolved risks:**

- 기존 `skipped_no_wiki` 미션은 pending으로 재작성하지 않음. 신규 complete만 `pending_local`.
- escolar writer 테스트가 `dist-electron`을 요구하면 소스 import로 다시 쓴다. 빌드 artifact를 GREEN 증거로 쓰지 않는다.
- Gateway `writeDelegatedWorkArchive(wikiRoot)`를 남겨 두면 Railway가 경로를 원할 수 있다. 새 complete는 그 경로를 타지 않게 한다.
- `workspace_source_records` 없이 Second Brain이 work_result를 bootstrap하면 Wave S 계약을 깬다. 4에서 adapter를 넣지 않는다.

### Wave 5 — Packaged 13-nav smoke (Vite는 증거가 아님)

**Depends on:** Wave G + S + 2 Desktop seams GREEN. 3B/3C/4는 있으면 같이 돌리되, 이 Wave가 제품을 구현하지 않는다.  
**증거 경계:** `npm run dev:desktop` / `electron:dev` / `run-playwright-with-vite.cjs` / `VITE_DEV_SERVER_URL`은 **로컬 회귀일 뿐**이며 Wave 6/7 PASS로 인용 금지. `verify:first-user-journey:injected`와 `test:desktop-release-smoke`의 `FIXTURE_EVIDENCE.liveProduction=false`를 그대로 따른다.

**2026-08-16 파일 실측 (`3774531`):**

| 경로 | 상태 |
| --- | --- |
| `playwright-first-user-journey.cjs` | 있음. injected AuthKit. **live WorkOS 아님** |
| `playwright-calendar-crud.cjs` / `playwright-agent-work-workspace.cjs` | 있음. 다수 Vite runner |
| `playwright-*-surface-buttons.cjs` (calendar/mail/diary/next7-kanban/agent/chat) | 있음 |
| `playwright-second-brain-onboarding.cjs` | **없음** (옛 Wave 5가 나열 → 거짓 GREEN) |
| `playwright-first-user-folderless.cjs` | **없음** |
| `playwright-release-c-existing-surface-integration.cjs` | **없음** |
| `packaged-deep-link-smoke.cjs` | 있음. `AGENT_CALENDAR_PACKAGED_APP_PATH` 또는 `apps/desktop/release/mac-arm64/Agent Calendar.app` |
| `run-desktop-release-smoke.cjs` | 있음. fixture only |
| 13 nav `NAV_GROUPS` | `calendar`, `agents`, `automation`, `today`, `next7`, `tasks`, `mail`, `kanban`, `wiki`, `review`, `diary`, `runner`, `widgets` |

**Public seams:** packaged `Contents/MacOS/Agent Calendar` + `app.asar/dist/index.html`. 13 nav 선택, empty/error/loading, 디자인 토큰. 새 홈/대시보드 없음.

**Files (create):**

- `apps/desktop/tests/playwright-first-user-folderless.cjs` — packaged only (`AGENT_CALENDAR_PACKAGED_APP_PATH` 없으면 exit 2, Vite fallback 금지)
- `apps/desktop/tests/playwright-first-user-13nav.cjs` — 13 id를 순서대로 열고 `data-screen`/제목/empty copy 촬영
- `docs/qa/first-user-production/2026-08-16/wave5-packaged-smoke.json` (실행 시)

**Files (modify):** 없음 필수. 기존 Vite playwright를 “production PASS”로 인용하는 문장만 이 계획이 금지.

**First genuine RED:**

```bash
assert_wave5_files() {
  missing=0
  for f in "$@"; do
    if [ ! -f "$f" ]; then echo "MISSING $f"; missing=1; fi
  done
  [ "$missing" -eq 0 ] || { echo "node skipped; missing files would false-green"; return 1; }
}
assert_wave5_files \
  apps/desktop/tests/playwright-first-user-folderless.cjs \
  apps/desktop/tests/playwright-first-user-13nav.cjs
```

기대: 두 파일 MISSING.

이어서 패키지 없이:

```bash
AGENT_CALENDAR_PACKAGED_APP_PATH= \
node apps/desktop/tests/playwright-first-user-folderless.cjs
```

기대: exit 2, “packaged app required”. Vite를 켜서 GREEN 만들지 않는다.

**Narrow (파일이 생긴 뒤, 패키지 있을 때만):**

```bash
APP="apps/desktop/release/mac-arm64/Agent Calendar.app"
test -d "$APP" || { echo "MISSING packaged app"; exit 1; }
test -f "$APP/Contents/Resources/app.asar" || exit 1
AGENT_CALENDAR_PACKAGED_APP_PATH="$PWD/$APP" \
  node apps/desktop/tests/playwright-first-user-folderless.cjs
AGENT_CALENDAR_PACKAGED_APP_PATH="$PWD/$APP" \
  node apps/desktop/tests/playwright-first-user-13nav.cjs
AGENT_CALENDAR_PACKAGED_APP_PATH="$PWD/$APP" \
  node apps/desktop/tests/packaged-deep-link-smoke.cjs
```

**Fixture vs live:** 정적 self-test만 fixture를 허용한다. 실제 harness 실행은 stub/injected auth 또는 mock gateway를 금지하고 패키지 앱 + production Railway만 사용한다. Google/WorkOS 신규 계정 수동 체크포인트와 Agent Work 실실행·OAuth 판정은 Wave 7에서 수행한다.

**Rollback:** 테스트 파일만 삭제. 제품 동작 없음.

### Wave 6 — Freeze identity + Railway (승격 전)

**Depends on:** 구현 Wave 1–4 + 3B/3C 모두 GREEN인 **하나의** `SOURCE_SHA`. 한쪽만 GREEN이면 freeze 금지.  
**Vite 금지.** `npm run dev:desktop` 결과를 Railway SHA로 쓰지 않는다.

**Identity 공식 (하나라도 다르면 배포하지 않음):**

```text
SOURCE_SHA=$(git rev-parse HEAD)                    # 40 hex
Railway deployment metadata source SHA == SOURCE_SHA
GET https://hermes-os-production-e174.up.railway.app/api/gateway-status
  → build / sourceSha == SOURCE_SHA
packaged extraMetadata / 앱 표시 build == SOURCE_SHA
shasum -a 256 ".../app.asar" → frozen-identity-receipt.json
codesign --verify --deep --strict ".../Agent Calendar.app"  exit 0
```

**2026-08-16 실측:** 첫 frozen ZIP과 서명된 `.app`은 생성됐지만, 정적 `dmg.contents`가 존재하지 않는 Widget companion을 항상 요구해 DMG만 실패했다. 코어 freeze는 조건부 wrapper로 Widget이 없으면 `absent`를 receipt에 남기고 DMG를 만들며, 공식 릴리스는 서명된 `.appex`가 있을 때만 같은 DMG에 companion을 포함한다. unsigned Widget을 production 증거로 채우지 않는다. `forceCodeSigning: true`, `hardenedRuntime`, `notarize: true`.

**현재 production rollback 기준 (승격 전까지 유지):**

- Git `db44d336280393f6d17c3de2b4e7c1103101d858`
- Railway deployment `8f9af9ba-5097-4a12-88e1-9795d6a21d42`
- gateway `https://hermes-os-production-e174.up.railway.app`

**Files (create):**

- `scripts/first-user-production-freeze.cjs` — SHA 수집, asar hash, codesign, curl health/ready/gateway-status, receipt write. 불일치 exit 1
- `apps/desktop/scripts/electron-builder-mac.cjs` — Widget companion 존재 여부를 검증하고 DMG contents를 조건부 구성
- `apps/desktop/tests/desktop-dmg-widget-optional.test.mjs` — 코어 DMG 생략/공식 릴리스 포함 계약
- `docs/qa/first-user-production/2026-08-16/frozen-identity-receipt.json` (실행 산출)

**Files (modify):** `apps/desktop/package.json`의 source SHA embed와 조건부 macOS builder 연결, freeze receipt의 `widgetCompanion: absent|included`. runner bin dirty 금지.

**Secrets/config (값은 커밋 금지):**

- `CSC_NAME` / Apple notarize (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`)
- Railway CLI 로그인 또는 `RAILWAY_TOKEN`
- `AGENT_CALENDAR_SOURCE_SHA` (freeze 시 HEAD와 같아야 함)

**First RED:**

```bash
assert_wave5_files scripts/first-user-production-freeze.cjs
node scripts/first-user-production-freeze.cjs --check
```

기대: 스크립트 없음, 또는 extraMetadata/gateway SHA 불일치.

**Narrow:**

```bash
npm run backend:check
npm run typecheck
npm --workspace apps/desktop run dist:mac
codesign --verify --deep --strict "apps/desktop/release/mac-arm64/Agent Calendar.app"
node scripts/first-user-production-freeze.cjs --write \
  --app "apps/desktop/release/mac-arm64/Agent Calendar.app" \
  --gateway "https://hermes-os-production-e174.up.railway.app"
# freeze PASS 후에만 Railway deploy of SOURCE_SHA
curl -fsS "$GW/api/health"
curl -fsS "$GW/api/ready"
curl -fsS "$GW/api/gateway-status"
# /api/operations/status 는 operations_private. 운영 토큰 있을 때만. 없으면 EXTERNAL_BLOCKED
```

`/api/ready`가 200이 아니면 **가짜 200으로 바꾸지 않음.** 필요한 production operations 설정을 끝내거나 freeze를 `EXTERNAL_BLOCKED`로 남긴다.

**Rollback:** Railway traffic를 `e211f10` / `409f4bde-37da-486c-8ce9-1d1583520c48`에 둔다. 새 DMG를 배포하지 않음. `scripts/railway-release-gate.cjs` rollback 경로 사용.

### Wave 6B — 실제 Google 인증 코드 callback 복구

**2026-08-16 production 증거:** Google 인증은 성공해 Gateway callback에 73자 `code`와 `state`가 모두 도착했지만, 실제 code의 `4/…` 형식에 포함된 `/`를 Gateway와 Desktop의 공통 정규식이 거부했다. code 원문은 로그·receipt에 남기지 않고 길이, slash 포함 여부, 기존 규칙 일치 여부만 진단했다.

**경계:** OAuth `code`와 `state`를 분리 검증한다. code는 Google이 발급하는 bounded `4/…` 형식을 허용하지만 state는 기존 strict 문자 집합을 유지한다. exact host/path, code+state 두 키, 중복/미지/credential/port/hash 거부 계약은 그대로다. Login, Calendar, Gmail deep link 세 경로가 같은 code 계약을 사용한다.

**First RED:** 실제 모양의 `code=4%2F0Acv-…`가 `google-auth-callback-bridge`와 `parseAgentCalendarAuthCallbackDeepLink`에서 거부되는 것을 재현한다.

**Acceptance:**

- `apps/backend/tests/google-auth-callback-bridge.test.cjs` — real-shaped code 전달, state slash/중복/미지 파라미터 거부
- `apps/desktop/tests/agent-calendar-deep-link.test.mjs` — Login/Calendar code slash 허용, state slash 거부
- `apps/desktop/tests/google-mail-oauth.test.mjs` — Gmail code slash 허용, state slash 거부
- production Railway + 같은 SHA packaged app에서 신규 사용자가 로그인 완료 후 sidebar에 진입

**Rollback:** 새 callback 커밋을 승격하지 않고 현재 `e211f10` deployment를 유지한다. 다만 `e211f10`은 실제 Google code를 거부하므로 로그인 검증 PASS 후보로 재사용하지 않는다.

### Wave 7 — Live production QA (코드 수정 없는 dispatch)

**Depends on:** Wave 6 identity receipt PASS. receipt 없이 시작 금지.  
**Vite 금지.** 패키지 앱만. injected AuthKit / fake engine / `verify:first-user-journey:injected` / `test:desktop-release-smoke`는 **참고 아님.**

**수동 OAuth checkpoint (자동화 금지):**

자동화는 WorkOS 사용자나 Google Cloud test user를 **만들지 못한다.** 운영자가 패키지 앱에서 직접:

1. 신규 WorkOS 가입 (Google identity 또는 magic link). 기존 production 계정 재사용 금지(empty 증거).
2. Google Cloud에서 그 Gmail을 Calendar+Gmail **테스트 사용자**로 추가 (값은 문서에 적지 않음).
3. 체크포인트 로그: `docs/qa/first-user-production/2026-08-16/manual-oauth-checkpoint.json` `{ operator, createdAt, workosUserCreated: true, googleTestUserAdded: true, accountEmailHash }` — 이메일 원문 금지.

이 파일이 없으면 Wave 7는 `EXTERNAL_BLOCKED`, succeeded로 위장하지 않음.

**Accounts / profiles:**

| ID | 역할 |
| --- | --- |
| A empty | 신규 WorkOS. 일정/메일/Wiki/작업 0 |
| B rich | 기존 production. empty 증거 금지 |
| P-folderless | A, 로컬 폴더 없음 |
| P-folder | 같은 기기 다른 userData 또는 이후 같은 세션에서 폴더 연결 |

**파괴 최소화 순서:**

1. Read-only: `/api/health`, `/api/ready`, `/api/gateway-status` (Wave 6 receipt와 비교)
2. 패키지 콜드 스타트 + 로그인 (수동)
3. 13 nav empty/loading (쓰기 없음)
4. Calendar connect → sync → CRUD 1건 → **나중에 revoke**
5. Gmail connect (Calendar와 별도) → empty/list → revoke/retry. Calendar 세션이 꺼지면 FAIL
6. `폴더 없이 계속` + Second Brain `source_required` 또는 캘린더 초안
7. Calendar AI 질문 → delegate_work 승인 → agents 해당 대화
8. **복잡한 Work 2개 이상** (조사 문서 + 일정 근거 정리). capacity 2 overlap. composer 개입 메시지. **하나만 중단**, 다른 쪽 running 유지. 원문 잘림 없음
9. 앱 / Gateway(가능하면 재기동 금지, 대신 클라이언트 reconnect) / Runner restart 복구
10. 폴더 연결 → 같은 `workResultId` write
11. source-rich B는 회귀만 (브리핑 카드 없음, 13 nav)
12. 운영 Runner revoke는 `NOT_CLICKED`. disposable enrollment만 제거

**Files (create, QA 산출만):**

```
docs/qa/first-user-production/2026-08-16/
  frozen-identity-receipt.json      # Wave 6
  manual-oauth-checkpoint.json
  verdict.json                      # 컨트롤별 PASS|HONEST_DISABLED|EXTERNAL_BLOCKED|NOT_CLICKED|FAIL
  screenshots/{nav}-{state}.png     # 13 nav × empty|data|error
  logs/packaged-main.redacted.log
  work/{missionId}-full-result.md   # 잘리지 않은 본문
```

**Files (modify):** 제품 코드 없음. FAIL만 별 fix Task.

**판정 / hard FAIL:**

- Vite/dev URL이 증거에 포함
- SHA triple 불일치
- empty 계정에 합성 일정/메일/Wiki/에이전트
- Calendar+Gmail 한 번 consent
- 한쪽 revoke가 로그인/다른 Google을 끊음
- interrupt-one이 다른 Work를 멈춤
- 완료 본문 잘림 / pending을 written으로 표시
- 14번째 nav / 새 대시보드 / `SecondBrainCalendarBriefing` on calendar
- `/api/ready` 실패를 200으로 위장
- 버튼 무반응

**13 nav 최소 체크 (각각 screenshot):**

| id | empty | error/loading | 금지 |
| --- | --- | --- | --- |
| calendar | 외부 캘린더 없음, 그리드 | 배너 재시도 | 브리핑 카드 |
| agents | 새 작업 composer | Runner 없으면 honest disabled | 엔진 콘솔 |
| automation | 합성 0 | 담당 미활성 문구 | 활성화 전 실행 |
| today / next7 / tasks / kanban | 기존 empty | 기존 | AI 요약 카드 |
| mail | Google 메일 읽기 전용 + 연결 | 준비 중입니다 금지 | 통합 consent |
| wiki | 로컬 미연결 + pending 한 줄 | 질문 실패 정직 | LLM_WIKI_VAULT |
| review / diary | 기존 입력 | 가짜 저장 금지 | |
| runner | 등록 CTA | 오프라인 정직 | 운영 revoke |
| widgets | 미리보기 | 내부 실행 버튼 없음 | |

위 표 + 기존 All-Button matrix가 Wave 7 전부다. 컨트롤마다 `verdict.json` 한 행: `{ id, screen, action, expected, actual, artifact, judge }`.

**복잡한 Work (live only):**

- Work 1: “이번 주 캘린더에서 중요한 일을 한 장으로”
- Work 2: “그 결과를 근거와 함께 다시 정리” (병렬, capacity 2)
- 진행 중 추가 지시 1회
- Work 2만 중단 → Work 1 heartbeat/complete 유지
- 재시작 후 두 세션 + 잘리지 않은 결과

**Secrets (이름만):** `WORKOS_*`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, Calendar/Gmail test-user 콘솔, Runner enroll code. 계획/receipt에 값 금지.

**Narrow:** 로컬 Vite 없음. 운영자 체크리스트는 이 절 + matrix. `npm run verify:staging-clean-account`는 staging preflight일 뿐 live empty 증거가 아님.

**Rollback:** 승격 전이면 `d86a1ae` / `180de29c-…` 유지. QA FAIL는 새 SHA fix. 연결된 Google/WorkOS를 QA가 삭제하지 않음.

## Implementation Checklist

- [x] Step 0: `origin/main` 기반 clean worktree `first-user-production` 존재. dirty archive는 `escolar`.
- [x] Step 1a: Wave 1 onboarding skip/copy GREEN (`bda4a7c`).
- [ ] Step 1b: Wave 0 기준선 명령을 돌리고 3 RED를 로그에 남긴다. 제품 코드 금지.
- [ ] Step 1c: Wave 0R — `WORKOS_CONFIG_MISSING` 테스트 재조준, live-stream `handoffGraph.handoffs` fixture, worker-strip `deliverable.kind` fixture.
- [ ] Step 2: Wave G first RED `first-user-gmail-connect.test.mjs` (가이드 CTA + `mailConnected` backend truth).
- [ ] Step 3: Wave G authorize/callback/`0036`/mailOAuth/MailScreen connector GREEN.
- [ ] Step 4: Wave S first RED source-empty `work_result` 비합성.
- [ ] Step 5: Wave S `source_required → collecting → review → active` + onboarding step GREEN. A5 briefing import 계속 금지.
- [ ] Step 6: Wave 2 Calendar AI approve → agents mission handoff RED then GREEN.
- [x] Step 7a: Wave 3A attested Work Intake library GREEN (`46f802c`).
- [ ] Step 7b: Wave 3B HTTP preview/start compose RED then GREEN (`work-context-assembler` + `work-intake-http-boundary` + Desktop client). `0038` 없음.
- [ ] Step 7c: Wave 3C Runner cwd/capacity/interrupt (3A 이후 3B와 독립 병렬). 배포는 3B+3C 모두 GREEN.
- [ ] Step 8: Wave 4 folderless `pending_local` + local write-once RED then GREEN. `0035` 없음.
- [ ] Step 9: Agent 1차 copy `새 작업`, 엔진 비노출. 관련 design/create-readiness 테스트 GREEN.
- [ ] Step 10: `npm run backend:check` && focused backend tests.
- [ ] Step 11: `npm run typecheck` && `npm --workspace apps/desktop run test`.
- [ ] Step 12: `npm run test:runner` && `npm run build:desktop`.
- [ ] Step 13: `npm test`.
- [ ] Step 14: Wave 5 packaged 13-nav/folderless 스크립트. Vite를 PASS로 쓰지 않음.
- [ ] Step 15: Wave 6 freeze identity (`first-user-production-freeze.cjs`) + signed `.app` + Railway SHA triple. 불일치면 승격 금지.
- [ ] Step 16: Wave 7 수동 OAuth checkpoint 후 신규 empty 계정 매트릭스 + 복잡한 Work 2개 + interrupt-one + 재시작.
- [ ] Step 17: 실패 항목만 fix Task. QA dispatch는 코드를 고치지 않는다. rollback `d86a1ae` / `180de29c-…`.

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
| Google 메일 연결 | Wave G: `onConnectMail` → `window.hermesDesktop.connectGoogleMail()` → `/api/mail/google/authorize`. Calendar IPC 금지. `mailConnected`는 `inbox.connector === 'connected'`일 때만 true |
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
  - [ ] Wave 0R 3개 기존 테스트가 원인별로 실패하는 것을 로그에 남긴다
  - [ ] Wave G `first-user-gmail-connect` / authorize route가 예상 이유로 실패
  - [ ] Wave S source-empty `work_result` 비합성이 예상 이유로 실패
  - [ ] Wave 3B `work-intake-http-boundary` / Desktop preview-start client가 예상 이유로 실패
  - [ ] Wave 4 `pending_local` / writer confine / folder picker가 예상 이유로 실패
  - [ ] Wave 2–4의 명시 테스트가 예상 이유로 실패
- GREEN:
  - [x] Wave 1 skip/copy (`bda4a7c`)
  - [ ] 같은 테스트가 최소 구현으로 통과
  - [ ] A0/A5/navigation/Calendar CRUD가 계속 GREEN
- REFACTOR:
  - [ ] green 범위에서 copy 중복만 정리. App.tsx 분할은 이 계획 밖
- Boundary:
  - [ ] Calendar AI approve ↔ Work Intake ↔ Desktop parser
  - [ ] OnboardingGuide mail CTA ↔ `mail:google-connect` ↔ `/api/mail/google/*` ↔ `mail_connections` ↔ `inbox.connector` ↔ `mailConnected`
  - [ ] Second Brain run ↔ SourceLibrary allowed origins ↔ `source_required` UI
  - [ ] pending_local ↔ localWikiWriter ↔ hydrate
- Production:
  - [ ] Wave 6 SHA triple receipt (Vite 아님)
  - [ ] 수동 OAuth checkpoint 파일
  - [ ] 신규 계정 여정 10단계 + 복잡한 Work 2개
  - [ ] 버튼 matrix `verdict.json` FAIL 0

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
- [ ] Wave 0R: `login-authkit-copy` + `login-failure-message` + `agent-work-live-stream` + `agent-worker-strip` GREEN
- [ ] Wave G: OnboardingGuide `data-testid="onboarding-action-mail"`이 `onConnectMail`을 호출하고 Calendar IPC를 호출하지 않는다
- [ ] Wave G: `mailConnected === true`는 hydrate `inbox.connector === 'connected'`일 때만. skip/local flag/합성 inbox로 true가 되지 않는다
- [ ] Wave G: MailScreen `not_linked` CTA가 `connectGoogleMail`을 열고 `준비 중입니다`를 보여 주지 않는다
- [ ] Wave S: 허용 origin(`calendar`/`mail`/`file`) 0 + work_result만 있으면 `source_required`, inference 0
- [ ] Wave S: skip/`폴더 없이 계속`가 Second Brain run 또는 source row를 만들지 않는다
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
- `VITE_SECOND_BRAIN_V1=0` / 서버 flag off: Wave 1 가이드(calendar/wiki/mail/calendar_ai/runner + skip)와 기존 Calendar AI로 후퇴. `second_brain` step만 숨긴다. 연결된 source row는 삭제하지 않음.
- Gmail 문제: mail route/IPC만 끄기. Calendar grant와 로그인 유지.
- Work Intake 문제: Calendar AI → Work 전환만 끄고 기존 Agent create/history/Runner enrollment 유지.
- Wiki writer 문제: pending_local 유지, Diary/Review/Second Brain 초기 writer는 유지.
- migration: additive only. rollback은 flag/route disable이지 DROP이 아님.
- 새 SHA QA 실패 시 traffic을 새 배포에 남기지 않는다.

## Remaining Risks

- Risk: 신규 WorkOS 계정이 다시 없으면 empty 게이트가 NOT RUN이 된다.
  - Mitigation: QA 시작 전 coordinator가 계정을 만든다. 없으면 succeeded로 위장하지 않고 external-blocked로 남긴다.
- Risk: 이 worktree의 runner bin dirty 또는 다른 작업자 hunk를 실수로 revert/재포맷한다.
  - Mitigation: 이 계획은 이 파일만 수정한다. 구현 Wave도 ownership 밖 hunk 금지, Wave 전후 `git diff --stat`.
- Risk: `escolar` Gmail/Second Brain 파일을 통째로 복사하면 Wave 1 skip 계약과 origin/main 이후 수정을 덮는다.
  - Mitigation: 각 Wave RED가 요구하는 hunk만 이식. `0f8bee3`/uncommitted 파일은 읽기 전용 참고.
- Risk: Calendar AI approve가 missionId를 Desktop에 안 내려주면 handoff가 실패한다.
  - Mitigation: Wave 2 backend 응답 contract를 먼저 RED로 고정.
- Risk: Gmail Restricted가 테스트 사용자 밖에서 실패.
  - Mitigation: 정직한 오류 + Calendar 단독 경로로 첫 가치 유지.
- Risk: C12 이후 dirty 지능이 Railway에 부분 배포되면 SHA drift가 재발한다 (A6/B5 원인).
  - Mitigation: identity receipt 없이 QA 시작 금지.
- Risk: `폴더 없이 계속`가 Second Brain 합성으로 오용됨.
  - Mitigation: skip flag는 wiki ready만, run은 허용 origin inventory > 0일 때만. Wave S first RED가 work_result 비합성을 잠근다.
- Risk: Wave 1이 mail CTA를 숨긴 채 skip만 남겨 “메일은 나중에”가 연결 성공으로 오인됨.
  - Mitigation: Wave G acceptance gate — CTA는 실제 authorize, `mailConnected`는 `connector === 'connected'`만.

## Verification Notes

- Command: `git rev-parse HEAD` / `git merge-base --is-ancestor d86a1ae HEAD`
  - Result: implementation `bda4a7c` (Wave 1). origin/main `d86a1ae` ancestor.
- Command: Wave 1 vs origin/main
  - Result: 7 files. onboarding skip/copy + MailScreen consent copy + 이 계획. Gmail route/IPC/Second Brain 없음.
- Command: `node --test --test-concurrency=1 apps/desktop/tests/login-authkit-copy.test.mjs apps/desktop/tests/agent-work-live-stream.test.mjs apps/desktop/tests/agent-worker-strip.test.mjs`
  - Result: 3 RED 재현. `WORKOS_CONFIG_MISSING`는 `auth.ts` 문자열 가정. live-stream은 `handoffGraph.handoffs` 부재. worker-strip은 `mission.deliverable.kind` 부재.
- Command: escolar 읽기 전용 조사
  - Result: `0f8bee3` + uncommitted `mailOAuth.ts`/`0036`–`0038`/`second-brain.js`/`source-library.js`. 파일 전체 복사 지시 없음.
- Command: 제품 코드 변경
  - Result: 이 계획 보완에서 없음. runner dirty hunk 미터치.
- Status: In progress 유지.
