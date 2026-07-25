-- Phase 4 root audit: OAuth state, credential vault refs, durable sync outbox.
-- Tokens live only in calendar_credential_vault (or external vault via adapter); never on calendar_sources.

create table if not exists calendar_credential_vault (
  credential_ref text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  provider text not null default 'google',
  access_token_enc text not null default '',
  refresh_token_enc text not null default '',
  access_expires_at timestamptz,
  token_type text not null default 'Bearer',
  scope text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, credential_ref)
);

create table if not exists calendar_oauth_states (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  state text not null,
  code_verifier_digest text not null default '',
  code_verifier_enc text not null default '',
  redirect_uri text not null default '',
  expires_at timestamptz not null,
  consumed_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, state)
);

create table if not exists calendar_sync_requests (
  id text primary key,
  workspace_id text not null,
  source_id text not null,
  reason text not null default 'poll'
    check (reason in ('poll', 'webhook', 'manual', 'watch_renew', 'full')),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'failed', 'dead')),
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  channel_id text not null default '',
  resource_id text not null default '',
  error_code text not null default '',
  error_message text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, source_id)
    references calendar_sources (workspace_id, id) on delete cascade
);

create index if not exists calendar_sync_requests_drain_idx
  on calendar_sync_requests (status, next_attempt_at, created_at);

alter table calendar_sources
  add column if not exists watch_channel_id text not null default '',
  add column if not exists watch_expiration_at timestamptz;

alter table calendar_watches
  add column if not exists updated_at timestamptz not null default now();

-- Allow submitted in-progress claim status for mutation fencing
do $$
begin
  alter table calendar_mutation_receipts drop constraint if exists calendar_mutation_receipts_status_check;
  alter table calendar_mutation_receipts
    add constraint calendar_mutation_receipts_status_check
    check (status in ('pending', 'submitted', 'reconciled', 'conflict', 'failed'));
exception when others then
  null;
end $$;

-- RLS
alter table calendar_credential_vault enable row level security;
alter table calendar_credential_vault force row level security;
alter table calendar_oauth_states enable row level security;
alter table calendar_oauth_states force row level security;
alter table calendar_sync_requests enable row level security;
alter table calendar_sync_requests force row level security;

drop policy if exists calendar_credential_vault_workspace on calendar_credential_vault;
create policy calendar_credential_vault_workspace on calendar_credential_vault
  using (workspace_id = current_setting('app.workspace_id', true))
  with check (workspace_id = current_setting('app.workspace_id', true));

drop policy if exists calendar_oauth_states_workspace on calendar_oauth_states;
create policy calendar_oauth_states_workspace on calendar_oauth_states
  using (workspace_id = current_setting('app.workspace_id', true))
  with check (workspace_id = current_setting('app.workspace_id', true));

drop policy if exists calendar_sync_requests_workspace on calendar_sync_requests;
create policy calendar_sync_requests_workspace on calendar_sync_requests
  using (workspace_id = current_setting('app.workspace_id', true))
  with check (workspace_id = current_setting('app.workspace_id', true));

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_calendar_app') then
    -- Vault ciphertext is service/superuser-only. Default privileges must not expose it to app role.
    revoke all on table calendar_credential_vault from agent_calendar_app;
    -- OAuth states: app may insert/update/select within RLS for authorize flow, but
    -- code_verifier_enc must be AES ciphertext (never plaintext) — enforced in application layer.
    grant select, insert, update, delete on calendar_oauth_states to agent_calendar_app;
    grant select, insert, update, delete on calendar_sync_requests to agent_calendar_app;
  end if;
end $$;

-- Comment for operators: set GOOGLE_CREDENTIAL_ENCRYPTION_KEY (32-byte base64 or 64 hex)
-- or inject external credentialVault. Production OAuth fails closed without either.
comment on table calendar_credential_vault is
  'Encrypted Google OAuth tokens (aes-256-gcm). Service pool only; agent_calendar_app has NO grants.';
comment on column calendar_oauth_states.code_verifier_enc is
  'AES-GCM sealed PKCE verifier ciphertext; never plaintext.';
