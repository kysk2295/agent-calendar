# Plan: 캘린더 중심 개인 지능 구체 구현 로드맵

- Date: 2026-08-02
- Owner: Codex
- Work size: Large / Boundary
- Status: Draft
- Product PRD: `docs/PRD-agent-calendar-second-brain.md`
- Direction plan: `docs/plans/2026-08-02-second-brain-product-reframe.md`
- Grok/Codex delivery plan: `docs/plans/2026-08-02-grok-codex-calendar-intelligence-delivery.md`

## Goal

현재 Desktop UI와 캘린더 중심 정보구조를 유지한 채, 첫 로그인 사용자가 허용한 실제
원본을 바탕으로 출처가 있는 사용자 이해 초안을 받고, 캘린더와 Calendar AI에서 같은
맥락의 작업을 시작하며, 에이전트 결과가 다시 캘린더·Wiki·기억에 반영되는 수직 루프를
구현한다.

첫 production 완료 단위는 다음 한 문장으로 검증한다.

> 실제 빈 계정으로 로그인한 사용자가 파일·일정·메일 중 하나 이상을 연결하고,
> 세컨드 브레인 초안을 검토한 뒤, Calendar AI에 요청한 폴더 없는 작업 하나를 실제
> Runner에서 완료하고, 결과가 기존 캘린더·작업 대화·LLM Wiki에 남은 것을 앱 재시작 후
> 다시 본다.

## Work Size

`Large / Boundary`다. Backend gateway, DB contract, Electron bridge, Desktop UI, Runner,
production Railway 검증을 모두 건드리며 기존 API·persisted meaning·실행 payload의 양쪽을
함께 바꾼다. 따라서 한 번에 출시하지 않고 아래 Wave별 additive contract와 feature flag로
전환한다.

## Confirmed Product Decisions

- 첫 고객은 AI를 쓰는 1인 사업가, 창업자, 프리랜서, 크리에이터다.
- Calendar AI는 세컨드 브레인의 기본 대화 상대다.
- LLM Wiki는 검색 탭이 아니라 원본과 구조화 지식의 장기 지식층이다.
- 캘린더는 기본 진입점이자 사용자 이해, 일정, 작업, 자동화, 보고가 만나는 제품 중심이다.
- 기존 navigation, layout, interaction pattern과 design token을 보존하고 각 화면을 제자리에서
  업그레이드한다.
- 사용자 화면에서는 `위임 작업` 대신 `작업`, `새 작업`, `작업 대화`를 사용한다.
- 코딩은 한 작업 유형이며 폴더 없는 일반 업무를 기본 지원한다.
- Codex·Claude 공식 앱과의 완전한 양방향 동기화는 목표가 아니다.
- 원본 기록은 자동 보관한다. 자동 생성된 이해는 출처와 수정·제외 수단을 제공한다.
- 에이전트와 루틴 초안은 자동으로 만들 수 있지만 사용자 활성화 전에는 외부 행동이나
  반복 실행을 시작하지 않는다.
- 실제 제품 검증은 로컬 개발 서버가 아니라 패키지 Electron, Railway production,
  실제 사용자 Runner에서 수행한다.

## Non-Goals

- 전체 Mac 디스크를 동의 없이 탐색하지 않는다.
- 모든 source 원문을 한 저장소에 복제하지 않는다.
- 기존 Calendar, Knowledge v2, Agent Work, Automation 데이터를 새 테이블로 일괄 복사하지
  않는다.
- 첫 수직 슬라이스에 에이전트 회의, handoff, 엔진 비교, Telegram, Mobile을 넣지 않는다.
- 모델이 사용자 성격, 관계, 목표를 근거 없이 추정하도록 허용하지 않는다.
- onboarding 애니메이션이나 가짜 퍼센트로 실제 처리처럼 보이게 하지 않는다.
- 이번 문서 작업에서는 제품 코드를 수정하지 않는다.
- 현재 Desktop을 새 홈, 새 navigation, 별도 Second Brain shell로 전면 재설계하지 않는다.
- 기존 `에이전트` 화면과 별도로 top-level `AI 작업실` 화면을 만들지 않는다.

## Touched Boundaries

- Backend gateway: Second Brain route, Work preview/start contract, client-v1 manifest
- Backend library: Source Library, Second Brain, Context Assembler, Work Intake, Routine Planner
- DB/migrations: source registry, run/snapshot/claim/provenance, Context Envelope
- Electron bridge: 사용자가 허용한 로컬 source와 working-context handle
- Desktop app: 기존 시작 가이드, 캘린더, 오늘, 메일함, 에이전트, 자동화, Wiki의 점진적
  업그레이드와 결과 환류
- Runner: folderless/local-folder 실행, context payload, bounded concurrency, interrupt/recovery
- Contracts and tests: backend/desktop/Runner unit·boundary·Playwright 시나리오
- Railway production: 실제 OAuth, Gateway, DB, 패키지 Electron, 실제 사용자 Runner
- Specs and plans: 권위 PRD와 본 실행 로드맵

## Success Criteria

