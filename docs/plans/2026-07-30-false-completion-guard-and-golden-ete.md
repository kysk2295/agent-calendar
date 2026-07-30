# Plan: 거짓 완료 방어의 오탐 제거와 golden ETE 복구

- Date: 2026-07-30
- Owner: Codex
- Work size: Medium
- Status: 부분 완료 — 제품 버그 1건 수정·검증 완료, golden ETE는
  [후속 계획](2026-07-31-work-conversation-shows-plan-and-artifact.md)으로 넘긴다

## Goal

거짓 완료 방어가 실제 거짓 주장만 차단하고 정상 답변은 그대로 통과시키게 만든다. 그 결과로
막혀 있던 golden ETE의 두 경로를 모두 통과시킨다.

## 배경 — 실측으로 확인한 것

`node apps/desktop/tests/playwright-phase3-golden-ete.cjs`와
`npm run verify:multi-user-ete`가 모두 실패한다. 실패 순간을 녹화해 확인한 결과 Calendar AI는
답을 했고, 그 답이 방어 로직에 의해 정형 문구로 통째로 교체되어 있었다.

[calendar-ai-service.js:104](../../apps/backend/app/lib/calendar-ai-service.js)의
`COMPLETED_ACTION_CLAIM`은 `(완료|추가|등록|…)(했|됐|뒀|…)` 단순 부분일치다. 시스템 프롬프트
자체가 담고 있는 안전 지시 — `'일정 변경을 완료했다고 주장하지 마세요'` — 가 이 패턴에 걸린다.
Fake 엔진은 프롬프트를 되돌려주므로 방어 로직이 **자신의 안전 지시문에 걸려** 답변을 지웠다.

이는 테스트만의 문제가 아니다. 같은 정규식이 다음도 차단한다.

| 입력 | 현재 | 기대 |
| --- | --- | --- |
| `그 회의는 어제 완료됐다고 기록돼 있어요` (사실 보고) | 차단 | 통과 |
| `"등록했어"라고 하셨는데, 어떤 일정일까요?` (사용자 말 인용) | 차단 | 통과 |
| `치과 예약을 캘린더에 추가했습니다` (진짜 거짓 주장) | 차단 | 차단 유지 |

Runner 비의존 커밋(`1c7b4f8`, `33df5a7`)은 원인이 아니다. 그 이전 커밋 `1f6f932`을 별도
워크트리에 체크아웃해 같은 게이트를 돌렸고 동일한 줄에서 동일하게 실패했다.

두 번째 결함도 있다. `1f6f932`은 위임 후 대기 조건이 한국어 UI에 없다는 것을 알고 고쳤으나
두 계정 경로(591줄)만 고쳤고 단일 계정 경로(1739줄)에는 옛 조건을 남겼다. 릴리스 증거를
만드는 쪽은 단일 계정 경로다.

## Non-Goals

- 시스템 프롬프트 문구는 바꾸지 않는다. 프롬프트가 아니라 판정기가 틀렸다.
- 의도 분류(`classifyCalendarAiIntent`)는 건드리지 않는다. 별도 항목이다.
- 액션 드래프트 생성 경로는 바꾸지 않는다.
- Fake 엔진이 프롬프트를 되돌려주는 동작은 바꾸지 않는다. 판정기가 견뎌야 한다.

## Touched Boundaries

- Backend gateway: 없음
- Backend library: `calendar-ai-service.js`의 완료 주장 판정기
- DB/migrations: 없음
- Electron bridge: 없음
- React UI: 없음
- Tests: `apps/backend/tests/phase6-calendar-ai.test.cjs`,
  `apps/desktop/tests/playwright-phase3-golden-ete.cjs`
- Docs: 이 계획

## Success Criteria

- [ ] 1인칭 완료 주장은 계속 차단된다 (기존 테스트 유지).
- [ ] 전언(`-다고`, `-라고`)은 차단되지 않는다.
- [ ] 따옴표 안의 인용은 차단되지 않는다.
- [ ] 시스템 안전 지시문이 답변에 섞여도 차단되지 않는다.
- [ ] 단일 계정 golden ETE가 통과한다.
- [ ] `npm run verify:multi-user-ete`가 통과한다.

## Edge Cases

- 한 답변에 정상 문장과 거짓 주장이 함께 있으면 차단한다. 안전이 우선이다.
- 따옴표가 열리고 닫히지 않으면 인용으로 보지 않는다.
- 문장 부호가 없는 짧은 답변은 전체를 한 문장으로 본다.
- 액션 드래프트 경로는 애초에 이 판정기를 지나지 않는다. 변경 없음.

## Test Plan

