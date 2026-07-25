-- Phase 1: durable one-use Desktop AuthKit login transactions.
-- Store only hashed state and hashed PKCE verifier; never authorization codes.
-- Idempotent for migrate.js which replays every SQL file on each boot.

create table if not exists desktop_login_transactions (
  id text primary key,
  state_hash text not null,
  verifier_hash text not null,
  redirect_uri text not null,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'failed', 'expired')),
  expires_at timestamptz not null,
  completed_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists desktop_login_transactions_pending_state_hash_uidx
  on desktop_login_transactions (state_hash)
  where status = 'pending';

create index if not exists desktop_login_transactions_status_expires_idx
  on desktop_login_transactions (status, expires_at);

-- Opaque workspace-selection transactions for multi-membership operators.
create table if not exists desktop_workspace_selection_transactions (
  id text primary key,
  token_hash text not null unique,
  user_id text not null references users(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'failed', 'expired')),
  expires_at timestamptz not null,
  completed_at timestamptz,
  selected_workspace_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists desktop_workspace_selection_user_status_idx
  on desktop_workspace_selection_transactions (user_id, status);
