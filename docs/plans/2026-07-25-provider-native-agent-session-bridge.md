# Plan: Provider-native Agent Session Bridge

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: In progress — interruption continuity and single-account live Codex verified;
  strict two-account provider identity gate open

## 2026-07-25 completion correction

기존 `Complete`와 live ETE 표시는 최종 완료 증거로 사용할 수 없다.

- 두 계정 ETE는 서로 다른 Workspace/Runner identity를 만들었지만 같은 호스트의
  기본 `CODEX_HOME`과 provider credential/profile을 공유할 수 있었다. 따라서
  “각 사용자의 Runner 로컬 provider identity” 격리를 증명하지 못했다.
- 새 provider session id는 Adapter terminal result에서만 Gateway에 반영됐다.
  provider가 session을 만든 뒤 Runner/Gateway/network가 끊기면 mapping이 비어 있는
  상태로 재시도되어 조용히 새 provider session을 만들 수 있었다.
- 기존 Electron ETE의 AuthKit은 injected test Adapter였다. 제품 흐름 검증에는
  유효하지만 실제 production identity/provider credential 릴리스 증거는 아니다.

이 계획은 위 결함을 닫고 서로 분리된 Runner provider home으로 실제 continuity를
다시 관찰할 때까지 완료가 아니다. 기존 자동화 테스트와 screenshot은 회귀 증거로만
유지한다.

## 2026-07-25 strict identity preflight correction

서로 다른 `CODEX_HOME` 경로만 확인하는 release gate도 충분하지 않다. 같은 Codex
계정을 두 디렉터리에 각각 로그인하면 파일과 경로는 달라도 provider identity는
같을 수 있다. strict two-account ETE는 실행 전에 각 provider home의 로컬
credential에서 account identity를 메모리 안에서만 파생해 비교하고 다음을
fail-closed로 강제한다.

- 두 provider home의 canonical path와 credential 파일은 서로 달라야 한다.
- 두 credential이 모두 유효한 account identity를 제공해야 한다.
- account identity digest가 서로 달라야 한다.
- raw account id, token, cookie, email 또는 credential 내용은 로그, evidence,
  assertion message, Gateway request에 기록하지 않는다.
- 같은 identity이거나 identity를 검증할 수 없으면 실제 provider 명령을 실행하기
  전에 ETE를 중단한다.

## Goal

사용자가 Claude, Codex, Grok, Hermes 앱을 따로 열지 않고 Agent Calendar의 Agent Work
Control Space 안에서 실제 provider 에이전트와 장기적으로 일하게 한다.

Workspace의 Runner가 사용자 동의 아래 로컬 agent/profile/session 공개 메타데이터를
조회하고, Agent Calendar의 Work Conversation 하나를 실제 provider session 하나와
1:1로 연결한다. 후속 지시는 같은 provider session으로 전달되고, 앱·Gateway·Runner
재시작과 네트워크 단절 이후에도 대화, 실행 증거, 결과물, Calendar projection이
복구되어야 한다.

## Non-Goals

- Provider OAuth, API key, cookie, CLI credential 또는 원문 로컬 설정을 Gateway로
  업로드하거나 저장하지 않는다.
- Argo의 회사/크루 명칭이나 시각 자산을 그대로 복제하지 않는다.
- Provider가 지원하지 않는 agent catalog 또는 session 기능을 있는 것처럼 만들지
  않는다. 불가능한 기능은 정확한 상태와 수동 reference fallback을 표시한다.
- Personal Memory와 provider session history를 합치지 않는다.
- Mobile을 시작하지 않는다. Mobile은 Desktop/Web production gate 이후 마지막
  단계다.
- 자동으로 만료된 provider session을 새 session으로 바꾸지 않는다.

## Touched Boundaries

- Backend gateway:
  - Workspace-scoped agent catalog request/import
  - Agent provider session list/create/resume/rename/archive
  - Work Conversation follow-up execution
