-- Phase 1: non-BYPASSRLS application role + FORCE RLS on product tables.
-- Policies use transaction-local current_setting('app.workspace_id', true).

do $$
begin
  create role agent_calendar_app nologin noinherit nobypassrls;
exception
  when duplicate_object then null;
end $$;

grant usage on schema public to agent_calendar_app;
grant select, insert, update, delete on all tables in schema public to agent_calendar_app;
grant usage, select on all sequences in schema public to agent_calendar_app;
alter default privileges in schema public grant select, insert, update, delete on tables to agent_calendar_app;
alter default privileges in schema public grant usage, select on sequences to agent_calendar_app;

-- Allow migration/superuser roles used in tests to SET ROLE into the app role.
do $$
begin
  execute format('grant agent_calendar_app to %I', current_user);
exception
  when undefined_object then null;
  when duplicate_object then null;
end $$;

-- Product tables with workspace_id: FORCE RLS + workspace isolation policy.
do $$
declare
  tbl text;
  tables text[] := array[
    'tasks', 'calendar_events', 'agents', 'runs', 'run_logs', 'chat_messages',
    'wiki_artifacts', 'scheduler_jobs', 'workboard_pages', 'documents', 'wiki_chunks',
    'agent_missions', 'agent_sessions', 'agent_session_events', 'agent_reports',
    'state_meta', 'auth_sessions', 'auth_refresh_tokens', 'audit_events', 'idempotency_keys'
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

-- Identity tables: memberships visible only for active setting user/workspace pair (read membership).
alter table workspace_memberships enable row level security;
alter table workspace_memberships force row level security;
drop policy if exists workspace_memberships_self_isolation on workspace_memberships;
create policy workspace_memberships_self_isolation on workspace_memberships
  for all
  to agent_calendar_app
  using (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    and user_id = nullif(current_setting('app.user_id', true), '')
  )
  with check (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    and user_id = nullif(current_setting('app.user_id', true), '')
  );

-- users / workspaces / auth_identities: allow select of own row for app role under matching settings.
alter table users enable row level security;
alter table users force row level security;
drop policy if exists users_self_select on users;
create policy users_self_select on users
  for select
  to agent_calendar_app
  using (id = nullif(current_setting('app.user_id', true), ''));

alter table workspaces enable row level security;
alter table workspaces force row level security;
drop policy if exists workspaces_self_select on workspaces;
create policy workspaces_self_select on workspaces
  for select
  to agent_calendar_app
  using (id = nullif(current_setting('app.workspace_id', true), ''));

alter table auth_identities enable row level security;
alter table auth_identities force row level security;
drop policy if exists auth_identities_self_select on auth_identities;
create policy auth_identities_self_select on auth_identities
  for select
  to agent_calendar_app
  using (user_id = nullif(current_setting('app.user_id', true), ''));