- [ ] source가 있는 빈 계정은 실제 run stage와 count를 거쳐 출처 있는 초안을 받는다.
- [ ] source가 없는 계정은 합성 프로필이나 가짜 진행 상태 대신 연결 선택지를 받는다.
- [ ] 모든 retained claim은 원본 evidence 또는 명시적 `user_confirmed` provenance를 가진다.
- [ ] 사용자의 확인·수정·제외가 새 snapshot version과 다음 답변·작업에 반영된다.
- [ ] Calendar AI 대화가 같은 Context Envelope로 폴더 없는 실제 Work를 시작한다.
- [ ] 명시적 폴더 Work는 허용된 로컬 경로 안에서만 실행된다.
- [ ] Responsible Agent profile과 허용 맥락이 모든 execution job에 적용된다.
- [ ] 진행·중단·재시도·병렬 실행·재시작 복구가 Work별로 격리되어 동작한다.
- [ ] 완료 결과와 사용자 수정은 출처를 보존한 Source Record로 Wiki에 환류된다.
- [ ] 에이전트·루틴 초안은 사용자 활성화 전 실행되지 않는다.
- [ ] 기존 navigation과 캘린더 생성·수정·탐색 interaction이 그대로 동작한다.
- [ ] 캘린더에서 관련 작업을 시작하고 완료 결과를 다시 캘린더에서 확인한다.
- [ ] 실제 패키지 Electron + Railway production + 실제 Runner의 clean-account 여정이
      blocker, false completion, 민감정보 노출 없이 끝난다.

## Edge Cases

- 허용 source가 0개면 bootstrap을 `source_required`로 끝내고 직접 입력·연결 UI를 보인다.
- source 일부가 실패하면 성공·실패 count와 재시도 대상을 보존하며 성공분을 과장하지 않는다.
- 충돌하는 claim은 최신 값을 조용히 선택하지 않고 두 출처와 확인 필요 상태를 남긴다.
- source revoke/delete 시 새 Context Envelope에서 즉시 제외하고 active snapshot을 stale로
  표시한다.
- 분석 중 앱·Gateway·Runner가 재시작되면 마지막 durable checkpoint부터 복구한다.
- Runner offline이면 기존 지식은 읽되 로컬 분석·실행은 queued/unavailable로 정직하게
  표시한다.
- stale Work preview, snapshot version 충돌, foreign Workspace direct id는 fail closed한다.
- 실패·취소 결과는 성공 지식이나 active memory로 승격하지 않는다.
- capability 1 Runner에서는 병렬 요청을 queued로 표시하고 실제 동시 실행을 위조하지 않는다.
- Gmail·Calendar·로컬 절대 경로·credential은 public payload, log, citation에 노출하지 않는다.

## Test Plan

각 행동은 좁은 RED를 먼저 실행하고 예상 원인으로 실패한 것을 기록한 다음 최소 GREEN을
구현한다. Wave마다 같은 집중 test를 통과시킨 뒤 양쪽 boundary test와 아래 공통 gate로
넓힌다.

- Backend: source idempotency, provenance, Workspace isolation, revoke, durable recovery
- Desktop: source-empty/source-rich onboarding, review concurrency, restart, 반응형·키보드,
  기존 navigation·캘린더 interaction regression
- Context: deterministic selection, privacy filtering, digest stability, citation coverage
- Work/Runner: preview/start, agent profile, folderless/local-folder, interrupt/retry/concurrency
- Feedback: current completed result만 Wiki 환류, memory 승인·수정·삭제
- Automation: inactive execution 0회, 승인 뒤 exact routine 1회, receipt
- End-to-end: 패키지 Electron에서 실제 Railway/OAuth/Runner를 사용한 clean-account journey

구체적인 RED 파일, 최소 GREEN, Wave별 exit gate는 `Implementation Waves`에, 실제 사용자
절차는 `Manual Acceptance Scenarios`에 정의한다.

## Current Code Baseline

| 현재 Module | 재사용할 책임 | 바꿔야 할 점 |
| --- | --- | --- |
| `apps/backend/app/lib/knowledge-service.js` | Workspace source, 문서 버전, 색인, evidence, revoke | Calendar·메일·작업 결과를 공통 Source Record로 참조하는 interface 추가 |
| `apps/backend/app/lib/calendar-ai-service.js` | 대화, 개인 기억, 승인 초안, Calendar/Knowledge 조회 | 자체 맥락 조립을 제거하고 공통 Context Assembler 사용 |
| `apps/backend/app/lib/workspace-inference-broker.js` | cloud/Runner inference 선택과 실패 코드 | Second Brain 추출과 요약도 같은 inference 정책으로 실행 |
| `apps/backend/app/lib/durable-execution.js` | durable 작업, lease, retry, interrupt, evidence | Context Envelope와 명시적 작업 위치를 lease에 포함 |
| `apps/backend/app/lib/workspace-scoped-product-service.js` | Agent Work Conversation과 후속 turn | Calendar AI origin과 Work Intake 결과를 보존하는 작은 진입점으로 축소 |
| `apps/backend/app/lib/agent-work-wiki-archive.js` | 완료 결과 Wiki 보관과 기억 후보 | DB/Railway 기준 Source Record와 provenance를 남기는 방식으로 교체 |
| `apps/backend/app/lib/automation-federation.js` | 자동화 source, 변경 승인, 실행 receipt | Second Brain 패턴에서 나온 routine draft를 입력으로 받음 |
| `apps/desktop/src/features/onboarding/**` | Calendar/Runner/Wiki 준비 상태와 파일 추가 | 기존 시작 가이드 안에 실제 사용자 이해 run과 결과 검토 flow 추가 |
| `apps/desktop/electron/localWikiAsk.ts` | 허용된 로컬 Vault 읽기와 경로 안전성 | 선택한 source의 증분 catalog/index adapter로 일반화 |
| `apps/desktop/electron/mailOAuth.ts` | 사용자별 Gmail read-only OAuth | onboarding source coverage와 Context Assembler mail adapter에 연결 |
| `apps/runner/lib/execution-loop.js` | 작업 lease와 실행 engine 호출 | 저장된 working context 사용, bounded concurrency 지원 |

