# Provider, auth, first calendar, signing, and distribution for private beta

- Date: 2026-07-24
- Status: Accepted (implementation deferred to Phase 1+)
- Parent design: `docs/plans/2026-07-24-production-agent-calendar-platform.md`
- Parent roadmap: `docs/plans/2026-07-24-production-development-roadmap.md`
- Child plan: `docs/plans/2026-07-24-phase0-provider-auth-signing-orca-decisions.md`
- Related: `docs/adr/0008-bind-runners-to-authenticated-workspaces.md`
- Orca reference: `docs/references/orca-runner-setup-reference-2026-07-24.md`

## Context

Phase 0 Story 4 must freeze provider and distribution choices before multi-tenant auth (Phase 1), account-bound Runner Enrollment (Phase 2), first external calendar (Phase 4), and signed Desktop distribution (Phases 8–9). Product identity remains calendar-first; customer hosts own compute and AI provider accounts; the control plane never treats a pairing link or Runner device as user login.

## Decisions

### 1. Control plane and data plane through private beta

| Choice | Decision |
| --- | --- |
| Control plane host | **Railway** application process (gateway / workers) |
| Primary database | **Railway PostgreSQL** |
| Environment split | **Separate staging and production** Railway projects (or equivalent hard isolation) with **separate PostgreSQL instances** |
| Duration | Through **private beta** (revisit only after Phase 10 ops gates, not mid-migration) |

Rationale: current personal deployment already runs on Railway; freeze host and DB family so Phase 1 Workspace/RLS work is not coupled to a platform migration. Staging must not share production secrets or row data.

Non-goals for this decision:

- Do not migrate control plane off Railway during Phase 0–10 unless an explicit new ADR supersedes this one.
- Do not use a shared staging/prod database “with different schemas.”

### 2. User identity adapter: WorkOS AuthKit

| Choice | Decision |
| --- | --- |
| Identity provider adapter | **WorkOS AuthKit** |
| Desktop UX | **Hosted system-browser login** (OS browser or system auth session), not an embedded webview credential form as the primary path |
| OAuth profile | **Authorization Code + PKCE** for Desktop |
| First authentication methods | **Google OAuth** and **email magic authentication** |
| Product mapping | Backend maps the WorkOS (provider) **subject** to Agent Calendar **User**, default **Workspace**, and **Membership** rows |
| Session authority | Agent Calendar issues its own Workspace-scoped session/refresh tokens after successful IdP login; WorkOS is not queried on every product API call as the sole authorization source |

Rationale: WorkOS AuthKit provides hosted UI, Google + magic link without inventing mail/OAuth plumbing, and a clear subject identifier for membership mapping. PKCE is required for public Desktop clients.

#### Runner is not WorkOS login

Runner Enrollment remains **Agent Calendar’s own device protocol** (see ADR 0008):

- short-lived, one-use enrollment challenge / QR;
- runner-local device key;
- pending identity + owner fingerprint confirmation;
- separately revocable device credential.

**Never** treat WorkOS user sessions, WorkOS device management, or IdP “remembered devices” as Runner enrollment or runtime authority. A Runner cannot recover a User password, and a User session cannot become a Runner secret.

### 3. First external calendar connector

| Choice | Decision |
| --- | --- |
| First external calendar | **Google Calendar** |
| Later providers | Explicit follow-on ADRs / Phase 4 capability matrix (Apple Calendar, Outlook, etc. deferred) |

Rationale: matches first auth method (Google OAuth) so the same Google account consent path can be designed for calendar scopes with clear separation between identity scopes and calendar scopes. Human events remain source-truth in the connector Adapter; Unified Calendar projects them without making Google the product identity root for non-Google users (magic-email users connect Google Calendar later as a connector grant).

### 4. Desktop and Runner packaging, signing, distribution

| Choice | Decision |
| --- | --- |
| First Desktop platform | **macOS Apple Silicon** first |
| Code signing | **Apple Developer ID Application** signing |
| Gatekeeper | **Notarization** required for public Desktop and Runner artifacts |
| Build tooling | **electron-builder** producing **DMG** and **ZIP** |
| CI | **GitHub Actions** builds and uploads to **draft GitHub Releases** |
| Integrity | Publish **SHA-256** digests per artifact |
| Supply chain | Produce **SBOM** and build **provenance** attestations for release candidates |
| Channel | **Staged stable manifests** (not auto-force every client to latest) |
| Rollback | **Halt rollout**; ship the **prior known-good commit** as a **higher patch** version on the stable channel |
| Runner package | **Signed and notarized separately** from the Desktop app (distinct product ID / entitlement surface as required) |

