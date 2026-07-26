-- Phase 4 second root audit: sync claim lease, webhook idempotency key, service-owned grants.

alter table calendar_sync_requests
  add column if not exists idempotency_key text not null default '',
  add column if not exists claimed_at timestamptz,
  add column if not exists lease_expires_at timestamptz;

-- Unique webhook/poll key per workspace (empty keys allowed multiple via partial index)
create unique index if not exists calendar_sync_requests_ws_idem_uidx
  on calendar_sync_requests (workspace_id, idempotency_key)
  where idempotency_key <> '';

create index if not exists calendar_sync_requests_lease_idx
  on calendar_sync_requests (status, lease_expires_at)
  where status = 'running';

-- Service-owned internal tables: revoke broad app-role DML (server uses owner/service pool).
-- Why no app-role grants:
--   calendar_oauth_states  — PKCE verifier ciphertext + OAuth CSRF state; only authorize/callback
--                            service paths (pool owner) may INSERT/SELECT/UPDATE. Workspace RLS alone
--                            is insufficient because same-workspace hostile users must not read/consume
--                            another user's state rows via app-role DML.
--   calendar_sync_requests — webhook/outbox claim/lease rows; drain workers and webhook handlers use
--                            service pool with SKIP LOCKED claims. App role must not enqueue/claim.
--   calendar_credential_vault — AES-GCM sealed tokens; never SELECT/INSERT via app role.
-- Server code paths: unified-calendar.js startGoogleAuthorize/finalizeGoogleOAuth/handleGoogleWebhook/
-- drainSyncRequests use this.pool (owner), not withAppRoleWorkspaceTransaction.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_calendar_app') then
    revoke all on table calendar_credential_vault from agent_calendar_app;
    revoke all on table calendar_oauth_states from agent_calendar_app;
    revoke all on table calendar_sync_requests from agent_calendar_app;
    -- Explicit deny of table privileges (idempotent)
    execute 'revoke select, insert, update, delete on table calendar_oauth_states from agent_calendar_app';
    execute 'revoke select, insert, update, delete on table calendar_sync_requests from agent_calendar_app';
    execute 'revoke select, insert, update, delete on table calendar_credential_vault from agent_calendar_app';
  end if;
end $$;

comment on table calendar_oauth_states is
  'Service-owned OAuth CSRF+PKCE state. No agent_calendar_app grants; server pool only. Bound to workspace_id+user_id+state.';
comment on table calendar_sync_requests is
  'Service-owned sync outbox. No agent_calendar_app grants; server pool drain/webhook only.';

comment on column calendar_sync_requests.idempotency_key is
  'Webhook: channelId + X-Goog-Message-Number; empty for non-idempotent poll rows';
comment on column calendar_sync_requests.lease_expires_at is
  'Claim lease for drain workers; stale running reclaimed after expiry';
