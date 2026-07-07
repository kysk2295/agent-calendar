# Agent Calendar 개발 방법론

출처: [바이브 코딩 중인 내가 쓰는 Agent Skills - 260611](https://mekain80.tistory.com/323)

이 문서는 위 글의 핵심 흐름을 Agent Calendar 저장소에 맞게 적용한 운영 규칙이다.

```text
프로젝트 읽기 -> 계획 -> 구현 -> 검증 -> 리뷰
```

목적은 절차를 늘리는 것이 아니라, 에이전트가 목표·범위·경계·검증 기준이 흐릿한 상태에서 코드를 먼저 쓰는 일을 막는 것이다.

## 1. 작업 크기부터 분류한다

모든 작업은 구현 전에 크기를 먼저 정한다.

| 크기 | Agent Calendar 기준 | 필수 흐름 |
|---|---|---|
| Small | 단일 파일/모듈, 계약 변경 없음 | 채팅 수준 짧은 계획, TDD, 좁은 검증 |
| Medium | 한 서브시스템, 여러 파일 가능, 계약 변경은 로컬 | `docs/plans/...` 계획, TDD, 서브시스템 검증 |
| Large | backend, Electron, React, DB, Railway, widget, LLM 경계를 넘음 | 전체 계획, 체크리스트 실행, 반복 검증 |
| Boundary | API/schema/preload/DB/source type/저장 의미 변경 | 구현량이 작아도 Large처럼 취급 |

작아 보이는 diff가 비싸지는 지점은 Boundary 작업이다. 예시는 다음과 같다.

- `/api/assistant/ask` 응답 구조 변경
- source type 추가·이름 변경
- Electron preload API 변경
- DB migration 또는 저장된 데이터 의미 변경
- embedding 모델/벡터 계약 변경
- auth 또는 Railway gateway 동작 변경

## 2. 계획 규칙

Medium 이상 작업은 제품 코드 수정 전에 계획 파일을 만든다.

위치:

```text
docs/plans/YYYY-MM-DD-short-name.md
```

시작 템플릿은 [agent-plan-template.md](templates/agent-plan-template.md)를 사용한다.

좋은 계획은 아래 질문에 답한다.

- 무엇을 만들 것인가?
- 무엇은 만들지 않을 것인가?
- 어떤 경계를 건드리는가?
- 사용자에게 보이는 동작은 어떻게 바뀌는가?
- 어떤 예외 케이스를 반드시 다룰 것인가?
- 어떤 테스트가 동작을 증명하는가?
- 어떤 build/typecheck/test 명령을 acceptance gate로 삼는가?

## 3. TDD 실행

구현 작업은 다음 순서를 기본값으로 둔다.

```text
RED -> GREEN -> REFACTOR
```

1. 하나의 동작을 보여주는 실패 테스트를 먼저 작성한다.
2. 테스트를 실행해 의도한 이유로 실패하는지 확인한다.
3. 통과에 필요한 최소 구현만 한다.
4. 같은 테스트를 다시 실행해 통과를 확인한다.
5. green 이후에만 리팩터링한다.

UI 변경처럼 단위 테스트가 부자연스러운 경우에는 가능한 가장 작은 Playwright 또는 contract 테스트를 만든다. 자동화가 합리적이지 않다면, 코딩 전에 수동 acceptance check를 계획에 기록한다.

## 4. 이 저장소의 Acceptance Gate

구현 중에는 가장 좁은 명령을 먼저 실행하고, 완료 전에는 범위에 맞게 넓힌다.

| 변경 영역 | 좁은 gate | 넓은 gate |
|---|---|---|
| Backend library/route | `npm run backend:check` 및 관련 `node --test apps/backend/tests/<file>.test.cjs` | `npm run test:backend` |
| Desktop Electron bridge | `npm run typecheck` 및 관련 desktop test | `npm --workspace apps/desktop run test` |
| React UI workflow | 관련 `apps/desktop/tests/playwright-*.cjs` | `npm run build:desktop` |
| API/schema boundary | 생산자와 소비자 양쪽 테스트 | `npm test` |
| Docs only | 링크·경로·diff 확인 | 생성물에 영향이 없으면 build 불필요 |

## 5. 리뷰 루프

구현 후 diff를 네 관점에서 확인한다.

- 버그 위험
- boundary/contract drift
- 빠진 테스트 또는 약한 테스트
- 범위를 벗어난 변경

그다음 최종 acceptance gate를 다시 실행한다. 완료 주장은 기억이 아니라 방금 실행한 명령 결과를 근거로 해야 한다.

## 6. 시작 프롬프트 패턴

새로운 비자명 기능을 시작할 때:

```text
작업 크기를 먼저 분류해줘.
제품 코드 수정 전에 docs/plans/YYYY-MM-DD-feature-name.md를 만들어줘.
goal, non-goals, touched boundaries, edge cases, tests, acceptance gates를 포함해줘.
그다음 체크리스트 항목을 TDD로 구현하고 각 gate를 검증해줘.
```

이미 계획이 있을 때:

```text
docs/plans/<plan>.md를 구현해줘.
체크리스트를 그대로 따라가고, 제품 코드 변경은 TDD로 진행해줘.
나열된 acceptance gates를 실행하고, 건너뛴 검증은 이유를 보고해줘.
```