- Backend library:
  - `ProviderAgentBridge` module과 public metadata/secret validation
  - Durable Execution의 provider session lease/terminal 계약
  - Workspace isolation 및 exact Runner selection
- DB/migrations:
  - provider session mapping, connector request, execution turn identity
  - Workspace composite FK, FORCE RLS, app/device least privilege
- Runner:
  - 동의 기반 local catalog/session connector
  - Codex/Claude/Grok/Hermes create/resume adapter
  - provider session 상태/error normalization
- React UI:
  - agent별 기본 Runner/Execution Engine
  - catalog 조회/미리보기/가져오기
  - agent별 session rail, 새 session, 재개, 제목 변경, 검색, 보관
  - provider session 상태, Work Checkpoint, artifact, Calendar 상태
- Contracts and tests:
  - Backend/Runner hostile Workspace isolation
  - adapter argv/session continuity
  - Desktop UI behavior and real Electron ETE
- Docs:
  - 이 계획, ETE 증거, rollback 기록

## Deep-module design

외부 seam은 `ProviderAgentBridge` 하나로 둔다.

- Interface:
  - `requestCatalog(scope, runnerId, provider)`
  - `importAgent(scope, catalogEntry, defaults)`
  - `createSession(scope, agentId, title)`
  - `enqueueTurn(scope, providerSessionId, message)`
  - `transitionSession(scope, providerSessionId, action)`
- Implementation:
  - same-Workspace Runner 선택/검증
  - connector request lifecycle
  - public metadata projection과 secret rejection
  - provider session ↔ Work Conversation 1:1 mapping
  - durable execution job/attempt/event/artifact 연결
  - provider-specific error를 공통 상태로 정규화

Runner 내부에는 provider별 Adapter seam을 둔다. Gateway 호출자는 provider별 파일
경로나 CLI 출력 형식을 알지 않는다.

- Codex:
  - custom agent metadata는 `$CODEX_HOME/agents/*.toml`
  - resume는 현재 CLI의 parent 옵션 순서를 지켜
    `codex exec -C <cwd> --json --sandbox workspace-write resume <SESSION_ID> -`
- Claude:
  - custom agent metadata는 user/project `.claude/agents/*.md`
  - resume는 `claude -p --resume <SESSION_ID> --output-format stream-json`
- Hermes:
  - profiles는 `hermes profile list/show`
  - sessions는 `hermes sessions list`와 `hermes --resume <SESSION_ID>`
- Grok:
  - agent profile과 local session metadata를 capability가 허용할 때 조회
  - resume는 `grok --resume <SESSION_ID>`와 headless output

CLI 출력 전체는 Gateway로 보내지 않는다. ID, 표시 이름, 설명, provider, 수정 시각,
capability/status처럼 allowlist된 공개 메타데이터만 보낸다.

## Persisted contract

- `provider_agent_sessions`
  - Workspace, agent, Runner, engine/provider, external agent id
  - Work Conversation id와 external provider session id의 1:1 mapping
  - title/status/last activity/public metadata/error code
- `runner_connector_requests`
  - Workspace와 정확한 Runner에 묶인 catalog/session control request
  - allowlist request/response와 terminal 상태
- `execution_jobs`
  - 하나의 Delegated Work 안에서 여러 turn을 허용
  - 각 turn이 같은 provider session mapping을 참조
- 기존 `agent_session_events`, `execution_events`, `execution_artifacts`,
  `agent_reports`, `calendar_events`
  - user/agent message, plan, tool/checkpoint, approval, error, artifact, result,
    revision과 Calendar projection의 내구성 있는 source of truth

## Success Criteria

- [x] 에이전트별 기본 Execution Engine과 same-Workspace Runner를 저장·수정한다.
- [x] Runner를 통해 Hermes/Codex/Claude의 기존 agent/profile을 조회·미리보기·
      가져오기 한다.
- [x] catalog API가 없는 provider는 동의된 Runner local connector를 사용하고,
      불가능할 때만 수동 reference를 fallback으로 제공한다.
