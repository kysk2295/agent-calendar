-- Phase 2: account-bound Runner enrollment, pending device, credentials, sessions, nonces.
-- Never store plaintext challenge, claim token, or device credential.
-- Secret hashes live only in service-only tables (no SELECT grant to agent_calendar_app).
-- One Runner belongs exactly one Workspace; Workspace may own multiple Runners.

create table if not exists runner_enrollment_challenges (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  owner_user_id text not null references users(id) on delete cascade,
  human_code_display text not null default '',
  protocol_version integer not null default 1,
  status text not null default 'issued'
    check (status in ('issued', 'consumed', 'expired', 'replaced')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  replaced_by text,
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);

-- Drop draft-era secret columns if a prior 0017 shape left them on public tables.
alter table runner_enrollment_challenges drop column if exists challenge_hash;

create table if not exists runners (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  enrollment_challenge_id text,
  status text not null default 'pending'
    check (status in ('pending', 'active', 'rejected', 'revoked')),
  device_public_key text not null default '',
  fingerprint_sha256 text not null default '',
  host_metadata jsonb not null default '{}'::jsonb,
  protocol_version integer not null default 1,
  runner_version text not null default '',
  credential_version integer not null default 0,
  connection_state text not null default 'disconnected'
    check (connection_state in ('disconnected', 'connected', 'reconnecting', 'revoked')),
  last_seen_at timestamptz,
  connected_at timestamptz,
  capabilities jsonb not null default '{}'::jsonb,
  last_test_at timestamptz,
  last_test_ok boolean,
  last_test_message text not null default '',
  active_session_id text,
  active_cursor bigint not null default 0,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, enrollment_challenge_id)
    references runner_enrollment_challenges (workspace_id, id)
    on delete set null
);

alter table runners drop column if exists credential_hash;

create table if not exists runner_pending_claims (
  id text primary key,
  runner_id text not null,
  workspace_id text not null,
  status text not null default 'pending'
    check (status in ('pending', 'confirmable', 'claimed', 'rejected', 'expired')),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, runner_id)
    references runners (workspace_id, id)
    on delete cascade
);

alter table runner_pending_claims drop column if exists claim_token_hash;

create table if not exists runner_sessions (
  id text primary key,
  runner_id text not null,
  workspace_id text not null,
  protocol_version integer not null default 1,
  cursor bigint not null default 0,
  fenced_at timestamptz,
  connected_at timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, runner_id)
    references runners (workspace_id, id)
    on delete cascade
);

alter table runner_sessions drop column if exists session_token_hash;

-- Service-only secret tables: hashes never granted to agent_calendar_app.
create table if not exists runner_enrollment_challenge_secrets (
  challenge_id text not null,
  workspace_id text not null,
  challenge_hash text not null,
  created_at timestamptz not null default now(),
  primary key (challenge_id),
  unique (workspace_id, challenge_id),
  foreign key (workspace_id, challenge_id)
    references runner_enrollment_challenges (workspace_id, id)
    on delete cascade
);

create table if not exists runner_credential_secrets (
  runner_id text not null,
  workspace_id text not null,
  credential_hash text not null,
  credential_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (runner_id),
  unique (workspace_id, runner_id),
  foreign key (workspace_id, runner_id)
    references runners (workspace_id, id)
    on delete cascade
);

create table if not exists runner_claim_secrets (
  claim_id text not null,
  runner_id text not null,
  workspace_id text not null,
  claim_token_hash text not null,
  created_at timestamptz not null default now(),
  primary key (claim_id),
  unique (claim_token_hash),
  unique (workspace_id, claim_id),
  foreign key (workspace_id, claim_id)
    references runner_pending_claims (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, runner_id)
    references runners (workspace_id, id)
    on delete cascade
);

create table if not exists runner_session_secrets (
  session_id text not null,
  runner_id text not null,
  workspace_id text not null,
  session_token_hash text not null,
  created_at timestamptz not null default now(),
  primary key (session_id),
  unique (workspace_id, session_id),
  foreign key (workspace_id, session_id)
    references runner_sessions (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, runner_id)
    references runners (workspace_id, id)
    on delete cascade
);

create table if not exists runner_request_nonces (
  runner_id text not null,
  nonce text not null,
  used_at timestamptz not null default now(),
  primary key (runner_id, nonce)
);

