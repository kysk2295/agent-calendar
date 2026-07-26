# Plan: WikiScreen 그래프 책임 분리

- Date: 2026-07-23
- Owner: Codex
- Work size: Medium
- Status: Verified

## Goal

기존 Wiki 화면의 공개 인터페이스와 화면 동작을 유지하면서, `WikiScreen`에 섞여 있는 그래프 상태·레이아웃·상호작용·렌더링 책임을 하나의 깊은 `WikiGraphPanel` 모듈로 이동한다.

`WikiScreen`은 질문/답변, 문서 선택과 지연 로딩, 트리, 화면 전체의 그래프 집중 모드를 조정하는 안정적인 진입점으로 남긴다.

## Non-Goals

- `WikiScreenProps`, `App.tsx` 호출부, API, 응답 스키마, IPC, 저장 데이터 의미를 바꾸지 않는다.
- 그래프 수학, 임계값, 확대/축소 비율, 드래그 및 더블 클릭 타이밍을 바꾸지 않는다.
- CSS 클래스, `data-*`, ARIA 문구, DOM 순서와 계층을 바꾸지 않는다.
- 새로운 Context, Provider, Controller, 범용 Adapter 또는 큰 ViewModel을 도입하지 않는다.
- 이번 차수에서는 두 트리 표현과 트리 상태를 추출하지 않는다. 그래프 분리 검증 후 후속 차수로 진행한다.
- 기존 작업 트리의 Relay 실행 정책, 채팅 자동 스크롤, 음성 브리핑 변경을 수정하거나 되돌리지 않는다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 변경 없음
- React UI:
  - `apps/desktop/src/features/knowledge/WikiScreen.tsx`
  - `apps/desktop/src/features/knowledge/WikiGraphPanel.tsx`
  - `apps/desktop/src/features/knowledge/WikiReader.tsx`
  - `apps/desktop/src/features/knowledge/knowledgePresentation.ts`
- Tests:
  - `apps/desktop/tests/wiki-screen-structure.test.mjs`
  - `apps/desktop/tests/railway-data-contract.test.mjs`
  - `apps/desktop/tests/playwright-wiki-graph-layout.cjs`
  - `apps/desktop/tests/playwright-wiki-graph-ask.cjs`
  - `apps/desktop/tests/playwright-wiki-scope-options.cjs`
  - `apps/desktop/tests/playwright-wiki-answer-dismiss.cjs`
- Docs:
  - 이 계획 문서

## Success Criteria

- [x] `App.tsx`의 `WikiScreen` 호출과 기존 props 의미가 바뀌지 않는다.
- [x] 그래프 로컬 상태, refs, 파생 모델, 효과, 이벤트 처리, SVG/설정 렌더링은 `WikiGraphPanel` 한 곳에만 존재한다.
- [x] `graphFocusMode`만 화면 루트와 `.wiki-main` 계약 때문에 `WikiScreen`에 남는다.
- [x] `WikiReader`는 표시만 담당하고, 문서 캐시와 로딩 효과는 `WikiScreen`에 남는다.
- [x] `.wiki-graph-canvas > .wiki-reader` 관계와 기존 Wiki DOM/접근성 계약이 유지된다.
- [x] 구현 소스 검사 테스트가 새 책임 소유자를 검사하며 기존 단언을 약화하지 않는다.
- [x] 집중 테스트, 데스크톱 테스트, 타입 검사, 빌드, 전체 테스트와 Wiki 브라우저 시나리오가 통과한다.

## Edge Cases

