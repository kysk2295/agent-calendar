-- Phase 1: auth sessions (hashed rotating refresh), audit, workspace-scoped idempotency.

create table if not exists auth_sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  access_token_hash text not null,
  refresh_family_id text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists auth_refresh_tokens (
  id text primary key,
  session_id text not null references auth_sessions(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  token_hash text not null unique,
  family_id text not null,
  parent_id text,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists audit_events (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  actor_user_id text references users(id) on delete set null,
  action text not null default '',
  resource_type text not null default '',
  resource_id text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists idempotency_keys (
  workspace_id text not null references workspaces(id) on delete cascade,
  scope text not null default '',
  idempotency_key text not null,
  request_hash text not null default '',
  response_status integer,
  response_body jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  primary key (workspace_id, scope, idempotency_key)
);

create index if not exists auth_sessions_user_id_idx on auth_sessions (user_id);
create index if not exists auth_sessions_workspace_id_idx on auth_sessions (workspace_id);
create index if not exists auth_sessions_access_token_hash_idx on auth_sessions (access_token_hash);
create index if not exists auth_refresh_tokens_family_id_idx on auth_refresh_tokens (family_id);
create index if not exists auth_refresh_tokens_session_id_idx on auth_refresh_tokens (session_id);
create index if not exists audit_events_workspace_id_idx on audit_events (workspace_id);
create index if not exists audit_events_created_at_idx on audit_events (created_at);