Rationale: Apple Silicon Desktop is the primary product surface; Developer ID + notarization is the trustworthy macOS distribution path. Draft GitHub Releases keep pre-stable artifacts out of “latest” until human promotion. Separate Runner signing prevents Desktop update channels from silently replacing execution-host trust material.

### 5. Secrets and external prerequisites (not in repo)

The following are **external operational prerequisites**. Store only in vendor consoles, password managers, and CI secret stores. **Never commit values** to this repository, evidence JSON, or plans.

| Prerequisite | Purpose | Where values live |
| --- | --- | --- |
| Railway staging project + env | Staging control plane | Railway dashboard / CI secrets |
| Railway production project + env | Production control plane | Railway dashboard / CI secrets |
| Railway staging PostgreSQL | Staging data | Railway / secret store |
| Railway production PostgreSQL | Production data | Railway / secret store |
| WorkOS AuthKit environment(s) | User login | WorkOS dashboard / CI secrets |
| WorkOS client IDs / API keys | AuthKit integration | Secret store (names only in docs) |
| Google OAuth client (AuthKit-linked) | Google sign-in | Google Cloud + WorkOS |
| Google Calendar API enablement + OAuth consent | First calendar connector | Google Cloud console |
| Apple Developer Program membership | Signing identity | Apple Developer account |
| Developer ID Application certificate + private key | Desktop/Runner sign | Hardware-backed key / CI notarization path |
| App-specific notarization credentials (API key or equivalent) | `notarytool` | CI secrets |
| GitHub Actions environment secrets | Release pipeline | GitHub environment secrets |
| GitHub Releases permissions | Draft release upload | GitHub App / token in CI |

Rotation of any previously exposed credentials from older personal-beta evidence remains a **separate Phase 0 exit-gate operations task** and is **not** completed by this ADR alone.

## Consequences

### Positive

- Phase 1 can implement User/Workspace/Membership against a named IdP adapter without reopening platform choice.
- Phase 2 Runner Setup can follow the Orca progressive-disclosure UX while keeping account-first, owner-confirmed enrollment (ADR 0008 + Orca reference).
- Phase 4 can implement Google Calendar without debating “first connector.”
- Phases 8–9 have a concrete signing and rollback story before Web download pages go live.

### Negative / constraints

- WorkOS and Google become critical path external dependencies; fake Adapters are required in tests.
- Magic-email users need an explicit calendar-connect step for Google Calendar.
- Apple Silicon-first delays Intel macOS and Windows/Linux Desktop.
- Separate Runner notarization increases release pipeline cost but preserves trust boundaries.

### Explicit rejections

- Reject global bearer tokens as production user auth.
- Reject pairing URL / QR / enrollment code as ongoing user authentication (ADR 0008).
- Reject **Orca-style permission-bypass defaults** (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, and equivalents) as Agent Calendar Runner defaults — see Orca reference adopt/deviate table.
- Reject **raw reusable pairing-link authority** as product enrollment: Agent Calendar uses short-lived one-use challenges bound to an already-authenticated Workspace owner confirmation.

## Implementation notes (non-normative for this ADR file)

- Desktop AuthKit flow: open system browser → AuthKit hosted login → Authorization Code + PKCE → backend token exchange → map subject → issue Agent Calendar session → Desktop stores refresh material in OS secure storage.
- Google Calendar connector uses its own OAuth grant and refresh lifecycle under WorkspaceScope; do not overload the login ID token as the only calendar credential.
- Release rollback never rewrites history of a promoted version; always cut a new higher patch from known-good source.

## Supersedes / related

- Does not supersede ADR 0008 (Runner ↔ Workspace binding).
- Satisfies Phase 0 Story 4 decision packet required by the production roadmap Definition of Ready for provider, auth, first calendar, signing, distribution, and Orca reference linkage.
