-- Phase 1 foundation: User, Workspace, Membership + deterministic legacy personal owner.
-- Idempotent for migrate.js which replays every SQL file on each boot.

create table if not exists users (
  id text primary key,
  display_name text not null default '',
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists workspaces (
  id text primary key,
  name text not null default '',
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists workspace_memberships (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  role text not null default 'owner',
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, workspace_id)
);

create table if not exists auth_identities (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  provider text not null default '',
  provider_subject text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_subject)
);

create index if not exists workspace_memberships_user_id_idx
  on workspace_memberships (user_id);
create index if not exists workspace_memberships_workspace_id_idx
  on workspace_memberships (workspace_id);
create index if not exists auth_identities_user_id_idx
  on auth_identities (user_id);

-- Deterministic legacy identities for pre-Phase-1 personal deployment rows.
insert into users (id, display_name, status, payload)
values (
  'legacy-owner-user',
  'Legacy Owner',
  'active',
  jsonb_build_object('kind', 'legacy_personal_owner', 'phase', 'phase1_0008')
)
on conflict (id) do nothing;

insert into workspaces (id, name, status, payload)
values (
  'legacy-personal-workspace',
  'Legacy Personal Workspace',
  'active',
  jsonb_build_object('kind', 'legacy_personal_workspace', 'phase', 'phase1_0008')
)
on conflict (id) do nothing;

insert into workspace_memberships (id, user_id, workspace_id, role, status, payload)
values (
  'legacy-owner-membership',
  'legacy-owner-user',
  'legacy-personal-workspace',
  'owner',
  'active',
  jsonb_build_object('kind', 'legacy_owner_membership', 'phase', 'phase1_0008')
)
on conflict (id) do nothing;

insert into auth_identities (id, user_id, provider, provider_subject, payload)
values (
  'legacy-owner-local-identity',
  'legacy-owner-user',
  'legacy_local',
  'legacy-owner-user',
  jsonb_build_object('kind', 'legacy_local_identity', 'phase', 'phase1_0008')
)
on conflict (id) do nothing;
