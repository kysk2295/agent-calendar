# Phase 9 Web trust pages evidence

- Date: 2026-07-25
- Scope: existing Agent Calendar Sites project
- Outcome: verified and deployed owner-only

## Product evidence

- Landing footer exposes `/privacy`, `/terms`, and `/support`.
- Privacy describes Workspace data, Calendar AI/Wiki AI scope, Runner identity, external
  processors, and the local execution-engine credential boundary.
- Terms describes private beta scope, user-owned Runner obligations, Approval Gates,
  prohibited use, and the absence of a public service-level commitment.
- Support directs beta participants to their invitation channel without inventing a public
  email address, ticket system, or status page.
- Every page is server rendered and remains meaningful without client JavaScript.

## Verification

- Expected RED:
  - footer link contract failed;
  - `/privacy` returned 404.
- `npm test`
  - result: production build passed;
  - result: 7/7 Web contracts passed.
- `npm run lint`
  - result: passed with no errors.
- `npm audit --omit=dev --audit-level=high`
  - result: 0 vulnerabilities.
- `git diff --check`
  - result: passed.
- In-app browser:
  - routes: `/`, `/privacy`, `/terms`, `/support`;
  - viewports: 1280x900, 768x900, 375x812;
  - result: 12/12 states had no horizontal overflow or horizontally clipped visible element;
  - result: every footer exposed the three trust routes;
  - result: zero browser warnings or errors.

## Deployment

- Project: existing `Agent Calendar` Sites project
- Access: custom owner-only; no group or public access added
- Source commit: `7e4a5987bfe3b0227eb0694ce87fed3714239617`
- Saved version: 2
- Production deployment: succeeded
- URL: `https://agent-calendar-app.fond-koi-2054.chatgpt.site`
- Access check: production URL presents the expected sign-in gate to an unauthenticated browser.

## Remaining external gates

- Final legal review and real operator identity/contact details
- Public support address and incident status page
- Production AuthKit signup URL
- Signed and notarized Desktop download plus checksum promotion
- Public access decision and custom domain
