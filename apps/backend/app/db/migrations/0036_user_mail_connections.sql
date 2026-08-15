create table if not exists mail_connections (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  provider text not null default 'google'
    check (provider in ('google')),
  credential_ref text not null,
  status text not null default 'connected'
    check (status in ('connected', 'reauthorization_required', 'disconnected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, provider),
  foreign key (workspace_id, credential_ref)
    references calendar_credential_vault (workspace_id, credential_ref) on delete cascade
);

create index if not exists mail_connections_user_status_idx
  on mail_connections (workspace_id, user_id, status, updated_at desc);

alter table mail_connections enable row level security;
alter table mail_connections force row level security;

drop policy if exists mail_connections_user on mail_connections;
create policy mail_connections_user on mail_connections
  using (
    workspace_id = current_setting('app.workspace_id', true)
    and user_id = current_setting('app.user_id', true)
  )
  with check (
    workspace_id = current_setting('app.workspace_id', true)
    and user_id = current_setting('app.user_id', true)
  );

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_calendar_app') then
    grant select, insert, update, delete on mail_connections to agent_calendar_app;
  end if;
end $$;

comment on table mail_connections is
  'Per-user Gmail connector metadata. OAuth tokens remain encrypted in calendar_credential_vault.';
