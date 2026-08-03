# Agent Calendar

> 나를 이해하고, 기억하며, 필요한 일을 실제로 수행하는 캘린더.

Agent Calendar는 AI를 자주 쓰는 1인 운영자를 위한 macOS 캘린더입니다. 사용자가 허용한
일정, 메일, 파일과 기록을 바탕으로 사람, 프로젝트, 목표와 진행 중인 일을 이해하고,
지금 중요한 일을 알려주며, 필요한 작업을 같은 맥락으로 이어갑니다.

Second Brain과 LLM Wiki는 별도 제품이 아니라 캘린더가 사용자를 이해하기 위한 기억
계층입니다. 작업 결과와 사용자의 수정은 다시 캘린더와 Wiki에 쌓여 다음 대화와 판단에
사용됩니다.

현재는 개인 베타를 구현하고 검증하는 단계입니다. 제품의 권위 방향은
[Second Brain PRD](docs/PRD-agent-calendar-second-brain.md)와 [CONTEXT.md](CONTEXT.md)에
정의되어 있습니다.

![일정과 작업 결과가 모이는 Agent Calendar 통합 캘린더](apps/web/public/product-calendar.png)

## 왜 만들었나

AI를 자주 쓰는 1인 운영자의 일정, 메일, 파일, 메모, 녹음과 AI 대화는 여러 도구에
흩어져 있습니다. 새로운 AI를 열 때마다 자신과 프로젝트의 배경을 다시 설명하고, AI가
만든 결과와 후속 작업도 사람이 직접 기억해야 합니다.

Agent Calendar는 이 반복을 캘린더 중심의 한 흐름으로 연결합니다.

- **이해:** 허용한 기록에서 사람, 프로젝트, 목표, 선호와 진행 중인 일을 파악합니다.
- **기억:** 원본과 출처를 보존하고 Calendar AI와 LLM Wiki가 다음 대화와 작업에 사용합니다.
- **계획:** 오늘 중요한 일정, 열린 일과 다음 행동을 캘린더에서 알려줍니다.
- **작업:** 배경을 다시 설명하지 않고 조사, 정리, 문서 작성 같은 일을 맡깁니다.
- **보고:** 진행, 막힘, 전체 결과와 산출물이 작업 대화, 캘린더와 Wiki에 돌아옵니다.
- **통제:** 외부 전송, 구매, 삭제, 새 권한과 반복 실행은 사용자 승인 뒤에만 진행합니다.

## 제품 흐름

```text
기록 연결 → 사용자 이해 → 캘린더에서 파악 → Calendar AI와 계획
    ↑                                             ↓
    └──────── Wiki에 기억 ← 결과 보고 ← 에이전트 작업 ────────┘
```

### Calendar AI

현재 대화와 사용자가 허용한 일정, Wiki, 메일, 이전 작업을 함께 이해합니다. 명확한 요청은
미리보기와 정책을 거쳐 일정, 작업 또는 Wiki 기록으로 이어집니다.

### LLM Wiki

원본 기록과 생성된 지식을 구분해 보존하고 사람, 프로젝트, 결정, 아이디어, 일정, 작업과
결과를 출처와 함께 연결합니다. 사용자는 출처를 확인하고 잘못된 기억을 수정, 제외 또는
삭제할 수 있습니다.

### 에이전트 작업

Codex나 Claude처럼 하나의 작업 대화를 시작하고 계속할 수 있습니다. 폴더 없는 리서치와
문서 작업, 명시적으로 연결한 로컬 폴더 작업을 모두 지원하며 진행 중 추가 지시, 중단,
재시도, 병렬 실행과 재시작 복구를 제품 목표로 검증합니다.

![대화와 작업 체크포인트가 이어지는 Agent Calendar 에이전트 화면](apps/web/public/product-agents.png)

### 자동화

반복 일정과 작업 패턴에서 루틴을 제안합니다. 사용자가 조건, 주기, 담당 에이전트, 사용할
맥락과 보고 위치를 검토하고 활성화하기 전에는 실행하지 않습니다.

## 신뢰와 데이터 소유권

- 로그인은 Gmail, Google Calendar 또는 실행 엔진 권한을 자동으로 부여하지 않습니다.
- 파일과 폴더는 사용자가 명시적으로 선택한 범위만 사용합니다.
- Workspace의 일정, Wiki, 작업, 에이전트와 Runner 상태는 다른 Workspace와 섞이지 않습니다.
- Codex, Claude, Grok, Hermes 자격 증명은 사용자 소유 Runner 환경에 남습니다.
- 새 권한, 추가 비용, 외부 전달, 구매와 삭제는 승인 정책을 통과해야 합니다.
- 원시 실행 로그보다 사용자가 판단할 수 있는 계획, 진행, 막힘, 근거와 결과를 보여줍니다.

Runner는 제품의 첫 사용 가치가 아니라 사용자 소유 실행 환경을 지키기 위한 하위
아키텍처입니다. 비개발자는 모델, endpoint 또는 provider session을 선택하지 않고도 작업을
시작할 수 있어야 합니다.

## 저장소 구성

```text
apps/
  backend/   Railway Gateway, 인증, Calendar AI, Source, Work, Automation
  desktop/   React renderer와 Electron bridge를 포함한 macOS 앱
  runner/    사용자 소유 실행 엔진 연결과 작업 실행
  web/       공개 제품 랜딩과 신뢰 문서
  widget/    macOS Widget 통합
docs/        PRD, ADR, 구현 계획, 운영 및 QA 증거
scripts/     배포, 프로덕션 준비와 E2E 검증 도구
```

실행 경계는 다음과 같습니다.

```text
Signed macOS Desktop
        │
        ▼
Railway Gateway ─── PostgreSQL
        │
        ▼
User-owned Runner ─── Codex / Claude / Grok / Hermes
```

## 개발과 검증

요구 환경:

- Node.js 22.x
- npm 10 이상
- macOS Electron 패키징에는 Apple signing 환경 필요
- 실제 프로덕션 검증에는 Railway, WorkOS와 사용자 소유 Runner 권한 필요

```bash
npm install
npm run backend:check
npm run typecheck
npm test
npm run build:desktop
```

경계별 명령:

```bash
npm run test:backend
npm --workspace apps/desktop run test
npm run test:runner
npm run build:web
npm run lint:web
```

로컬 개발 서버는 빠른 개발 피드백에만 사용합니다. 로그인, OAuth, Railway API, 패키지
Electron, 실제 Runner와 첫 사용자 여정의 완료 근거로 인정하지 않습니다. 프로덕션 완료는
서명된 앱이 Railway와 실제 Runner에 연결된 상태에서 검증해야 합니다.

## 작업 규칙과 문서

- [Agent workflow](AGENTS.md)
- [Product context](CONTEXT.md)
- [Authoritative Second Brain PRD](docs/PRD-agent-calendar-second-brain.md)
- [Implementation roadmap](docs/plans/2026-08-02-second-brain-implementation-roadmap.md)
- [Production operations](docs/operations/personal-beta-release.md)
- [Plans](docs/plans/README.md)

Medium 이상의 변경은 `docs/plans/`에 계획을 먼저 만들고, 행동 변경은 실패하는 테스트부터
작성합니다. 완료 보고에는 실행한 검증, 건너뛴 검증과 남은 위험을 포함합니다.
