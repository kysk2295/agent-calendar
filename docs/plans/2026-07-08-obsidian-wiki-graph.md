# Plan: Obsidian-style wiki graph

- Date: 2026-07-08
- Owner: Codex
- Work size: Medium
- Status: Verified

## Goal

위키 그래프 뷰를 Obsidian 그래프처럼 동적으로 생성한다. 연결된 노트는 중앙 클러스터로 모이고, 링크가 없는 노트는 외곽 링에 고르게 배치되며, 얇은 회색 엣지와 작은 점 중심의 시각 체계를 사용한다.

## Non-Goals

- 백엔드 위키 스캔, 링크 파싱, API 응답 스키마는 변경하지 않는다.
- Obsidian 전체 기능이나 설정 패널을 복제하지 않는다.
- 실시간 물리 애니메이션 엔진은 만들지 않고 deterministic layout을 사용한다.

## Touched Boundaries

- Backend gateway: none
- Backend library: none
- DB/migrations: none
- Electron bridge: none
- React UI: `apps/desktop/src/App.tsx`, `apps/desktop/src/styles.css`
- Tests: `apps/desktop/tests/playwright-wiki-graph-layout.cjs`
- Docs: this plan

## Success Criteria

- [x] 연결된 노드는 중앙 클러스터에 배치되고, 고립 노드는 외곽 링에 안정적으로 배치된다.
- [x] 노드 크기는 링크 수에 따라 커지며, 색은 기존 앱 톤을 해치지 않는 회색 중심 그래프가 된다.
- [x] 그래프 확대, 이동, 노드 클릭으로 문서 열기 동작은 유지된다.

## Edge Cases

- 노드만 있고 엣지가 없는 위키:
- 엣지가 존재하지만 노드 ID와 path/id 형식이 섞인 위키:
- 노드 수가 많은 위키:

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] `apps/desktop/tests/playwright-wiki-graph-layout.cjs`가 고립 노드의 외곽 링 배치와 중심 클러스터 배치를 검증하고, 현재 구현에서 실패한다.
- GREEN:
  - [x] `buildWikiGraphLayout`을 Obsidian식 cluster + annulus layout으로 변경해 테스트를 통과시킨다.
- REFACTOR:
  - [x] CSS를 회색 네트워크 스타일로 다듬고 기존 확대/이동/클릭 테스트를 유지한다.

## Acceptance Gates

완료 전에 관련 명령을 실행한다.

- [x] `node apps/desktop/tests/playwright-wiki-graph-layout.cjs`
- [x] `node apps/desktop/tests/playwright-wiki-graph-ask.cjs`
- [x] `node apps/desktop/tests/playwright-wiki-search-surface-buttons.cjs`
- [x] `npm --workspace apps/desktop run typecheck`

건너뛴 gate:

- Gate:
  - Reason:

## Implementation Checklist

- [x] Step 1: Obsidian 화면과 현재 구현을 비교해 레이아웃 요구를 확정한다.
- [x] Step 2: 외곽 링/중앙 클러스터 배치 테스트를 추가하고 RED를 확인한다.
- [x] Step 3: 동적 레이아웃 알고리즘과 SVG 스타일을 구현한다.
- [x] Step 4: 좁은 테스트, 기존 그래프 테스트, 타입체크, 시각 확인을 실행한다.

## Verification Notes

- Command: `node apps/desktop/tests/playwright-wiki-graph-layout.cjs`
  - Result: passed. Linked average radius 79.73, isolated average radius 263.70, isolated ring share 0.9375.
- Command: `node apps/desktop/tests/playwright-wiki-graph-ask.cjs`
  - Result: passed. Graph zoom and wiki ask flow still work.
- Command: `node apps/desktop/tests/playwright-wiki-search-surface-buttons.cjs`
  - Result: passed after updating the reader close selector to `.wiki-reader-close`.
- Command: `npm --workspace apps/desktop run typecheck`
  - Result: passed.
- Command: Visual QA screenshot
  - Result: captured `apps/desktop/audit/obsidian-wiki-graph-2026-07-08/desktop-final.png`; 115 nodes, 18 edges, 1 visible label, linked average radius 85.08, isolated average radius 288.34.

## Remaining Risks

- Risk: 실제 vault 규모가 테스트보다 훨씬 클 때 노드가 과밀해질 수 있다.
  - Mitigation: 노드 수에 따라 force iteration과 링 반경을 조절한다.