- 그래프 노드 단일 클릭은 선택만 하고, 더블 클릭은 선택 후 문서 리더를 연다.
- 4px를 넘는 노드 드래그는 클릭을 억제하고 pointer capture 해제 순서를 유지한다.
- 로컬 그래프는 배너 활성화 전 비활성 상태이며, 외부 pointer down으로 다시 비활성화된다.
- 집중 보기의 루트와 `.wiki-main` 속성, 조밀 그래프의 자동 이동 효과가 유지된다.
- 본문이 없는 문서만 지연 로딩하며, 경로 변경/언마운트 뒤의 오래된 성공 결과를 무시한다.
- 문서 로딩 실패는 리더를 닫지 않고 기존 한국어 오류 본문으로 표시한다.
- 답변 출처는 상세 내용을 먼저 캐시하고 문서를 선택한 다음 리더를 연다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] `wiki-screen-structure.test.mjs`를 추가하고, 아직 없는 `WikiGraphPanel`/`WikiReader` 책임 경계 때문에 예상대로 실패하는지 확인한다.
- GREEN:
  - [x] 그래프 책임을 `WikiGraphPanel`로 이동하고 구조 테스트, Knowledge 도메인 테스트, Railway 데이터 계약 테스트를 통과시킨다.
  - [x] `WikiReader`와 `WikiArticle` 표시 책임을 추출하고 공개 export 및 리더 DOM 위치를 유지한다.
- REFACTOR:
  - [x] 공유 색상표만 기능 내부 presentation 모듈로 이동한다.
  - [x] 중복된 그래프 소유권과 사용하지 않는 import가 없음을 정적 검사한다.

## Acceptance Gates

- [x] `node --test apps/desktop/tests/wiki-screen-structure.test.mjs apps/desktop/tests/knowledge-domain.test.mjs apps/desktop/tests/railway-data-contract.test.mjs`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] `HERMES_UI_URL=<url> node apps/desktop/tests/playwright-wiki-graph-interactions.cjs`
- [x] `HERMES_UI_URL=<url> node apps/desktop/tests/playwright-wiki-graph-layout.cjs`
- [x] `HERMES_UI_URL=<url> node apps/desktop/tests/playwright-wiki-graph-banner-contract.cjs`
- [x] `HERMES_UI_URL=<url> node apps/desktop/tests/playwright-wiki-search-surface-buttons.cjs`
- [x] `HERMES_UI_URL=<url> node apps/desktop/tests/playwright-wiki-graph-ask.cjs`
- [x] `HERMES_UI_URL=<url> node apps/desktop/tests/playwright-wiki-tree-search.cjs`
- [x] `HERMES_UI_URL=<url> node apps/desktop/tests/playwright-wiki-answer-dismiss.cjs`
- [x] `HERMES_UI_URL=<url> node apps/desktop/tests/playwright-wiki-scope-options.cjs`
- [x] `HERMES_UI_URL=<url> node apps/desktop/tests/playwright-search-doc-open.cjs`
- [x] `HERMES_UI_URL=<url> node apps/desktop/tests/playwright-wiki-session-turn-stream.cjs`
- [x] `git diff --check`

건너뛴 gate:

- Gate: 없음
  - Reason: 계획한 gate를 모두 실행했다.

## Implementation Checklist

- [x] Step 1: 구조 계약 테스트를 추가하고 예상 RED를 기록한다.
- [x] Step 2: 공유 Wiki 그룹 색상표를 presentation 모듈로 이동한다.
- [x] Step 3: `WikiGraphPanel`을 만들고 그래프 로컬 책임 전체를 이동한다.
- [x] Step 4: `WikiReader`/`WikiArticle` 표시 책임을 이동하고 기존 export를 유지한다.
- [x] Step 5: `WikiScreen`을 질문/문서/트리/집중 모드 조정자로 축소한다.
- [x] Step 6: 두 구현 소스 검사 테스트를 새 소유자로 이동한다.
- [x] Step 7: 좁은 테스트와 타입 검사를 통과시킨다.
- [x] Step 8: Wiki 브라우저 시나리오 10개를 실행한다.
- [x] Step 8a: 직접 `wikicurator` 스트림 계약과 어긋난 오래된 선행 검색 기대를 테스트에서 제거한다.
- [x] Step 9: 데스크톱 테스트, 빌드, 전체 테스트와 범위 감사를 완료한다.
- [x] Step 10: 코드 리뷰 결과와 실제 검증 결과로 이 문서를 닫는다.

## Rollback / Fallback