- RED: 전언·인용·안전지시문 3건이 보존되어야 한다는 테스트를 먼저 실패시킨다.
- GREEN: 문장 단위 + 따옴표 제거 + 전언 배제로 최소 구현한다.
- REFACTOR: 기존 거짓 주장 차단 테스트가 계속 통과하는지 확인한다.

## Acceptance Gates

- [ ] `npm run backend:check`
- [ ] `npm run test:backend`
- [ ] `npm run typecheck`
- [ ] `npm --workspace apps/desktop run test`
- [ ] `npm run test:runner`
- [ ] `node apps/desktop/tests/playwright-phase3-golden-ete.cjs`
- [ ] `npm run verify:multi-user-ete`

## Step-by-step Checklist

1. [x] 오탐 3건에 대한 실패 테스트를 쓴다.
2. [x] 판정기를 문장 단위 1인칭 판정으로 교체한다.
3. [x] 백엔드 게이트를 통과시킨다.
4. [x] 단일 계정 ETE의 낡은 대기 조건을 두 계정 경로와 같게 고친다.
5. [x] 접힌 `실행 기록` 안의 Engine 체크포인트를 검증하도록 라이브 단언을 고친다.
6. [ ] 두 ETE 경로를 모두 통과시킨다.

## 추가로 확인된 세 번째 결함 (2026-07-30)

수정 4를 적용하자 ETE가 더 진행한 뒤 `waitForLiveCheckpoint`에서 다시 멈췄다. 실패 순간
DB와 렌더러를 함께 덤프해 원인을 확정했다.

- 체크포인트 9건은 DB에 모두 있고 미션 스레드 세션과 일치했으며 미션은 `completed`였다.
- 렌더러는 `visible`이었고 오류·로딩·빈 상태가 모두 아니었으며 `.agent-checkpoint` 노드가
  1개 있었다.

한 번의 실행은 대표 항목 하나와 접힌 `실행 기록 N개` 개시 요소로 렌더링된다. 접힌
`<details>`의 텍스트는 `innerText`에 포함되지 않으므로, 하네스가 기다린 `Plan:`/`Progress:`는
DOM에 있으면서도 보이지 않았다. 제품이 옳고 단언이 낡았다.

세 결함 모두 같은 성격이다 — **하네스가 제품이 렌더링하지 않는 문자열을 기다렸다.** 그중
`1`번만 실사용자에게 영향을 주는 제품 버그였다.

## 네 번째 확인 — 접힘이 아니라 투영이었다 (2026-07-30)

위 세 번째 설명은 불완전했다. `textContent`로 바꿔도 같은 지점에서 실패했다. 앱이 실제로
받는 응답을 가로채 확인한 결과는 다음과 같다.

```
checkpointCount: 2, nextCursor: null, kinds: ["completion", "completion"]
```

DB의 9건 중 2건만 API를 통과한다. 접혀서 안 보이는 것이 아니라 **애초에 전달되지 않는다.**
[public-work-conversation-event.js:41](../../apps/backend/app/lib/public-work-conversation-event.js)의
`isPublicDisplayEvent`가 `plan`·`progress`·`artifact`를 종류 단위로 제외한다.

그리고 이 제외는 실수가 아니라 **의도된 유출 방지**이며
[public-work-conversation-projection.test.cjs](../../apps/backend/tests/public-work-conversation-projection.test.cjs)가
원시 명령·비공개 경로·원시 출력이 노출되면 안 된다고 명시적으로 단언한다. ETE를 통과시키려고
이 필터를 푸는 것은 테스트를 위해 프라이버시 경계를 무너뜨리는 거래이므로 하지 않았다.
추측으로 넣었던 하네스 변경(`textContent`, 펼침 단언)은 되돌렸다.

소유자가 A(중간 과정을 보여준다)를 선택했으므로, 계약 변경은
[2026-07-31 계획](2026-07-31-work-conversation-shows-plan-and-artifact.md)에서 다룬다.

## 이 계획에서 실제로 끝난 것

- 거짓 완료 방어 오탐 제거 (제품 버그, 실사용자 영향)
- 단일 계정 golden ETE의 낡은 대기 조건 수정

검증: `test:backend` 653/653, 데스크톱 342/342, `test:runner` 103/103,
`backend:check`·`typecheck` 통과.

## Remaining Risks

- 한국어 1인칭 판정은 완벽할 수 없다. 놓치는 거짓 주장이 남을 수 있으므로, 판정기는 방어의
  마지막 층이 아니라 한 층으로 취급한다. 액션이 실제로 없다는 사실은 액션 드래프트 개수로
  이미 알 수 있으므로, 후속으로 문자열이 아닌 그 사실에 근거한 검증으로 옮기는 편이 낫다.
