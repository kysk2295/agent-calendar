# Agent Calendar Web

Agent Calendar의 공개 제품 소개, 다운로드 handoff와 개인정보·이용정책·지원 문서를
제공하는 vinext 기반 웹 앱입니다. 루트 [README](../../README.md)와
[권위 PRD](../../docs/PRD-agent-calendar-second-brain.md)의 제품 언어를 사용합니다.

이 화면은 캘린더, Second Brain, LLM Wiki와 에이전트 작업을 별도 도구 모음으로 소개하지
않습니다. `사용자를 이해하고 필요한 일을 실제로 수행한 뒤 결과를 기억하는 캘린더`라는
하나의 제품 흐름을 설명합니다.

## Prerequisites

- Node.js `>=22.13.0`

## 주요 화면

- `/`: 실제 Desktop 스크린샷을 사용하는 제품 랜딩
- `/privacy`: 개인정보와 데이터 경계
- `/terms`: Private beta 이용정책
- `/support`: 지원과 운영 상태

공개 가입과 다운로드 링크는 서명된 handoff receipt가 검증될 때만 활성화됩니다. 설정이
없거나 검증에 실패하면 링크를 만들지 않고 Private beta 준비 상태를 표시합니다.

## 개발

```bash
npm install
npm run dev
npm run build
```

주요 파일:

- `app/page.tsx`: 제품 랜딩 구조와 문구
- `app/globals.css`: light/dark 공통 디자인 토큰과 반응형 레이아웃
- `app/privacy`, `app/terms`, `app/support`: 신뢰 문서
- `lib/signed-handoff.mjs`: 공개 handoff 서명 검증
- `public/product-*.png`: 실제 Desktop 제품 화면
- `tests/`: SSR, handoff, anti-slop, 프로덕션/로컬 QA 격리 계약

## Workspace Auth Headers

OpenAI workspace sites can read the current user's email from
`oai-authenticated-user-email`.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## 선택적 ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## 검증

- `npm run dev`: 로컬 UI 개발
- `npm run build`: vinext production build
- `npm test`: build 후 SSR, handoff와 UI 계약 검증
- `npm run lint`: ESLint
- `npm run db:generate`: schema 변경 시 Drizzle migration 생성

로컬 화면은 개발 피드백 용도이며 프로덕션 제품 증거가 아닙니다. 공개 handoff와 최종 랜딩
검증은 실제 배포 환경에서 수행합니다.

## 기반 기술

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
