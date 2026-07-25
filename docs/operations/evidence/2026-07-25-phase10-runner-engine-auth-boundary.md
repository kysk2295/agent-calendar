# Phase 10 Runner engine authentication boundary evidence

- Date: 2026-07-25
- Result: Pass
- Scope: Workspace login, Calendar OAuth explanation, Runner-hosted provider authentication,
  durable engine eligibility, Desktop onboarding and Runner Setup

## Product behavior

Agent Calendar의 세 인증 경계가 분리되어 있다.

1. 작업공간 로그인은 현재 사용자와 Workspace를 식별한다.
2. Google Calendar OAuth는 그 사용자의 일정 권한만 연결한다.
3. Codex, Claude, Grok, Hermes 인증은 사용자 소유 Runner에서 검증되며 provider credential은
   control plane이나 Desktop 설정으로 이동하지 않는다.

Backend는 Runner가 엔진을 `available`이라고 보고하더라도 `authStatus`가
`missing`, `unknown`, 또는 누락이면 다음을 수행하지 않는다.

- 연결 테스트 준비 완료
- automatic/explicit durable engine 선택
- 온보딩 Runner 단계 완료

인증 완료로 인정하는 상태는 `authenticated`, `ok`, `ready`, `active`로 제한된다.
`ok`는 현재 테스트 Fake Engine과 이전 Runner protocol의 명시적 성공 상태를 위한
호환 값이다.

## RED → GREEN

Backend:

- `apps/backend/tests/phase10-runner-engine-auth-boundary.test.cjs`
- RED: `available + authStatus: missing` Codex가 explicit engine으로 선택됨
- GREEN: `engine_auth_required:codex`, auto는 첫 명시적 인증 엔진만 선택
- capability normalization은 설치 정보는 보존하면서 `available: false`,
  `status: auth_required`로 fail closed

Desktop:

- `apps/desktop/tests/onboarding-readiness.test.mjs`
- `apps/desktop/tests/runner-engine-auth-presentation.test.mjs`
- 연결됨/미인증은 `실행 엔진 인증 필요`
- 엔진별로 `Runner 인증 확인됨`, `Runner에서 로그인하세요`, `설치 필요`를 구분

## Real Electron and Runner ETE

Command:

`node apps/desktop/tests/playwright-phase2-runner-enrollment-e2e.cjs`

Observed:

- AuthKit login-derived Workspace
- onboarding에서 작업공간 로그인, 캘린더 OAuth, 실행 엔진 인증 경계 표시
- one-use enrollment challenge and decodable QR
- owner-confirmed device fingerprint
- real Runner process claim/connect/capability report
- authenticated Codex/Hermes ready
- installed but unauthenticated Claude remains unavailable with host login guidance
- uninstalled Grok remains unavailable with install guidance
- connection test passes because at least one explicitly authenticated engine exists
- disconnect/reconnect truth, credential rotation, old credential rejection, revoke rejection

Screenshots:

- `apps/desktop/test-results/phase2-runner-enrollment/auth-boundaries.png`
- `apps/desktop/test-results/phase2-runner-enrollment/capabilities-ready.png`
- `apps/desktop/test-results/phase2-runner-enrollment/disconnected.png`
- `apps/desktop/test-results/phase2-runner-enrollment/rotated-reconnected.png`
- `apps/desktop/test-results/phase2-runner-enrollment/revoked-setup.png`

Manual inspection confirmed the onboarding and engine rows are flat, compact, readable, and do not
show raw credentials or technical probe output.

## Durable Calendar AI completion

The full-suite audit exposed a pre-existing result-projection race: a durable job could become
`completed` immediately before its artifact or mission summary became visible. Calendar AI
previously returned a false empty result in that interval. The adapter now keeps polling within its
existing bounded deadline until the result becomes visible, and the Phase 6 test deterministically
holds that interval open for 350ms.

## Verification

- `npm run backend:check`: Pass
- `npm run typecheck`: Pass
- Desktop production build inside Phase 2 ETE: Pass
- `npm test`: Pass
  - Backend: 460/460
  - Desktop: 262/262
  - Runner: 29/29
  - Total: 751/751
- `git diff --check`: Pass

Known non-fatal output:

- Vite bundle warning: renderer chunk is about 598 kB, above the 500 kB advisory threshold.
- Desktop unit tests report an already occupied HMR WebSocket port 24678; tests still complete.

## External release boundary

This evidence uses injected AuthKit and provider capability adapters with the real production
Gateway, PostgreSQL, Electron, and Runner process. Live WorkOS tenant configuration and real
provider account logins remain staging/release gates and are not claimed by this evidence.