기존 기반을 우회하는 두 번째 Wiki, 두 번째 Agent Work 저장소, 별도 OAuth 경로를 만들지
않는다.

## Deep Module Design

### 1. Source Library Module

사용자가 허용한 원본을 저장 방식과 무관하게 열거하고 증분 동기화한다. 기존
`KnowledgeService`, `UnifiedCalendar`, Gmail read-only connector, Work result 저장소가
내부 adapter가 된다.

외부 Interface:

```ts
type SourceLibrary = {
  list(scope, filter?): Promise<SourceRecordSummary[]>;
  sync(scope, sourceIds, idempotencyKey): Promise<SourceSyncRun>;
  revoke(scope, sourceId): Promise<RevocationResult>;
};
```

Interface 불변 조건:

- `SourceRecordSummary`는 raw token, credential, 절대 로컬 경로를 포함하지 않는다.
- 동일 원본의 재동기화는 새 원본을 만들지 않고 digest/version을 갱신한다.
- revoke는 이후 검색과 새 snapshot에서 즉시 제외하며 과거 audit를 삭제하지 않는다.
- 원문 저장 위치는 adapter 내부 책임이다. caller는 `server_encrypted`, `runner_local`,
  `external_reference`만 안다.

### 2. Second Brain Module

source 수집, 추출, 관계 연결, snapshot 생성, 사용자 검토를 하나의 작은 Interface 뒤에
숨긴다.

외부 Interface:

```ts
type SecondBrain = {
  start(scope, input: BootstrapInput): Promise<{ runId: string }>;
  getRun(scope, runId: string): Promise<BootstrapRun>;
  getCurrent(scope): Promise<SecondBrainSnapshot | null>;
  review(scope, snapshotId: string, input: ReviewInput): Promise<SecondBrainSnapshot>;
};
```

Run 상태:

```text
queued → collecting → indexing → extracting → linking → ready_for_review
       ↘ failed      ↘ failed    ↘ failed     ↘ failed
ready_for_review → active
```

Interface 불변 조건:

- stage는 실제 checkpoint가 저장된 뒤에만 전진한다.
- claim은 source evidence 또는 `user_confirmed` provenance 없이는 생성할 수 없다.
- 모델 출력은 schema validation을 통과한 뒤에만 snapshot에 들어간다.
- review는 expected version을 요구하며 동시에 두 active snapshot을 만들지 않는다.
- source가 없으면 synthetic profile을 만들지 않고 `source_required`로 끝난다.

### 3. Context Assembler Module

Calendar AI, Wiki 질문, 작업 실행, 루틴 실행이 각각 source를 직접 조회하지 않게 하는
핵심 seam이다.

외부 Interface는 하나만 둔다.

```ts
type ContextAssembler = {
  assemble(scope, request: ContextRequest): Promise<ContextEnvelope>;
};
```

`ContextRequest`:

- `purpose`: `calendar_ai | work | wiki_answer | routine`
- `query`: 현재 요청
- 선택 필드: conversation id, work id, agent id, source ids, working context
- `budget`: 최대 source 수, 최대 문자/token, 시간 범위
- `policy`: 허용·거부 source 종류와 민감도

`ContextEnvelope`:

- immutable envelope id와 digest
- active Second Brain Snapshot version
- 선택한 claim, source, memory, Work event, agent profile 참조
- 각 항목의 선택 이유와 citation label
- 제외된 항목 수와 이유
- 실제 prompt blocks와 전체 크기
- 생성 시점과 Workspace

Interface 불변 조건:

- 모든 참조는 같은 Workspace와 현재 사용자의 허용 범위여야 한다.
- 같은 입력·snapshot·source version에는 같은 digest를 만든다.
- raw credential, private path, revoked source는 envelope에 들어가지 않는다.
- caller가 source별 prompt 형식과 검색 방법을 알 필요가 없어야 한다.

### 4. Work Intake Module

