# Local WorkOS Production-Mode Dogfood

Use this path to run the local backend with real WorkOS authentication and
Workspace-scoped product handlers. It deliberately selects
`WORKSPACE_AUTH_MODE=production`; the generic `npm run backend:start` command
retains the library's legacy default for unit tests and compatibility work.

## Configure credentials

Run the interactive helper and keep the generated file local:

```bash
bash scripts/setup-workos-env.sh
```

The helper writes `.env.workos.local` with mode `0600`. The file contains the
WorkOS credentials and `WORKSPACE_AUTH_MODE=production`; it is ignored by Git.

## Start the backend

Provide the PostgreSQL database used for Workspace sessions and scoped product
data, then use the guarded startup command:

```bash
export DATABASE_URL="postgres://USER@127.0.0.1:5432/agent_calendar_local"
export PGSSLMODE=disable
export PORT=3000
npm run backend:start:workos
```

The command refuses to start if the WorkOS client ID, WorkOS API key, or
`DATABASE_URL` is missing. It does not print credential values.

## Verify fail-closed routing

Before login, representative product reads must return `401` with
`workspace_auth_required`:

```bash
curl -i http://127.0.0.1:3000/api/agents
curl -i http://127.0.0.1:3000/api/state
```

After Desktop login, the client sends its Workspace session as a Bearer token
and negotiates `client-v1`. `GET /api/agents` then returns only that Workspace's
agents; a new Workspace legitimately returns an empty `agents` array.

## Compatibility fallback

For an explicit legacy-only test, override the mode for that process:

```bash
WORKSPACE_AUTH_MODE=legacy npm run backend:start:workos
```

Do not use legacy mode as a production workaround: it restores unscoped gateway
handlers and synthetic fallback behavior. Reverting the helper/default requires
no data rollback because this cutover does not change schemas or stored meaning.

## Continue to the live external gate

This local startup path proves that production auth routing can run with real WorkOS
configuration; it does not by itself prove a live-tenant Desktop callback, Google
Calendar consent/sync, Runner QR enrollment, an honest empty Workspace, or a Mode A
execution. Use the ordered, secret-free
[`production-live-dogfood.md`](production-live-dogfood.md) checklist for those residual
operator gates. A local fixture or `WORKSPACE_AUTH_MODE=legacy` run must not be recorded
as that checklist's production evidence.
