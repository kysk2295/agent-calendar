# Agent Work Control Space 디자인 시스템 감사 및 정비 계획

## Goal

에이전트 탭의 Control Home과 Work Conversation View를 `docs/DESIGN.md`의 차분하고 정보 밀도 높은 운영형 데스크톱 UI로 정비한다. 실제 위임 작업, 진행 상태, 승인, 결과 검토, 후속 지시 흐름은 유지하면서 시각적 위계·타이포그래피·간격·반응형·접근성을 하나의 디자인 시스템으로 일관되게 만든다.

## Non-goals

- Backend, DB, Railway, Hermes, local LLM 실행 계약 변경
- 위임·스트리밍·승인·작업 제어의 도메인 동작 재설계
- 전체 앱 사이드바와 캘린더 화면의 광범위한 리브랜딩
- 새로운 아이콘 세트나 장식성 그래픽 도입
- 목 데이터로 실제 작업 상태를 대체

## Work size

Large. Desktop React 화면, 공유 스타일, 디자인 문서, 데스크톱 테스트와 실제 Electron UI 검증을 함께 다룬다.

## Touched boundaries

- Desktop app: `apps/desktop/src/features/agent-operations/**`, 필요 시 공유 토큰
- Contracts and tests: `apps/desktop/tests/**`
- Specs and plans: `docs/DESIGN.md`, `docs/plans/**`
- Visual evidence: `apps/desktop/audit/2026-07-15-agent-design-system/**`

기존 생성 API의 제목 상한 300자는 그대로 사용한다. Desktop이 임의로 적용하던 72자 축약만 제거해 저장 값과 화면 표시가 같은 작업명을 유지한다.

## Baseline audit

### Evidence

1. `before/01-control-home.jpeg`: 실제 Electron Control Home 1230×768 상태
2. `before/02-work-conversation.jpeg`: Computer Use 캡처가 검은 영역으로 손상되어 시각 근거에서 제외
3. 사용자 제공 오류 상태 캡처: Work Conversation View의 헤더·빈 오류 상태·composer 구조 확인용 참고 자료

### What already aligns

- warm neutral palette와 기존 `--main`, `--panel`, `--line`, `--accent-*` 토큰을 사용한다.
- Control Home은 한 화면에서 위임, 에이전트 상태, 진행/확인 필요, 승인 대기, 최근 작업 대화를 확인할 수 있다.
- Work Conversation View는 타임라인을 주 콘텐츠로 두고 composer를 항상 노출한다.
- 실제 상태를 텍스트와 색상으로 함께 표현하고 대부분의 주요 컨트롤은 44px 목표 크기를 가진다.
- 좁은 폭용 단일 열 전환과 reduced-motion 규칙이 존재한다.

### Issues to repair

- Control Home의 제목 20px, Work Conversation 제목 20–24px, 본문 9–10px가 혼재해 DESIGN의 조밀한 10–12.5px 본문·약 15.5px 화면 제목 체계와 어긋난다.
- 전역 `!important` 글자 크기 보정이 세부 컴포넌트의 위계를 무너뜨리고 폰트 깨짐처럼 보이는 과도한 축소를 만든다.
- Work Conversation의 in-flow checkpoint, composer, details에 그림자가 반복되어 경계선 중심의 운영형 UI 원칙과 어긋난다.
- 빈 작업 대화가 넓은 카드 한 장으로 보이며 실제 대화 공간보다 보고서/상태 패널처럼 느껴진다.
- 작업 헤더에서 상태·담당자·배정 이유·주의 문구가 한 덩어리로 이어져 스캔이 어렵고 CJK 줄바꿈이 불안정하다.
- Control Home의 진행 카드가 고정 68% 진행 표시를 사용해 실제 상태와 시각 의미가 다를 수 있다.
- 960px 아래에서 전체 화면 스크롤과 composer가 함께 흐르므로 긴 대화에서 입력창 발견성이 떨어진다.
- Control Home이 연결된 자동화 수만 집계하고 기존 자동화별 일정·담당·최근 실행 요약 카드를 보여주지 않는다.
- 일부 보조 작업 버튼이 기본 30px로 정의된 뒤 상위 규칙으로만 44px가 강제되어 컴포넌트 계약이 불명확하다.

## Success criteria

- Control Home과 Work Conversation이 `docs/DESIGN.md`의 색상, 제목 크기, 본문 크기, 간격, 테두리, radius, shadow 원칙을 따른다.
- Work Conversation은 한 개의 시간순 대화 흐름으로 읽히고 user/agent/approval/result 상태가 과도한 카드 중첩 없이 구분된다.
- composer는 데스크톱과 좁은 화면 모두에서 작업 흐름의 다음 행동으로 명확하며 콘텐츠를 가리지 않는다.
- 상태·담당자·배정 이유·주의 문구가 빠르게 스캔되고 한글 줄바꿈이 음절 단위로 파손되지 않는다.
- 375px, 768px, 1280px에서 가로 스크롤, 잘림, 겹침, 오프스크린 주요 액션이 없다.
- 키보드 포커스, 상태 텍스트, 44px 주요 컨트롤, reduced motion을 유지한다.
- 실제 Electron 앱에서 Control Home → 실제 Work Conversation → 후속 지시 입력 흐름이 동작한다.