Calendar AI 또는 `새 작업` 입력을 기존 에이전트 화면의 실제 Work로 바꾼다. 담당 에이전트 배정,
Context Envelope, working context, effective configuration을 한 번에 고정한다.

외부 Interface:

```ts
type WorkIntake = {
  preview(scope, input: WorkRequest): Promise<WorkPreview>;
  start(scope, input: StartWorkRequest): Promise<StartedWork>;
};
```

Interface 불변 조건:

- `start`는 preview snapshot id를 요구하고 stale preview를 거부한다.
- Work는 `workspace_general` 또는 명시적 `local_folder` working context를 가진다.
- 담당 에이전트가 실제로 저장되고 profile snapshot이 100%의 job에 들어간다.
- 기본 `default` fallback을 배정 성공처럼 표시하지 않는다.
- Calendar AI origin conversation/turn과 Context Envelope id를 Work에 기록한다.

### 5. Routine Planner Module

Second Brain의 반복 패턴을 Automation Federation의 승인 가능한 초안으로 바꾼다.

외부 Interface:

```ts
type RoutinePlanner = {
  propose(scope, snapshotId: string): Promise<RoutineDraft[]>;
  activate(scope, draftId: string, expectedRevision: number): Promise<ActivationResult>;
};
```

초안은 사용자 활성화 전 실행되지 않는다. 실제 실행은 새 scheduler를 만들지 않고 기존
`AutomationFederation` adapter를 사용한다.

## Persisted Contracts

다음 available migration number에 아래 Workspace-owned 테이블을 추가한다. 새 테이블은
모두 composite Workspace FK, RLS, app-role 최소 권한을 가진다.

### `workspace_source_records`

- `id`, `workspace_id`, `owner_user_id`
- `origin_kind`: file, calendar, mail, recording, note, work_result, manual
- `origin_ref`: 기존 canonical row 또는 opaque Runner handle
- `storage_mode`: server_encrypted, runner_local, external_reference
- `title`, `occurred_at`, `content_digest`, `source_version`
- `status`: active, revoked, deleted, error
- `access_policy`, `provenance`, timestamps
- unique `(workspace_id, origin_kind, origin_ref)`

이 테이블은 원문을 복제하지 않는다. 기존 Knowledge version, calendar occurrence, mail
message, Work result를 공통으로 참조하기 위한 registry다.

### `second_brain_runs`

- run id, Workspace/user, idempotency key
- status와 실제 stage
- 선택 source ids와 coverage
- processed/failed/total counts
- result snapshot id
- error code/message와 timestamps

### `second_brain_snapshots`

- snapshot id, Workspace, monotonic version
- status: draft, active, superseded
- 사용자 요약, people/projects/goals/open-loops/routines summary
- source digest, inference provider/model, created/activated timestamps
- Workspace당 active snapshot 하나의 partial unique index

### `second_brain_claims`

- claim id, snapshot id, kind
- subject key/label, predicate, structured value
- confidence와 review status: proposed, confirmed, rejected
- user correction, timestamps

### `second_brain_claim_sources`

- claim id, source record id, evidence handle id
- citation label, source timestamp
- claim-source composite uniqueness

source revoke 시 active snapshot을 조용히 수정하지 않는다. snapshot을 `stale`로 계산해
재분석을 요구하고, 새 Context Envelope에서는 revoked source와 해당 claim을 제외한다.

### `context_envelopes`

- envelope id, Workspace, purpose, active snapshot id/version
- origin conversation/turn/work/agent refs
- source/claim/memory/event refs
- selection reasons, omissions, budget, prompt size
- digest와 created timestamp

Calendar AI context snapshot과 execution job payload는 이 id를 참조한다. 기존 JSONB는
rollback 기간 동안 projection으로 유지하되 새 사실의 source of truth로 사용하지 않는다.

## Product Route Contracts

client-v1 manifest와 production route registry에 다음 route를 추가한다.

- `POST /api/second-brain/runs`
  - source ids, idempotency key를 받아 bootstrap run 생성
- `GET /api/second-brain/runs/:id`
  - 실제 stage, counts, error, draft snapshot projection 반환
- `GET /api/second-brain/current`
  - active snapshot과 stale reason 반환
- `POST /api/second-brain/snapshots/:id/review`
  - confirm/reject/correct operations와 expected version 적용
- `POST /api/agent-operations/work/preview`
  - 사용자용 담당 에이전트, 사용할 맥락, working context 미리보기
- 기존 `POST /api/agent-operations/work`
  - preview snapshot id와 Context Envelope id를 필수화하는 새 contract로 단계 전환

Calendar AI의 기존 chat route는 응답에 다음을 추가한다.

- 사용한 Context Envelope 요약
- source coverage와 citation
- `work_draft`가 있으면 origin conversation/turn과 preview snapshot id

새 generic “모든 context 조회” route는 만들지 않는다. Context Assembler는 내부 Module이며
각 제품 route가 안전한 projection만 반환한다.

## UX Contract

### Existing UI upgrade map