- [x] Work Conversation 하나와 실제 provider session 하나가 1:1이며 후속 메시지가
      같은 external session id로 전달된다.
- [x] 에이전트별 session 목록, 새 session, 재개, 제목 변경, 검색, 보관이 동작한다.
- [x] 전체 채팅, 계획, tool 실행, Work Checkpoint, 승인, 오류, artifact, 결과,
      수정 차수가 durable storage에서 복구된다.
- [x] 앱/Gateway/Runner 재시작과 네트워크 단절 후 같은 mapping과 대화를 복구한다.
- [x] provider session 만료/삭제/인증 만료를 구분하고 명시적 새 session 선택 전에는
      다른 session을 만들지 않는다.
- [ ] Workspace A/B의 catalog, agent id, session id, 대화, artifact, Runner 상태가
      상호 노출되지 않는다.
      자동 hostile isolation과 서로 다른 Runner provider-home contract는 통과했지만,
      서로 독립적으로 인증된 실제 provider home 두 개를 사용한 Electron ETE가 남았다.
- [x] 예정/진행/완료/재작업 상태가 Unified Calendar에서 확인된다.
- [x] credential/token/cookie/path 원문이 Gateway DB, logs, evidence, response에 없다.

## Edge Cases

- Runner offline:
  - catalog/session 요청은 `runner_offline`, 실행은 `waiting_runner`로 유지한다.
- Engine auth expired:
  - `auth_required`로 terminal 처리하고 session mapping은 보존한다.
- External session missing/deleted:
  - `session_missing` 또는 `session_deleted`; 자동 새 session 금지.
- Quota exhausted:
  - `quota_exhausted`; retryable=false, mapping 보존.
- Foreign Runner/agent/session id:
  - 404 또는 scoped conflict이며 존재 여부/상태를 노출하지 않는다.
- Duplicate import/session mapping:
  - same-Workspace idempotent replay만 허용하고 다른 Work Conversation과 중복 연결은
    거부한다.
- Network interruption after provider accepted turn:
  - idempotency key와 external session id로 terminal replay를 수용하고 중복 Calendar
    결과를 만들지 않는다.
- Provider lacks rename/archive:
  - Agent Calendar의 표시 제목/보관 상태만 갱신하고 provider sync capability를
    정확히 표시한다.
- Malicious connector output:
  - 크기 제한, allowlist projection, provider secret/path pattern reject.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] User/Workspace A/B catalog request/import hostile isolation
  - [x] agent default Runner/engine foreign-id rejection
  - [x] provider session mapping 1:1 uniqueness와 restart reload
  - [x] initial turn이 provider session id를 저장하고 follow-up lease가 같은 id를 전달
  - [x] missing/auth/quota 오류에서 implicit new session 또는 cross-Runner fallback 0회
  - [x] Codex/Claude/Grok/Hermes resume argv와 session-id capture
  - [x] connector output secret/path stripping
  - [x] full history/artifact/calendar state restore
  - [x] Desktop catalog import/session rail/search/rename/archive/status UI
  - [x] provider session-start checkpoint 직후 terminal 이전 단절에서 같은 external
        session id로 재시도되는 test
  - [x] Runner A/B가 서로 다른 `CODEX_HOME`의 catalog/session만 읽고 상대 profile을
        열거하지 못하는 test
  - [x] 서로 다른 경로라도 같은 provider account identity이면 strict ETE가 provider
        실행 전에 거부하고 raw identity를 출력하지 않는 test
- GREEN:
  - [x] 최소 DB contract와 `ProviderAgentBridge`
  - [x] 최소 Runner connector/adapter continuity
  - [x] 최소 Desktop Agent Work session UX
- REFACTOR:
  - [x] provider별 parsing을 Runner Adapter 내부로 제한
  - [x] 중복 public projection과 error normalization 정리

## Acceptance Gates

