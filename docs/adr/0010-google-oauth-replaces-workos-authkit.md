# Replace WorkOS AuthKit with Google OAuth as the identity adapter

- Date: 2026-07-29
- Status: Accepted
- Supersedes: the "User identity adapter: WorkOS AuthKit" decision in
  [ADR 0009](0009-provider-auth-calendar-signing-distribution.md) §2
- Related plan: [2026-07-29-runner-dependency-and-mobile-direction.md](../plans/2026-07-29-runner-dependency-and-mobile-direction.md)

## Context

ADR 0009 chose WorkOS AuthKit for hosted login UI, Google sign-in, and email magic
authentication without building mail or OAuth plumbing. That reasoning still holds on its own
terms, but the decision was never carried into a running deployment: `WORKOS_API_KEY` and
`WORKOS_CLIENT_ID` are absent, so production login has been impossible and no user has ever
signed in.

Re-examined at the point of actually configuring it, the trade changed:

- The features WorkOS adds beyond Google sign-in are magic-link email and future enterprise
  SSO. Neither is needed for a product with no users yet.
- WorkOS is the single blocker for deployment, and deployment blocks the mobile work that is
  the current product goal.
- The adapter boundary is two methods, so the migration cost is small now and stays small if
  enterprise SSO later justifies returning to a provider like WorkOS.

## Decision

| Choice | Decision |
| --- | --- |
| Identity provider adapter | **Google OAuth 2.0 directly** (`google-oauth-adapter.js`) |
| OAuth profile | Authorization Code + **PKCE (S256)** |
| Scopes | `openid`, `email`, `profile` — identity only |
| Redirect | **Gateway-hosted callback**, shared by Desktop, Web, and Mobile |
| Email trust | `email_verified !== true` is rejected as `GOOGLE_EMAIL_UNVERIFIED` |
| Product mapping | Google `sub` maps to Agent Calendar User, default Workspace, and Membership |
| Session authority | Unchanged — the gateway issues its own Workspace-scoped session and refresh tokens |
| WorkOS | Retained as a selectable adapter; Google wins when both are configured |

Rationale: Google proves identity and nothing more. Everything that grants product authority —
Workspace scope, sessions, RLS — already belongs to the gateway, so swapping the identity
provider does not move any security boundary.

### Custom URI schemes are not available

Google does not support custom URI scheme redirects; it supports loopback for desktop client
types and HTTPS for web client types. The existing `agent-calendar://auth/callback` redirect
therefore cannot be used with Google.

Loopback was rejected because a phone cannot run a loopback listener for a Google redirect, so
choosing it would mean building mobile authentication a second time. The gateway-hosted
callback works identically for Desktop, Web, and Mobile.

`desktopLoginRedirectUri()` resolves the redirect from the active adapter rather than a
constant, so WorkOS keeps the custom scheme it accepts.

### Google is not Runner enrollment

Unchanged from [ADR 0008](0008-bind-runners-to-authenticated-workspaces.md): a Google session
never becomes Runner authority, and a Runner credential never becomes a user session.

## Consequences

- Production login becomes possible once `GOOGLE_OAUTH_CLIENT_ID`,
  `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REDIRECT_URI` are set.
- Magic-link email login is dropped. Google account holders only.
- The consent screen lives in its own Google Cloud project (`agent-calendar-503908`) so the
  displayed app name is Agent Calendar rather than another product sharing the account.
- The app starts in Google testing mode: only listed test users can sign in and refresh tokens
  expire after seven days. Publishing and verification are required before real users.
- The desktop deep link `agent-calendar://auth/callback` stops being the login redirect. It
  remains in use for other deep links.

## Not decided here

The gateway callback route and the handoff that returns a session to the desktop after Google
redirects to the gateway are still to be implemented. Until then Google is configurable and
selected by the runtime, but the end-to-end desktop login journey still follows the WorkOS
shape.
