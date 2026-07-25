# Phase 9 Web landing evidence

- Date: 2026-07-25 KST
- Scope: first production landing slice
- Access: owner-only
- Production URL: `https://agent-calendar-app.fond-koi-2054.chatgpt.site`
- Saved version: 1
- Source SHA: `7a343174a13b805fa4478670fd036a511d6f2539`

## Observed result

- The first viewport states the calendar-first product purpose and presents one unified weekly
  timeline rather than a fake control dashboard.
- The weekly scene distinguishes human schedule, Delegated Work, and Connected Automation without
  suggesting that agent work blocks the user's time.
- Calendar AI, Workspace-owned Runner, Work Conversation, and Codex/Claude/Grok/Hermes engine
  connections use the repository's product language.
- Signup remains `Private beta 준비 중`.
- Desktop download remains unavailable until HTTPS URL, stable version, SHA-256, and verified
  release proof are all present.
- No authenticated control-plane feature or user data is present.

## Verification

- `npm test`: build passed; 5/5 tests passed.
- `npm run lint`: passed.
- `npm audit --omit=dev --audit-level=high`: 0 production vulnerabilities.
- Browser viewport checks:
  - desktop: `1265px clientWidth === 1265px scrollWidth`
  - tablet: `753px clientWidth === 753px scrollWidth`
  - mobile: `360px clientWidth === 360px scrollWidth`
- Mobile uses the compact agenda representation and hides the five-column calendar.
- Skip navigation becomes visible on keyboard focus with a solid focus outline.
- Browser warning/error log: empty.
- Production deployment state: succeeded.
- Opening the production URL returned the owner-only `Sign in required` gate, confirming that the
  first deployment is not public.

## External gates still open

- Production identity signup URL.
- Developer ID notarized Desktop artifact, promoted release URL, version, and SHA-256.
- Reviewed Privacy, Terms, support, and public status surfaces.
- Explicit decision to change Sites access from owner-only to public.