- [x] `node --test apps/backend/tests/provider-agent-session-bridge.test.cjs`
- [x] `node --test apps/backend/tests/phase3-durable-execution.test.cjs`
- [x] `node --test apps/runner/tests/provider-connectors.test.cjs`
- [x] `node --test apps/runner/tests/engine-adapters.test.cjs`
- [x] Desktop focused contract/UI tests
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm --workspace apps/runner run check`
- [x] `npm --workspace apps/runner run test`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [ ] 실제 Electron two-account provider ETE

## Required live ETE

- [ ] production WorkOS clean account 로그인
- [x] 해당 계정 Runner 등록/연결
- [x] 실제 provider engine 인증
- [x] 기존 Codex agent catalog 조회와 하나 가져오기
- [x] 기존 Codex session 가져오기와 재개
- [x] Work Conversation에서 메시지 전송
- [x] 같은 provider session의 streaming, 안전한 tool/Work Checkpoint, artifact 관찰
- [x] 후속 지시가 같은 external session id로 전달됨을 확인
- [x] 앱 종료 및 재접속
- [x] 동일 session/chat/work/artifact/calendar 결과 복구
- [ ] 두 계정 각각 수행하고 상호 격리 확인

위 체크는 실제 로컬 Codex CLI와 실제 Runner/Gateway/Electron 표면의 단일 계정
관찰 결과다. 로그인만 injected AuthKit test adapter이므로 production identity
릴리스 증거로 사용하지 않는다.

## Rollback / Fallback

- 신규 migration은 기존 agent directory와 단일-turn execution row를 삭제하거나
  재해석하지 않는다.
- feature flag가 내려가면 catalog/session control routes를 숨기고 기존 manual
  reference directory와 새 Delegated Work만 유지한다.
- provider connector가 실패하면 수동 reference 입력만 제공하되, 실제 session 연속
  실행이 불가능한 상태를 `manual_reference_only`로 표시한다.
- terminal mapping과 history를 삭제하지 않고 신규 turn 생성을 중단할 수 있어야 한다.

## Implementation Checklist

- [x] Step 1: 기존 directory/Work Conversation/Durable Execution/Runner adapter를 감사하고
      설치된 CLI의 catalog/resume capability를 확인한다.
- [x] Step 2: 기존 Argo 계획을 directory slice로 바로잡고 이 Large/Boundary 계획을
      작성한다.
- [x] Step 3: DB/interface/Workspace isolation RED tests를 작성한다.
- [x] Step 4: Runner local catalog connector RED tests와 구현을 진행한다.
- [x] Step 5: provider session create/resume/error continuity RED tests와 구현을 진행한다.
- [x] Step 6: Desktop session rail/catalog import/status UX를 TDD로 구현한다.
- [x] Step 7: 집중 gate와 전체 회귀를 통과시킨다.
- [ ] Step 8: 실제 two-account provider ETE와 재시작 복구를 관찰한다.
- [x] Step 9: provider session-start identity를 terminal 이전에 durable mapping으로
      고정하고 단절 재시도를 검증한다.
- [ ] Step 10: 각 Runner의 provider home을 명시적으로 분리한 hostile isolation ETE를
      통과시킨다.
- [x] Step 11: strict ETE가 provider account identity 자체의 차이를 검증하고 같은
      계정의 중복 로그인을 독립 사용자 증거로 인정하지 않게 한다.

## Verification Notes

- 2026-07-25 corrective verification:
  - Codex/Claude Adapter는 provider가 새 session identity를 내보내는 첫 checkpoint에서
    Runner 로컬 active-attempt state에 저장한 뒤 terminal completion보다 먼저
    same-Workspace Runner device route로 durable mapping을 고정한다.
  - Runner가 bind 응답 이전 또는 직후 중단되면 다음 시작에서 로컬로 캡처한 mapping을
    먼저 replay하고, 성공한 뒤에만 다음 offer를 조회한다.
  - binding은 Workspace + Runner + provider-session row lock으로 제한되며 다른
    Workspace/Runner는 404, 이미 연결된 다른 external id는 409다.
  - provider connector와 CLI child process는 Runner별 `CODEX_HOME`,
    `CLAUDE_CONFIG_DIR`, `HOME` 환경을 사용한다.
  - 실제 단일 계정 Codex Electron ETE에서 catalog/session import, 같은 session
    follow-up, 실제 shell tool checkpoint, artifact, Desktop/Gateway restart rehydration을
    관찰했다. raw command, host path, credential은 durable event에 저장되지 않았다.
  - `client-v1` closed Desktop surface 이후 동일 live Codex Electron ETE를 다시 실행해
    101,338ms에 통과했다. Agent catalog/session route는 이제 112-operation manifest와
    reverse drift gate 안에 있으며 manifest 밖 제품 route는 explicit client-v1에서
    handler 실행 전 거부된다.
  - strict two-account live ETE는 서로 독립적으로 인증된
    `AGENT_CALENDAR_E2E_CODEX_HOME_A/B`가 없으면 시작 자체를 거부한다.
  - strict preflight는 canonical provider home과 local account identity digest를 모두
    비교한다. 현재 발견된 두 로그인 홈은 서로 다른 파일이지만 같은 account
    identity이므로 `PROVIDER_IDENTITIES_NOT_DISTINCT`로 provider 실행 전에 거부됐다.
    raw identity와 credential은 출력하거나 evidence에 기록하지 않았다.
- Prior regression evidence (not final release evidence):
  - `provider_agent_sessions`가 Work Conversation, agent, Runner, provider external session을
    Workspace 안에서 1:1로 유지한다.
  - Work Conversation 후속 지시는 저장된 external session id로 enqueue되고,
    Codex resume 실행과 재시작 복구에서 같은 id를 사용했다.
  - catalog/session connector는 Runner 로컬에서만 profile/session 메타데이터를 읽고
    allowlist된 공개 필드만 Gateway로 반환한다.
  - Desktop에서 provider agent 가져오기, session 가져오기/새로 만들기/재개/검색/
    이름 변경/보관, streaming checkpoint, artifact, 오류 상태를 확인했다.
  - Workspace A/B의 Agent Calendar row 격리는 관찰했지만 두 Runner의 local
    `CODEX_HOME`은 분리되지 않아 provider identity 격리 완료 증거로는 부족했다.
- Installed CLI contract:
  - Codex: `codex exec resume [SESSION_ID] [PROMPT] --json`
  - Claude: `--resume`, `--session-id`, `--agent`, `--output-format stream-json`
  - Hermes: `profile list/show`, `sessions list/rename/export/delete`,
    `--resume SESSION`
  - Grok: `--agent`, `sessions list/search/delete`, `--resume SESSION`,
    `streaming-json`

## Remaining Risks

- Codex에는 machine-readable session list 명령이 없어 local session metadata reader의
  format drift test가 필요하다.
- Claude custom agent와 background agent session은 서로 다른 개념이므로 catalog
  projection에서 source kind를 구분해야 한다.
- Agent Calendar로 기존 provider session을 연결할 때 기존 provider의 과거 transcript를
  역수입하지는 않는다. 연결 이후의 Work Conversation 기록부터 내구성 있게 소유한다.
- Hermes 현재 adapter의 classic CLI stdin은 resume streaming schema가 제한적이므로
  batch evidence를 정직하게 표시해야 한다.
- Hermes/Grok은 새 session id를 안정적으로 내보내는 machine-readable 실행 stream이
  확인되지 않은 상태에서는 새 session continuity를 지원한다고 표시할 수 없다.
  기존 session resume와 batch 결과만 limited capability로 유지한다.
- Grok 계정은 현재 quota exhausted 상태여서 성공 ETE는 잔액/권한 변경 전까지
  통과할 수 없으며 failure-state continuity만 검증 가능하다.
- 이번 live provider ETE는 Codex로 통과했다. Claude/Hermes/Grok의 실계정 성공 ETE는
  각 사용자 Runner에 해당 CLI 인증이 준비될 때 provider별 release matrix로 추가한다.
