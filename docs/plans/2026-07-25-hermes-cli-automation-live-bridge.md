# Plan: Installed Hermes CLI Automation Live Bridge

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Complete

## Goal

사용자 Runner에 이미 설치되고 인증된 Hermes를 별도 앱이나 별도 loopback API 설정 없이
Agent Calendar의 Connected Automation source로 사용한다. 조회·생성·수정·일시정지·
재개·즉시 실행은 요청 Workspace의 정확한 Runner가 `hermes cron` CLI로 수행하고,
Gateway에는 공개 automation metadata만 전달한다.

Provider mutation 직후 Runner/Gateway/network가 끊겨도 같은 Hermes 작업을 조용히
중복 실행하지 않는다. 결과를 전달하지 못한 경우에는 로컬 journal과 Gateway request
lease로 정확히 replay하거나 `SOURCE_OUTCOME_UNKNOWN`을 표시한다.

## Non-goals

- Hermes credential, config, prompt 원문 파일, script, workdir를 Gateway로 전송하지 않는다.
- Hermes가 지원하지 않는 delete 또는 provider-global idempotency를 발명하지 않는다.
- Claude/Codex/Grok automation capability를 추정하지 않는다.
- Mobile을 시작하지 않는다.
- 운영 사용자의 기존 Hermes job을 수정하거나 삭제하지 않는다.

## Touched boundaries

- Runner:
  - installed `hermes cron` CLI connector
  - installed Hermes HTTP API contract correction
  - mutation restart journal and terminal replay
  - private atomic Runner state persistence
- Backend:
  - stale running connector request lease/reclaim
  - sparse CLI metadata synchronization
- Tests:
  - CLI argv/output parser, replay, uncertain outcome
  - real PostgreSQL same-Workspace reclaim/isolation
  - live installed Hermes job lifecycle
- Docs:
  - Phase 7 correction and evidence

## Success criteria

- [x] URL 설정이 없으면 Runner가 `hermes cron list --all`을 사용한다.
- [x] create/edit/pause/resume/run이 현재 설치된 Hermes CLI argv 계약과 일치한다.
- [x] 새 automation은 Agent Calendar 정책대로 비활성 상태로 생성되고 Hermes에서도
      즉시 pause된다.
- [x] delivery는 항상 `local`이며 script/workdir/secret metadata는 Gateway로 가지 않는다.
- [x] 명시적 loopback HTTP 모드는 설치본의 `/api/jobs`, `PATCH`, `/run` 계약을 사용한다.
- [x] CLI list가 제공하지 않는 goal/agent assignment는 sync에서 기존 값을 지우지 않는다.
- [x] provider 성공 결과는 Gateway 완료보다 먼저 Runner local journal에 기록된다.
- [x] 완료 전 단절 후 같은 request는 provider를 재실행하지 않고 결과를 replay한다.
- [x] provider 결과가 불명확한 started journal은 재실행하지 않고
      `SOURCE_OUTCOME_UNKNOWN`으로 종료한다.
- [x] stale `running` request는 동일 Workspace/Runner에게만 lease되어 복구된다.
- [x] 실제 설치된 Hermes에서 임시 job의 create/list/edit/pause/resume/run을 관찰하고
      exact id만 정리한다.

## Edge cases

- `hermes` executable 없음: `CONNECTOR_AUTOMATION_NOT_CONFIGURED`.
- CLI timeout/non-zero after mutation start: 결과를 추정하지 않고
  `SOURCE_OUTCOME_UNKNOWN`.
- completion transport failure: provider 성공을 failure로 덮지 않고 journal replay.
- 다른 request가 unfinished local journal과 충돌: provider 실행 금지.
- 다른 Workspace/Runner가 stale request를 열거 또는 완료: 0건/404.
- malformed/ANSI/oversized CLI output: 공개 parser가 fail-closed.
- HTTP mode가 명시된 경우 CLI로 조용히 fallback하지 않는다.

## Test plan

1. RED: CLI list/create/edit/action argv와 공개 parser.
2. RED: result-before-complete journal, completion replay, uncertain started recovery.
3. RED: real PostgreSQL stale running reclaim와 foreign Runner isolation.
4. RED: sparse CLI sync가 goal/agent assignment를 보존.
5. GREEN: 최소 구현 후 같은 focused tests.
6. REFACTOR: HTTP/CLI mode가 동일 public result contract를 공유.

## Acceptance gates

- [x] `node --test apps/runner/tests/provider-connectors.test.cjs`
- [x] `node --test apps/runner/tests/runner-client.test.cjs`
- [x] `node --test apps/backend/tests/phase7-automation-federation.test.cjs`
- [x] `npm run backend:check`
- [x] `npm --workspace apps/runner run check`
- [x] `npm run typecheck`
- [x] `npm test`
- [x] 실제 installed Hermes live lifecycle

## Rollback / fallback

- 명시적 loopback URL이 있으면 corrected HTTP mode를 계속 사용할 수 있다.
- CLI capability가 없으면 source는 unavailable이며 공용 Gateway credential로 fallback하지
  않는다.
- journal이 불명확하면 자동 재실행 대신 사용자에게 결과 확인/재동기화를 요구한다.
- live ETE는 고유 이름의 exact created job id만 `hermes cron remove`로 정리한다.

## Checklist

- [x] Step 1: 설치된 Hermes CLI/API와 기존 Connector 불일치를 감사한다.
- [x] Step 2: CLI/durability/reclaim/sparse-sync RED tests를 추가한다.
- [x] Step 3: Runner CLI connector와 corrected HTTP contract를 구현한다.
- [x] Step 4: mutation journal과 Gateway stale-running reclaim을 구현한다.
- [x] Step 5: focused/full regression을 통과시킨다.
- [x] Step 6: live installed Hermes lifecycle을 관찰하고 evidence를 기록한다.

## Remaining risks

- Hermes CLI human-readable output은 버전별로 바뀔 수 있다. parser fixture와 live gate를
  함께 유지한다.
- provider-global idempotency가 없으므로 provider 성공과 local journal 기록 사이의
  process kill은 결과가 불명확하다. 이 구간은 중복 실행하지 않고 unknown으로 끝낸다.
- 설치된 Hermes 버전의 `cron run`은 Gateway status가 stopped여도 즉시 실행 결과를
  기록했다. live 검증용 작업은 최소 prompt와 장기 schedule을 사용하고 종료 직후 exact
  id로 삭제했다.