- 그래프 분리는 원래 그래프 블록을 `WikiScreen`에 복원하고 새 `WikiGraphPanel` 및 소스 검사 대상만 되돌리는 한정된 변경이다.
- 리더 분리는 그래프 분리와 독립적으로 `WikiArticle`/리더 마크업을 `WikiScreen`에 복원할 수 있다.
- 회귀가 발생하면 선택자나 테스트 기대값을 바꾸지 않고 이동한 문장과 마크업의 순서부터 원래대로 맞춘다.
- 더러운 작업 트리는 reset하지 않으며, 이 계획에 명시한 파일 외 변경은 보존한다.

## Verification Notes

- Command: `npm run typecheck`
  - Result: 구현 전 기준선 통과.
- Command: `node --test apps/desktop/tests/knowledge-domain.test.mjs apps/desktop/tests/railway-data-contract.test.mjs`
  - Result: 구현 전 기준선 45개 테스트 통과.
- Command: `node --test apps/desktop/tests/wiki-screen-structure.test.mjs`
  - Result: 구현 전 `WikiGraphPanel must own the graph implementation`으로 예상 RED 확인.
- Command: `node --test apps/desktop/tests/wiki-screen-structure.test.mjs apps/desktop/tests/knowledge-domain.test.mjs apps/desktop/tests/railway-data-contract.test.mjs`
  - Result: 구현 후 46개 통과, 실패/건너뜀 없음.
- Command: `npm run typecheck`
  - Result: renderer와 Electron TypeScript 검사 통과.
- Command: `npm --workspace apps/desktop run test`
  - Result: 데스크톱 163개 통과.
- Command: `npm run build:desktop`
  - Result: 타입 검사, renderer production build, Electron build 통과.
- Command: `npm test`
  - Result: 백엔드 290개와 데스크톱 163개, 합계 453개 통과.
- Command: Wiki Playwright 10개 시나리오
  - Result: 그래프 상호작용/레이아웃/배너/검색/질문 및 트리/답변 닫기/scope/문서 열기/세션 스트림 모두 통과.
- Command: `npm run backend:check`
  - Result: backend syntax gate 통과.
- Command: 범위/정적 감사
  - Result: `App.tsx`와 `styles.css` 구현 전후 SHA-256 동일, 중복 그래프 소유권·Context·ViewModel·Adapter·ignore 지시어·공백 오류 없음.
- Review:
  - Result: 코드 리뷰 APPROVE. `WikiGraphPanel` 514줄은 단일 그래프 상호작용 책임에 응집되어 있지만 후속 순수 projection 분리 후보로 기록.
- Final gate review:
  - Result: APPROVE. 재실행한 집중 테스트 46개와 범위 감사를 포함해 차단 이슈 없음.

## Remaining Risks

- Risk: 이벤트 클로저 이동으로 pointer capture, 드래그 후 클릭 억제, 더블 클릭 타이밍이 달라질 수 있다.
  - Mitigation: 그래프 상호작용, 배너, 레이아웃 Playwright 시나리오를 필수 게이트로 실행한다.
- Risk: `children`을 통한 리더 삽입이 DOM 계층을 바꿀 수 있다.
  - Mitigation: 구조 테스트와 런타임에서 `.wiki-graph-canvas > .wiki-reader`를 확인한다.
- Risk: 소스 검사 테스트가 새 파일을 보지 않아 거짓 양성이 될 수 있다.
  - Mitigation: 기존 단언을 유지한 채 `WikiGraphPanel.tsx`를 명시적으로 읽는다.
- Risk: 트리 책임은 여전히 `WikiScreen`에 남는다.
  - Mitigation: 이번 차수의 검증을 끝낸 뒤 별도 계획으로 두 트리 표현을 함께 다룬다.
- Risk: 일부 Wiki Playwright가 현재 직접 스트림 구현과 달리 `/api/wiki/search` 또는 `/api/wiki/ask` 호출을 전제로 했다.
  - Mitigation: 실제 RED와 약한 fixture를 확인한 뒤 제품 동작은 바꾸지 않고, 검색 미호출·스트림 scope payload·SSE 답변을 명시적으로 단언하도록 테스트를 갱신한다.