- global shell, sidebar, screen title pattern, spacing/token 체계를 유지한다.
- `캘린더`에는 관련 사용자 맥락, AI 작업 상태, 자동화 occurrence와 완료 보고를 보강한다.
- `오늘`과 `다음 7일`에는 기존 일정 목록을 유지하고 맥락 기반 우선순위·브리핑을 보강한다.
- `메일함`에는 연결 상태와 메일에서 일정·작업·기억으로 이어지는 action을 보강한다.
- `에이전트`에는 새 top-level 화면을 만들지 않고 작업 대화, 진행, 중단, 재시도, 전체 결과를
  완성한다.
- `자동화`에는 routine 제안·승인·실행 receipt를 보강한다.
- `위키`, `일기`, `주간 회고`에는 provenance와 기억 환류를 보강한다.
- `기본함`, `칸반 보드`, `위젯`, `Runner 설정`의 현재 역할과 위치는 유지한다.

### First login

1. 기존 Desktop shell과 navigation을 먼저 유지해 표시하고, 허용된 source가 있으면 기존
   시작 가이드 안에서 bootstrap을 시작한다.
2. source가 없으면 “사용자를 파악 중”이라고 거짓 표시하지 않고 파일·캘린더·메일 연결
   중 하나를 선택하게 한다.
3. run이 시작되면 전체 퍼센트 대신 현재 실제 stage와 처리한 항목 수를 보여준다.
4. 앱 종료 후 다시 열면 같은 run과 checkpoint를 복구한다.
5. 결과 화면은 `나`, `사람`, `프로젝트`, `목표`, `열린 일`, `반복 패턴`, `확인 필요`를
   source citation과 함께 보여준다.
6. 사용자는 항목별 확인, 수정, 제외 후 “내 세컨드 브레인으로 시작”을 누른다.
7. 활성화 뒤 기존 `캘린더` 화면으로 돌아가 첫 브리핑과 Calendar AI 입력을 본다.

### Calendar AI to Work

1. 사용자가 Calendar AI에 “이 자료를 바탕으로 제안서 초안을 만들어줘”라고 말한다.
2. Calendar AI는 설명을 반복해서 요구하지 않고 현재 conversation과 Context Envelope를
   Work draft로 만든다.
3. 사용자는 `작업 시작` 전에 담당 에이전트, 사용할 정보, 결과 형태를 짧게 확인한다.
4. 기술 설정은 숨기고 `고급 설정`에서만 engine/Runner/model을 본다.
5. 시작 후 기존 `에이전트` 화면에서 진행, 추가 지시, 중단, 재시도, 전체 결과를 본다.
6. 완료하면 결과와 source citation이 LLM Wiki에 저장되고 Calendar AI가 즉시 참조한다.

### Agent and routine drafts

- 세컨드 브레인 결과 화면에 최대 3개의 에이전트 초안과 최대 3개의 루틴 제안만 보인다.
- 각 제안은 “왜 필요한가”, “무슨 정보를 쓰는가”, “무엇을 하는가”, “언제 보고하는가”를
  비개발자 언어로 설명한다.
- 사용자가 검토·테스트·활성화하기 전에는 실제 작업이나 반복 실행을 하지 않는다.

## Implementation Waves

각 Wave는 앞 Wave의 production-compatible contract에 의존한다. 한 Wave 안에서도 행동별
RED → GREEN → 동일 test GREEN 순서를 지킨다.

### Wave 0: 계약과 현재 UI 동작 고정

목표: 기존 사용자를 깨뜨리지 않고 새 경로를 추가할 안전선을 만든다.

작업:

- `SECOND_BRAIN_V1` Workspace feature flag와 기존 onboarding fallback 정의
- 현재 Knowledge, Calendar AI, Work, Wiki archive, Automation contract characterization
- 현재 sidebar 순서, screen id, 캘린더 생성·수정·탐색, 주요 버튼과 design token 기준선 고정
- 다음 migration number와 dirty migration 충돌 확인
- public 용어 projection에서 `작업`과 기존 persisted meaning 분리

RED tests:

- `apps/backend/tests/second-brain-contract-characterization.test.cjs`
- `apps/desktop/tests/second-brain-feature-flag.test.mjs`
- 기존 navigation과 캘린더 interaction characterization/visual baseline

Exit gate:

- flag off에서 기존 production payload와 화면이 동일하다.
- 새 contract가 client-v1 manifest 밖에서 호출되면 fail closed한다.

### Wave 1: Source Library와 Second Brain foundation

목표: 실제 source coverage와 provenance를 가진 draft snapshot을 생성한다.

소유 파일:

- 신규 migration
- 신규 `apps/backend/app/lib/second-brain.js`
- 신규 `apps/backend/app/lib/source-library.js`
- `knowledge-service.js`, `unified-calendar.js`, Gmail read adapter
- production route registry/client-v1 contract

RED tests:

- source-rich/source-empty Workspace
- 같은 source 재동기화 idempotency
- claim without evidence hard failure
- foreign Workspace source/claim/run direct-id 404
- revoke 후 Context Envelope 제외와 snapshot stale
- interrupted run restart recovery

최소 GREEN:

- 기존 Knowledge document, Calendar occurrence, Gmail message metadata를 registry로 project
- source ids로 bootstrap 시작
- inference broker를 통한 schema-constrained 추출
- draft snapshot과 claim/evidence 저장
- 실제 stage 조회

Exit gate:

- 세 종류 source 중 최소 두 종류가 포함된 draft를 실제 Railway DB에서 확인한다.
- 모든 claim에 claim-source row가 있다.
- source 원문, credential, 절대 경로가 public response/log/evidence에 없다.

### Wave 2: 기존 시작 가이드와 캘린더의 first-login upgrade

목표: 기존 shell과 navigation을 유지하면서 clean account가 첫 사용자 이해 결과를
검토하고 캘린더로 돌아갈 수 있다.

소유 파일:

- 신규 `apps/desktop/src/features/second-brain/**`
- `apps/desktop/src/features/onboarding/**`
- `apps/desktop/src/App.tsx`의 기존 screen composition과 캘린더 surface
- 필요한 Electron source picker/recording adapter

RED tests:

- source 없음: 분석 중 문구 금지, 연결 선택 표시
- 실제 run: stage와 counts 표시, fake percent 금지
- refresh/restart 후 동일 run 복구
- citation 없는 claim 렌더 거부
- confirm/reject/correct optimistic concurrency
- keyboard, 375/768/1280, light/dark
- sidebar 순서, 기존 screen id, 캘린더 interaction과 핵심 버튼 회귀 없음

Playwright:

- `apps/desktop/tests/playwright-second-brain-onboarding.cjs`
- packaged Electron smoke variant는 local Vite mock을 완료 증거로 인정하지 않는다.

Exit gate:

- 실제 빈 production 계정에서 source 연결부터 active snapshot까지 완료한다.
- 잘못된 항목 수정 후 앱 재시작에도 수정이 유지된다.

### Wave 3: Context Assembler와 Calendar AI

목표: Calendar AI가 일정 전용 검색이 아니라 active 세컨드 브레인을 근거로 답한다.

소유 파일:

- 신규 `apps/backend/app/lib/context-assembler.js`
- `calendar-ai-service.js`
- `knowledge-service.js`
- `calendar_ai_context_snapshots`의 context envelope reference migration

RED tests:

- 목적별 source allow/deny
- 관련성, 최신성, budget에 따른 deterministic selection
- revoked/private/foreign source exclusion
- 같은 입력 digest 안정성
- Calendar AI 답변의 snapshot version/citations/envelope id
- 근거 없는 사용자 claim 생성 금지

최소 GREEN:

- Calendar AI 내부의 직접 memory/knowledge 조회를 Context Assembler 호출로 교체
- 일정, Wiki, Work history, 확인된 기억을 하나의 envelope로 조립
- 응답에 사용 맥락의 안전한 요약과 citation 표시

Exit gate:

- “내가 지금 진행 중인 프로젝트와 이번 주 일정에서 중요한 일을 알려줘” 질문이
  Calendar + Wiki + confirmed claim을 함께 근거로 답한다.
- source 하나를 제외하면 다음 답변과 envelope에서 사라진다.

### Wave 4: 캘린더와 기존 에이전트 화면의 실제 작업 연결

목표: Calendar AI 맥락을 잃지 않고 폴더 없는 실제 작업을 완료한다.

소유 파일:

- 신규 `apps/backend/app/lib/work-intake.js`
- `durable-execution.js`, `workspace-scoped-product-service.js`
- 기존 Agent Work Desktop workspace/conversation
- Runner execution loop와 engine adapters

RED tests:

- preview/start stale snapshot rejection
- Responsible Agent 자동 배정과 assignment reason
- 모든 job의 profile snapshot/context envelope id
- `workspace_general`에서 daemon cwd 비의존
- `local_folder`의 opaque handle/cwd enforcement
- Work별 draft/error/live state 격리
- interrupt/retry/restart restoration
- bounded concurrency 2에서 두 작업 overlap, capacity 1에서는 queued 표시

최소 GREEN:

- Calendar AI action draft에서 Work preview 생성
- agent assignment + Context Envelope + working context 고정
- 전체 최종 텍스트와 artifact 보존
- Runner에 `maxConcurrentWork` capability와 bounded worker pool 도입

Exit gate:

- 실제 폴더 없는 리서치/문서 작업 하나와 폴더 작업 하나를 완료한다.
- 두 작업을 동시에 시작했을 때 Runner가 보고한 capacity 범위에서 실제 시간이 겹친다.
- 한 작업의 composer/live/error 상태가 다른 작업 화면에 나타나지 않는다.

### Wave 5: 보고, Wiki 환류, 장기 기억

목표: 작업 결과와 사용자 수정이 다음 대화와 작업을 개선한다.

소유 파일:

- `agent-work-wiki-archive.js` 대체 경로
- Source Library work-result adapter
- Second Brain review와 agent profile memory
- Wiki Desktop surface

RED tests:

- completed current result만 Source Record 생성
- failed/cancelled result를 성공 지식으로 저장 금지
- result citation과 artifact reference 보존
- 기억 후보는 자동 active 금지
- 사용자 승인/수정/삭제 후 새 profile snapshot 적용

