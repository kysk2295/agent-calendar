# Plan: 작업 대화에 실행 계획과 산출물을 보이게 한다

- Date: 2026-07-31
- Owner: Codex
- Work size: Boundary (공개 투영 계약 변경이므로 Large로 취급한다)
- Status: Draft — 방향 결정 완료, 구현 대기

## 결정

**소유자 결정(2026-07-30): 에이전트가 일하는 중간 과정을 사용자에게 보여준다.**

[2026-07-30 계획](2026-07-30-false-completion-guard-and-golden-ete.md)에서 제시한 A/B 중
A를 선택했다. 공개 투영이 `plan`과 `artifact`를 사용자에게 전달하도록 바꾼다.

## Goal

Work Conversation이 결과만이 아니라 담당 에이전트의 실행 계획과 산출물도 보여준다. 자격증명,
실행 명령, 로컬 경로는 지금과 똑같이 차단된 상태를 유지한다.

## 배경 — 왜 지금 이 상태인가

[public-work-conversation-event.js:41](../../apps/backend/app/lib/public-work-conversation-event.js)의
`isPublicDisplayEvent`는 `plan`, `progress`, `artifact` 종류를 통째로 제외한다. 그 결과 실제
실행에서 생성된 체크포인트 9건 중 사용자에게 도달하는 것은 `completion` 2건뿐이다. 실행으로
확인한 수치다.

| 위치 | 체크포인트 |
| --- | --- |
| DB (`agent_session_events`) | 9건 — accepted, progress×3, plan, artifact×2, completion×2 |
| 공개 API 응답 | 2건 — completion×2 |
| 화면 | 1개 항목 |

이 제외는 `522aeb2`(2026-07-27)에서 들어왔다. 같은 커밋이 스스로 "Known backend and desktop
validation failures remain to be resolved"라고 적고 있으며, golden ETE가 마지막으로 통과한
2026-07-25 이후다.

한편 [CONTEXT.md](../../CONTEXT.md)의 Work Checkpoint 정의는 "plan, approval request,
progress milestone, blocker, artifact, or result"다. 문서와 구현이 어긋나 있다.

## 유출 방어는 이미 종류 필터와 별개로 존재한다

종류 필터를 푸는 것이 곧 유출을 뜻하지 않는다. 아래 두 층은 그대로 남는다.

- `DANGEROUS_KEY`가 `command`, `path`, `cwd`, `raw`, `credential`, `token`, `secret`,
  `password`, `profile_root`, `reasoning` 등을 키 이름만으로 차단한다.
- `PUBLIC_SESSION_METADATA_KEYS`는 허용 목록이며 `command`와 `path`를 포함하지 않는다.
- 본문은 `publicText`의 리댁션을 거친다 (`password=hunter2` → `password=[REDACTED]`).

`completion`과 `error`는 이미 임의의 Engine 텍스트를 이 경로로 통과시키고 있다. 따라서
`plan`과 `artifact`를 허용하는 것은 **새로운 종류의 위험을 만들지 않고 분량을 늘린다.**
남는 위험은 본문 자유 텍스트다. 아래 Remaining Risks에 적는다.

## 범위 — 무엇을 보이게 하는가

| 종류 | 결정 | 근거 |
| --- | --- | --- |
| `plan` | **보인다** | CONTEXT.md가 Work Checkpoint로 명시한다. |
| `artifact` | **보인다** | CONTEXT.md가 Work Checkpoint로 명시한다. |
| `progress` | **계속 숨긴다** | 실제 생성되는 문구가 `Runner leased attempt 1 with engine fake`처럼 수명주기 잡음이다. CONTEXT.md의 Work Checkpoint _Avoid_ 항목이 "Raw log, heartbeat, status noise"를 명시적으로 배제한다. |
| `tool_activity` | 계속 숨긴다 | 원시 도구 활동. CONTEXT.md가 배제한다. |
| `agent_message` (phase=accepted 등) | 계속 숨긴다 | 수명주기 잡음. |

`progress`를 나중에 보이게 하려면 Engine이 "진행 milestone"과 "수명주기 잡음"을 구분해
표시해야 한다. 그건 Runner 계약 변경이므로 이 계획에 넣지 않는다.

## Non-Goals

- `progress`, `tool_activity`, 수명주기 `agent_message`를 공개하지 않는다.
- 메타데이터 허용 목록과 `DANGEROUS_KEY`를 넓히지 않는다. 오히려 그대로 두는 것이 전제다.
- Runner와 Engine 어댑터가 내보내는 체크포인트 문구를 바꾸지 않는다.
- 타임라인의 시각 디자인을 다시 하지 않는다. 접힘/펼침 구조는 그대로 쓴다.
- Telegram 등 다른 채널의 투영 정책을 이번에 함께 바꾸지 않는다. 같은 함수를 쓰므로 영향
  범위를 반드시 확인하되, 변경은 Work Conversation 기준으로만 판단한다.

## Touched Boundaries

- Backend gateway: 없음
- Backend library: `public-work-conversation-event.js`의 `isPublicDisplayEvent`
- DB/migrations: 없음
- Electron bridge: 없음
- React UI: `AgentWorkTimeline.tsx` — 늘어난 체크포인트의 접힘/펼침 기본값 확인
- Tests: `public-work-conversation-projection.test.cjs`(계약 변경),
  `phase3-durable-execution.test.cjs`, `agent-work-conversation.test.mjs`,
  `playwright-phase3-golden-ete.cjs`
- Docs: 이 계획, 필요하면 `CONTEXT.md`의 Work Checkpoint 문구 정합화

