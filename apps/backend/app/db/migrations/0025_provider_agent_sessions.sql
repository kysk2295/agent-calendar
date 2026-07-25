create table if not exists runner_connector_requests (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  runner_id text not null,
  provider text not null
    check (provider in ('codex', 'claude', 'grok', 'hermes')),
  kind text not null default 'agent_catalog'
    check (kind in ('agent_catalog', 'session_catalog')),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  request jsonb not null default '{}'::jsonb,
  response jsonb not null default '{}'::jsonb,
  error_code text not null default '',
  error_message text not null default '',
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  started_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, runner_id)
    references runners (workspace_id, id) on delete cascade
);

create table if not exists provider_agent_sessions (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  agent_id text not null,
  runner_id text not null,
  work_conversation_id text not null,
  provider text not null
    check (provider in ('codex', 'claude', 'grok', 'hermes')),
  engine text not null
    check (engine in ('codex', 'claude', 'grok', 'hermes')),
  external_agent_id text not null default '',
  external_session_id text not null default '',
  status text not null default 'pending'
    check (status in (
      'pending', 'active', 'auth_required', 'missing', 'deleted',
      'quota_exhausted', 'unavailable', 'archived'
    )),
  title text not null default '',
  public_metadata jsonb not null default '{}'::jsonb,
  last_error_code text not null default '',
  last_error_message text not null default '',
  last_activity_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, work_conversation_id),
  foreign key (workspace_id, agent_id)
    references agents (workspace_id, id) on delete cascade,
  foreign key (workspace_id, runner_id)
    references runners (workspace_id, id) on delete restrict,
  foreign key (workspace_id, work_conversation_id)
    references agent_sessions (workspace_id, id) on delete cascade
);

create unique index if not exists provider_agent_sessions_external_unique_idx
  on provider_agent_sessions (workspace_id, provider, external_session_id)
  where external_session_id <> '';

alter table execution_jobs
  drop constraint if exists execution_jobs_workspace_id_mission_id_key;
alter table execution_jobs
  add column if not exists turn_index integer not null default 1;
alter table execution_jobs
  add column if not exists provider_session_id text;
alter table execution_jobs
  drop constraint if exists execution_jobs_provider_session_fk;
alter table execution_jobs
  add constraint execution_jobs_provider_session_fk
  foreign key (workspace_id, provider_session_id)
  references provider_agent_sessions (workspace_id, id)
  on delete set null (provider_session_id);

create unique index if not exists execution_jobs_mission_turn_unique_idx
  on execution_jobs (workspace_id, mission_id, turn_index);
create index if not exists execution_jobs_provider_session_idx
  on execution_jobs (workspace_id, provider_session_id, created_at);
create index if not exists runner_connector_requests_runner_pending_idx
  on runner_connector_requests (workspace_id, runner_id, status, created_at);
create index if not exists provider_agent_sessions_agent_activity_idx
  on provider_agent_sessions (workspace_id, agent_id, archived_at, last_activity_at desc);

do $$
declare
  tbl text;
  tables text[] := array[
    'runner_connector_requests',
    'provider_agent_sessions'
  ];
begin
  foreach tbl in array tables loop
    execute format('alter table %I enable row level security', tbl);
    execute format('alter table %I force row level security', tbl);
    execute format('drop policy if exists %I on %I', tbl || '_workspace_isolation', tbl);
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

revoke all on runner_connector_requests from agent_calendar_app;
revoke all on provider_agent_sessions from agent_calendar_app;

grant select, insert on runner_connector_requests to agent_calendar_app;
grant select, insert, update on provider_agent_sessions to agent_calendar_app;