create table if not exists runner_connection_events (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  runner_id text,
  actor_user_id text references users(id) on delete set null,
  event_type text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists runner_enrollment_challenges_workspace_status_idx
  on runner_enrollment_challenges (workspace_id, status);
create index if not exists runner_enrollment_challenges_expires_at_idx
  on runner_enrollment_challenges (expires_at)
  where status = 'issued';
create index if not exists runners_workspace_status_idx
  on runners (workspace_id, status);
create index if not exists runners_fingerprint_idx
  on runners (fingerprint_sha256);
create index if not exists runner_pending_claims_runner_idx
  on runner_pending_claims (runner_id, status);
create index if not exists runner_pending_claims_expires_at_idx
  on runner_pending_claims (expires_at)
  where status in ('pending', 'confirmable');
create index if not exists runner_sessions_runner_idx
  on runner_sessions (runner_id);
create index if not exists runner_request_nonces_used_at_idx
  on runner_request_nonces (used_at);
create index if not exists runner_connection_events_workspace_idx
  on runner_connection_events (workspace_id, created_at);
create index if not exists runner_enrollment_challenge_secrets_workspace_idx
  on runner_enrollment_challenge_secrets (workspace_id);
create index if not exists runner_credential_secrets_workspace_idx
  on runner_credential_secrets (workspace_id);
create index if not exists runner_claim_secrets_runner_idx
  on runner_claim_secrets (runner_id);
create index if not exists runner_session_secrets_runner_idx
  on runner_session_secrets (runner_id);

-- Public control-plane tables: FORCE RLS for app-role Workspace reads.
do $$
declare
  tbl text;
  tables text[] := array[
    'runner_enrollment_challenges',
    'runners',
    'runner_pending_claims',
    'runner_sessions',
    'runner_connection_events'
  ];
begin
  foreach tbl in array tables loop
    execute format('alter table %I enable row level security', tbl);
    execute format('alter table %I force row level security', tbl);
    begin
      execute format('drop policy if exists %I on %I', tbl || '_workspace_isolation', tbl);
    exception
      when undefined_object then null;
    end;
    execute format(
      'create policy %I on %I
         for all
         to agent_calendar_app
         using (workspace_id = nullif(current_setting(''app.workspace_id'', true), ''''))
         with check (workspace_id = nullif(current_setting(''app.workspace_id'', true), ''''))',
      tbl || '_workspace_isolation',
      tbl
    );
  end loop;
end $$;

-- Service-only secret tables + nonces: FORCE RLS deny-all for agent_calendar_app; no grants.
do $$
declare
  tbl text;
  tables text[] := array[
    'runner_enrollment_challenge_secrets',
    'runner_credential_secrets',
    'runner_claim_secrets',
    'runner_session_secrets',
    'runner_request_nonces'
  ];
begin
  foreach tbl in array tables loop
    execute format('alter table %I enable row level security', tbl);
    execute format('alter table %I force row level security', tbl);
    begin
      execute format('drop policy if exists %I on %I', tbl || '_deny_app', tbl);
    exception
      when undefined_object then null;
    end;
    execute format(
      'create policy %I on %I
         for all
         to agent_calendar_app
         using (false)
         with check (false)',
      tbl || '_deny_app',
      tbl
    );
  end loop;
end $$;

grant select, insert, update, delete on runner_enrollment_challenges to agent_calendar_app;
grant select, insert, update, delete on runners to agent_calendar_app;
grant select, insert, update, delete on runner_pending_claims to agent_calendar_app;
grant select, insert, update, delete on runner_sessions to agent_calendar_app;
grant select, insert, update, delete on runner_connection_events to agent_calendar_app;

-- Explicitly revoke any prior grants on secret tables (idempotent harden).
-- Also revoke from PUBLIC in case default privileges re-opened SELECT.
revoke all on table runner_enrollment_challenge_secrets from public, agent_calendar_app;
revoke all on table runner_credential_secrets from public, agent_calendar_app;
revoke all on table runner_claim_secrets from public, agent_calendar_app;
revoke all on table runner_session_secrets from public, agent_calendar_app;
revoke all on table runner_request_nonces from public, agent_calendar_app;

-- Re-assert FORCE RLS after grants (table owners still subject).
alter table runner_enrollment_challenge_secrets force row level security;
alter table runner_credential_secrets force row level security;
alter table runner_claim_secrets force row level security;
alter table runner_session_secrets force row level security;
alter table runner_request_nonces force row level security;