## Success Criteria

- [ ] 실행이 끝난 Work Conversation에서 사용자가 실행 계획과 산출물을 볼 수 있다.
- [ ] 같은 화면에 실행 명령, 로컬 경로, 자격증명이 노출되지 않는다.
- [ ] `progress`와 `tool_activity`는 계속 노출되지 않는다.
- [ ] Telegram 등 같은 투영을 쓰는 채널에서 예상치 못한 노출이 생기지 않는다.
- [ ] `node apps/desktop/tests/playwright-phase3-golden-ete.cjs`가 통과한다.
- [ ] `npm run verify:multi-user-ete`가 통과한다.

## Edge Cases

- 계획 본문에 셸 명령이 그대로 들어 있는 경우: 키 기반 차단이 걸리지 않는다. 본문 리댁션
  범위를 재검토하거나, 계획 본문 길이를 제한한다.
- 산출물 이름이 절대 경로인 경우: 파일명만 남기고 경로를 떨어뜨린다.
- 한 실행이 계획·산출물을 여러 번 내보내는 경우: 접힌 `실행 기록`이 길어진다. 기본 접힘을
  유지한다.
- 과거에 저장된 이벤트: 투영은 읽기 시점에 적용되므로 이전 작업에도 소급 적용된다. 의도한
  동작인지 확인한다.
- 같은 투영을 쓰는 Telegram 배달: 노출 증가가 그대로 전파되는지 확인한다.

## Test Plan

제품 코드보다 테스트를 먼저 쓴다.

- RED: `plan`과 `artifact`가 사용자에게 도달해야 한다는 테스트를 추가해 실패시킨다. 동시에
  `metadata.command`와 `metadata.path`가 그 이벤트에서도 제거된다는 테스트를 추가한다.
- GREEN: `isPublicDisplayEvent`에서 두 종류만 허용한다.
- REFACTOR: 기존 유출 방지 테스트를 계약 변경에 맞게 다시 쓰되, **차단 항목은 줄이지 않는다.**
  `progress`, `tool_activity`, 수명주기 `agent_message` 차단 단언은 그대로 남긴다.

## Acceptance Gates

- [ ] `npm run backend:check`
- [ ] `npm run test:backend`
- [ ] `npm run typecheck`
- [ ] `npm --workspace apps/desktop run test`
- [ ] `npm run test:runner`
- [ ] `node apps/desktop/tests/playwright-phase3-golden-ete.cjs`
- [ ] `npm run verify:multi-user-ete`

## Step-by-step Checklist

1. [ ] `projectPublicDisplayEvent`를 쓰는 모든 호출 지점을 확인한다
       (`workspace-scoped-product-service.js`, `work-conversation-channel-service.js`).
       Work Conversation 외 채널에 미치는 영향을 먼저 적는다.
2. [ ] RED 테스트를 쓴다 — 노출되어야 할 것과 계속 차단되어야 할 것을 한 파일에서 함께 단언한다.
3. [ ] `isPublicDisplayEvent`에 `plan`과 `artifact`를 허용한다.
4. [ ] 산출물 이름에서 경로를 떨어뜨린다.
5. [ ] 데스크톱 타임라인에서 늘어난 항목의 접힘 기본값과 밀도를 확인한다.
6. [ ] golden ETE 단일 계정·두 계정 경로를 모두 통과시킨다.
7. [ ] `CONTEXT.md`의 Work Checkpoint 문구와 실제 노출 범위를 일치시킨다
       (`progress`는 제외한다는 사실을 명시).

## 선행 상태 (2026-07-30 기준, 커밋되지 않음)

같은 조사에서 나온 아래 변경이 작업 트리에 남아 있다. 이 계획을 시작하기 전에 검토하고
커밋하거나 되돌린다.

- `apps/backend/app/lib/calendar-ai-service.js` — 거짓 완료 방어의 오탐 제거. 문장 단위
  1인칭 판정으로 교체했다. 검증 완료.
- `apps/backend/tests/phase6-calendar-ai.test.cjs` — 위 오탐 3건에 대한 테스트 추가.
- `apps/desktop/tests/playwright-phase3-golden-ete.cjs` — 단일 계정 경로의 낡은 대기 조건을
  두 계정 경로와 같게 수정.
- `docs/operations/evidence/*.json` 4개 — ETE 재실행으로 갱신된 실행값. 내용 변화는
  워크스페이스 ID와 소요 시간뿐이다.

검증 결과: `test:backend` 653/653, 데스크톱 342/342, `test:runner` 103/103,
`backend:check`·`typecheck` 통과. golden ETE는 이 계획의 항목 때문에 여전히 실패한다.

## Remaining Risks

- 본문 자유 텍스트가 가장 큰 위험이다. 키 기반 차단은 `metadata.command`를 막지만, 계획
  본문에 명령이 문장으로 들어가면 막지 못한다. Engine이 무엇을 계획 본문에 넣는지 실제
  Engine별로 표본을 확인한 뒤 결정한다.
- 이 투영은 Telegram 배달과 공유된다. Work Conversation만 생각하고 바꾸면 다른 채널에서
  의도치 않은 노출이 생길 수 있다. 체크리스트 1번을 건너뛰지 않는다.
- 소급 적용이므로 과거 작업의 대화도 갑자기 길어진다. 사용자에게는 변화로 보인다.
- 항목이 늘면 결과가 잡음에 묻힐 수 있다. 접힘 기본값을 유지하고, 늘어난 뒤 실제 화면을
  한 번 보고 판단한다.