## Edge cases

- 아주 긴 한국어 작업 제목과 배정 이유
- 체크포인트 없음, loading, error, stale aggregate
- 긴 스트리밍 응답과 부분 응답 후 오류
- 승인 요청/결과/후속 제안이 한 checkpoint에 중첩된 경우
- 200% zoom에 준하는 좁은 viewport
- dark theme와 reduced motion
- details가 접히거나 긴 task 목록을 가진 경우

## Test plan

1. 디자인 계약 테스트를 먼저 추가해 제목 체계, shadow 제거, status metadata 구조, 반응형 composer 규칙이 현재 구현에서 실패하는지 확인한다.
2. `npm --workspace apps/desktop run test -- <target>` 또는 가장 좁은 해당 Node 테스트를 반복한다.
3. `npm run typecheck`
4. `npm --workspace apps/desktop run test`
5. `npm run build:desktop`
6. 실제 Electron 앱에서 Control Home → Work Conversation → composer 입력/전송 가능 상태를 확인한다.
7. 허용된 캡처 방식으로 1280/768/375 시각 증거를 확보하고 독립적인 visual QA를 수행한다.

## Acceptance gates

- [x] RED: 새 디자인 계약 테스트가 기대한 이유로 실패
- [x] GREEN: 새 테스트와 기존 Desktop 테스트 통과
- [x] TypeScript typecheck 통과
- [x] Desktop build 통과
- [x] 실제 데이터가 있는 Control Home과 Work Conversation 모두 시각 점검 통과
- [x] 실제 Electron 1320px와 200% 확대에서 주요 흐름의 레이아웃 점검 통과
- [x] 실제 composer 입력과 주요 navigation 동작 확인
- [ ] 최신 소스 기준 독립 시각 QA 및 코드 리뷰에서 blocker/critical 없음

## Step-by-step checklist

- [x] 현재 디자인 시스템과 기존 화면 패턴 확인
- [x] 실제 Control Home 기준 캡처 및 Work Conversation 캡처 실패 기록
- [x] 디자인 계약 테스트 작성 및 RED 확인
- [x] Work Conversation header metadata 구조와 semantic status presentation 정비
- [x] Agent workspace 타이포그래피, 간격, border/radius, shadow 체계 정비
- [x] Control Home의 카드 밀도와 상태 표시를 실제 데이터 의미에 맞게 정비
- [x] 기존 자동화 일정·담당·최근/다음 실행을 읽기 전용 요약 카드로 복원
- [x] 저장 제목을 기존 backend 300자 계약까지 보존하고 legacy 72자 제목만 화면에서 복구
- [x] 960/760/480 반응형과 CJK wrapping 정비
- [x] 좁은 테스트부터 전체 Desktop 검증까지 실행
- [x] fresh screenshots와 상호작용 증거 확보
- [ ] 독립 QA/review 결과 반영

## Rollback / fallback

- 변경은 agent workspace TSX/CSS와 해당 테스트로 제한한다.
- 동작 회귀가 생기면 구조 변경을 최소화하고 기존 이벤트 핸들러/props 계약을 그대로 둔 채 CSS 및 presentation markup만 축소 적용한다.
- 멀티 viewport 자동 캡처를 허용된 도구로 확보하지 못하면 구현·자동 테스트·Electron 실기기 검증 결과는 유지하되 해당 시각 gate를 미통과로 명시한다.

## Remaining risks

- 현재 Computer Use의 Work Conversation 캡처가 검은 영역으로 손상되어 baseline visual diff가 제한적이다.
- 앱 전체의 레거시 emoji/text glyph와 본문 타이포그래피 부채는 이번 Agent tab 범위 밖이다.
- 실제 데이터의 길이와 상태 조합이 매우 다양해 모든 checkpoint 조합을 한 화면에서 동시에 검증하기 어렵다.

## Verification notes

- `npm --workspace apps/desktop exec -- node --test tests/agent-work-design-system.test.mjs tests/agent-work-live-stream.test.mjs`: 각 behavioral 단계의 RED를 확인한 뒤 최종 18/18 통과
- `npm run typecheck`: 통과
- `npm --workspace apps/desktop run test`: 127/127 통과. 실행 중 Vite HMR WebSocket 포트 24678 사용 경고가 있었으나 테스트 실패는 없음
- `npm run build:desktop`: renderer/electron production build 통과
- 실제 Electron: 저장된 실제 Business Consultant Work Conversation의 user/agent 왕복 기록과 composer를 확인하고 앱을 1320×824, 100% 상태로 복원
- 실제 Electron: 최소 창 980×700에서 timeline만 스크롤되고 composer와 접힌 작업 정보가 동시에 보이는지 확인
- 실제 Electron: 200% 확대에서 좁은 reflow, 단일 작업 스크롤, composer 가시성, 의미 단위 한글 줄바꿈 확인
- 유효 fresh PNG: `final/21-navigation-check.png`, `final/24-work-conversation-980-cjk.png`, `final/25-work-conversation-zoom-check.png`, `final/26-work-conversation-current.png`
- Browser/Playwright 직접 실행: Product Design 규칙상 사용자가 선택한 브라우저가 없어 실행하지 않음. 실제 Electron UI와 기존 Desktop 자동 테스트로 대체