Exit gate:

- 첫 작업 결과를 Calendar AI가 다음 질문에서 source citation과 함께 사용한다.
- 사용자가 거부한 기억은 어떤 새 Context Envelope에도 들어가지 않는다.

### Wave 6: 에이전트와 자동화 루틴

목표: 세컨드 브레인에서 사용자에게 맞는 지속형 작업자와 반복 루틴을 안전하게 만든다.

소유 파일:

- 신규 `apps/backend/app/lib/routine-planner.js`
- Agent builder/directory profile activation
- `automation-federation.js`, Calendar AI action draft
- Second Brain result UI의 agent/routine proposals

RED tests:

- 근거 없는 agent/routine proposal 금지
- 최대 proposal 수와 duplicate suppression
- draft/review/test/activate lifecycle
- inactive routine execution 0회
- 승인된 routine exact source/agent/context 사용
- external delivery Approval Gate

Exit gate:

- 실제 반복 패턴 하나에서 routine draft가 생성된다.
- 사용자가 활성화한 뒤 한 번 실행되고 결과가 Calendar/Work/Wiki에 남는다.
- 비활성 초안과 거부된 초안은 실행되지 않는다.

### Wave 7: Production completion loop

목표: 기능 존재가 아니라 실제 첫 고객 여정을 완료 증거로 만든다.

작업:

- 새 실제 계정과 사용자 자료가 있는 실제 계정 각각 수행
- 실제 Google Calendar, Gmail, 선택 로컬 source, Railway, Runner 사용
- 모든 사용자 노출 버튼 click matrix
- app/Gateway/Runner restart, offline/reconnect, revoke/delete
- source와 Work가 많은 계정 성능 측정
- rollback rehearsal와 feature flag disable

Exit gate:

- 아래 Manual Acceptance Scenarios 전부 통과
- blocker 0건, false completion 0건, 민감정보 노출 0건
- Railway deployment와 packaged build SHA가 증거에 기록됨

## Manual Acceptance Scenarios

### Scenario A: source-rich first login

1. 새 계정 로그인
2. 파일 source, Google Calendar, Gmail 연결
3. 실제 분석 stage와 count 관찰
4. 사람, 프로젝트, 목표, 열린 일과 citation 확인
5. 한 claim 수정, 한 claim 제외, snapshot 활성화
6. 앱 재시작 후 동일 결과 확인

### Scenario B: source-empty honesty

1. 아무 source가 없는 새 계정 로그인
2. 합성 사용자 정보와 가짜 분석 진행이 없는지 확인
3. source 하나 연결 후 같은 onboarding에서 분석 시작

### Scenario C: Calendar AI to folderless Work

1. Calendar AI가 현재 프로젝트와 일정에 답함
2. 같은 대화에서 조사·문서 작성 요청
3. 사용할 context와 Responsible Agent preview
4. 작업 시작, 진행, 추가 지시, 전체 결과 확인
5. 결과가 Wiki와 다음 Calendar AI 답변에 반영됨

### Scenario D: local folder Work

1. 작업에 로컬 폴더 선택
2. 파일 읽기·수정·검증을 지시
3. 다른 경로 접근이 차단되는지 확인
4. 결과 artifact와 변경 파일, 검증 결과 확인

### Scenario E: concurrent Work and interrupt

1. 장시간 작업 두 개를 시작
2. capacity 2 Runner에서 실제 실행 시간이 겹치는지 확인
3. 하나만 중단
4. 다른 작업이 계속 완료되는지 확인
5. 앱 재시작 뒤 두 상태가 정확히 복구되는지 확인

### Scenario F: routine safety

1. 반복 패턴에서 routine draft 생성
2. 미활성 상태에서 scheduled execution 0회 확인
3. 검토·활성화 후 한 번 실행
4. 보고, 실패 상태, Wiki/Calendar 기록 확인

## Automated Verification Gates

각 Wave는 집중 test부터 넓혀 간다.

- Backend syntax: `npm run backend:check`
- Backend tests: `npm run test:backend`
- Desktop typecheck: `npm run typecheck`
- Desktop tests: `npm --workspace apps/desktop run test`
- Runner tests: `npm run test:runner`
- Desktop build: `npm run build:desktop`
- Full suite: `npm test`

Boundary별 추가 gate:

- migration replay from empty DB와 production-like snapshot
- Workspace A/B hostile isolation
- client-v1 manifest/reverse drift
- packaged Electron Playwright/CDP
- Railway production health와 logs
- Runner real engine execution

## Acceptance Gates

- [ ] Wave 0 contract characterization
- [ ] Wave 1 Source Library/Second Brain backend
- [ ] Wave 2 first-login Desktop
- [ ] Wave 3 Context Assembler/Calendar AI
- [ ] Wave 4 Calendar/기존 Agent 화면/Runner concurrency
- [ ] Wave 5 Wiki/memory feedback
- [ ] Wave 6 agent/routine lifecycle
- [ ] Wave 7 production clean-account completion
- [ ] `npm run backend:check`
- [ ] `npm run test:backend`
- [ ] `npm run typecheck`
- [ ] `npm --workspace apps/desktop run test`
- [ ] `npm run test:runner`
- [ ] `npm run build:desktop`
- [ ] `npm test`

건너뛴 gate:

- Gate: 제품 코드 검증
  - Reason: 이 문서는 구현 전 구체 계획이며 아직 제품 코드를 변경하지 않았다.

## Rollback / Fallback

- `SECOND_BRAIN_V1`은 Workspace별로 켠다. flag off는 기존 onboarding/Calendar AI/Agent
  Work를 그대로 유지한다.
- 새 UI projection을 끄면 기존 sidebar, screen composition과 캘린더 interaction으로 즉시
  돌아가며 사용자가 만든 일정·작업·Wiki 데이터는 유지한다.
- 새 schema는 additive migration만 사용한다. 기존 Calendar AI/Knowledge/Work row를
  삭제하거나 의미를 바꾸지 않는다.
- 각 caller는 새 Module로 전환된 뒤에만 기존 직접 조회를 제거한다. 한 caller 안에서 두
  경로 결과를 혼합하지 않는다.
- bootstrap 실패 시 마지막 active snapshot을 유지한다.
- Context Assembler 실패 시 근거 없는 답을 만들지 않고 source별 제한 모드 또는 명시적
  unavailable 상태를 반환한다.
- Work Intake 문제가 생기면 새 Calendar AI → Work 전환만 끄고 기존 Work history와
  execution jobs를 유지한다.
- routine planner를 내려도 draft, approval, receipt를 보존하고 신규 proposal/execution만
  중단한다.
- production rollout 전 migration restore와 feature flag rollback을 실제로 리허설한다.

## Step-by-Step Checklist

- [x] Step 1: 제품 고객, 약속, 핵심 루프를 새 PRD에 확정
- [x] Step 2: 기존 코드 기반과 재사용 seam 감사
- [x] Step 3: Source Library, Second Brain, Context Assembler, Work Intake, Routine Planner
      Interface 설계
- [x] Step 4: persisted contract, route contract, UX contract 정의
- [x] Step 5: 구현 Wave와 실제 acceptance scenario 정의
- [ ] Step 6: Wave 0 RED와 contract characterization
- [ ] Step 7: Wave 1 Source Library/Second Brain 구현
- [ ] Step 8: Wave 2 first-login Desktop 구현
- [ ] Step 9: Wave 3 Context Assembler/Calendar AI 구현
- [ ] Step 10: Wave 4 Calendar/기존 Agent 화면/Runner 구현
- [ ] Step 11: Wave 5 Wiki/memory feedback 구현
- [ ] Step 12: Wave 6 agent/routine 구현
- [ ] Step 13: Wave 7 production completion loop

## Verification Notes

- Current code inspection:
  - Knowledge v2에 source/version/chunk/ingestion/evidence가 이미 존재한다.
  - Calendar AI에 conversation/context snapshot/memory/action draft가 이미 존재한다.
  - Durable Execution과 Work Conversation에 retry/interrupt/provider session 기반이 있다.
  - Automation Federation에 change approval와 receipt가 존재한다.
  - 현재 onboarding은 readiness checklist이며 사용자 이해 run/snapshot이 없다.
- Product-code checks:
  - 이 계획 작성에서는 제품 코드를 변경하지 않았으므로 실행하지 않는다.

## Remaining Risks

- source storage mode의 기본값은 아직 제품 결정이 필요하다. 구현 기본 제안은 기존 dual
  mode를 유지해 로컬 폴더는 `runner_local`, 명시적 업로드만 `server_encrypted`로 두는
  것이다.
- 사용자 이해 추출 품질이 낮으면 첫 경험 전체의 신뢰가 무너진다. claim-level evidence와
  수정 UX를 모델 품질보다 먼저 완성해야 한다.
- 많은 source를 한 번에 분석하면 비용과 시간이 급증한다. 증분 source digest와 snapshot
  reuse가 필수다.
- `WorkspaceScopedProductService`와 `App.tsx`가 이미 크므로 새 기능을 그 안에 직접
  추가하면 locality를 잃는다. 새 deep Module과 feature folder를 강제한다.
- UI 업그레이드가 새 대시보드와 중복 navigation으로 번지면 캘린더 서비스의 정체성과
  기존 사용자의 muscle memory를 동시에 잃는다. 새 기능은 기존 screen의 목적 안에 배치한다.
- 한 Runner의 bounded concurrency는 CPU·메모리·provider rate limit을 소모한다. Runner가
  capacity를 보고하고 Gateway가 그 이상 lease하지 않아야 한다.
- Gmail과 Calendar 원문을 세컨드 브레인에 어느 수준으로 보관할지는 별도 개인정보
  정책과 삭제 semantics가 필요하다.
- 기존 dirty worktree의 Agent Work, Gmail, Wiki 변경과 구현 파일이 겹친다. Wave 착수 전
  현재 변경의 소유권과 baseline SHA를 고정해야 한다.
