create table if not exists agent_work_handoffs (
  id text primary key,
  workspace_id text not null,
  root_mission_id text not null,
  parent_handoff_id text,
  parent_task_id text not null default '',
  root_agent_id text not null,
  delegator_agent_id text not null,
  receiver_agent_id text not null,
  depth integer not null check (depth between 1 and 3),
  lineage text[] not null,
  effective_grants jsonb not null default '{"allow":[],"deny":[]}'::jsonb,
  effective_budget jsonb not null default '{}'::jsonb,
  status text not null default 'accepted'
    check (status in (
      'accepted', 'waiting_runner', 'running', 'completed', 'failed', 'cancelled'
    )),
  result_projection jsonb not null default '{}'::jsonb,
  cancellation_requested boolean not null default false,
  cancellation_reason text not null default '',
  client_request_id text not null,
  execution_job_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  terminal_at timestamptz,
  unique (workspace_id, id),
  unique (workspace_id, root_mission_id, client_request_id),
  unique (workspace_id, execution_job_id),
  foreign key (workspace_id, root_mission_id)
    references agent_missions (workspace_id, id) on delete cascade,
  foreign key (workspace_id, parent_handoff_id)
    references agent_work_handoffs (workspace_id, id) on delete cascade,
  foreign key (workspace_id, root_agent_id)
    references agents (workspace_id, id) on delete restrict,
  foreign key (workspace_id, delegator_agent_id)
    references agents (workspace_id, id) on delete restrict,
  foreign key (workspace_id, receiver_agent_id)
    references agents (workspace_id, id) on delete restrict,
  foreign key (workspace_id, execution_job_id)
    references execution_jobs (workspace_id, id) on delete cascade
);

create index if not exists agent_work_handoffs_graph_idx
  on agent_work_handoffs (
    workspace_id, root_mission_id, parent_handoff_id, created_at, id
  );

alter table provider_agent_sessions
  add column if not exists parent_provider_session_id text,
  add column if not exists session_generation integer not null default 0
    check (session_generation between 0 and 1000),
  add column if not exists session_lineage text[] not null default '{}'::text[],
  add column if not exists transition_action text not null default 'existing'
    check (transition_action in ('existing', 'import', 'rebind', 'new_session', 'fork'));

alter table provider_agent_sessions
  drop constraint if exists provider_agent_sessions_parent_fk;
alter table provider_agent_sessions
  add constraint provider_agent_sessions_parent_fk
  foreign key (workspace_id, parent_provider_session_id)
  references provider_agent_sessions (workspace_id, id)
  on delete restrict;

drop index if exists provider_agent_sessions_conversation_engine_runner_unique_idx;
create unique index if not exists provider_agent_sessions_conversation_engine_runner_generation_idx
  on provider_agent_sessions (
    workspace_id, work_conversation_id, engine, runner_id, session_generation
  );

create table if not exists provider_session_transitions (
  id text primary key,
  workspace_id text not null,
  mission_id text not null,
  work_conversation_id text not null,
  action text not null
    check (action in ('rebind', 'new_session', 'fork')),
  source_provider_session_id text,
  target_provider_session_id text not null,
  execution_job_id text not null,
  client_request_id text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, mission_id, client_request_id),
  unique (workspace_id, execution_job_id),
  foreign key (workspace_id, mission_id)
    references agent_missions (workspace_id, id) on delete cascade,
  foreign key (workspace_id, work_conversation_id)
    references agent_sessions (workspace_id, id) on delete cascade,
  foreign key (workspace_id, source_provider_session_id)
    references provider_agent_sessions (workspace_id, id) on delete restrict,
  foreign key (workspace_id, target_provider_session_id)
    references provider_agent_sessions (workspace_id, id) on delete restrict,
  foreign key (workspace_id, execution_job_id)
    references execution_jobs (workspace_id, id) on delete cascade
);

create table if not exists agent_work_current_results (
  workspace_id text not null,
  mission_id text not null,
  report_id text not null,
  selection_version bigint not null default 1,
  selected_at timestamptz not null default now(),
  primary key (workspace_id, mission_id),
  foreign key (workspace_id, mission_id)
    references agent_missions (workspace_id, id) on delete cascade,
  foreign key (workspace_id, report_id)
    references agent_reports (workspace_id, id) on delete restrict
);

create table if not exists agent_work_result_adoptions (
  id text primary key,
  workspace_id text not null,
  mission_id text not null,
  report_id text not null,
  previous_report_id text,
  selection_version bigint not null,
  outcome_summary jsonb not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, mission_id, selection_version),
  foreign key (workspace_id, mission_id)
    references agent_missions (workspace_id, id) on delete cascade,
  foreign key (workspace_id, report_id)
    references agent_reports (workspace_id, id) on delete restrict,
  foreign key (workspace_id, previous_report_id)
    references agent_reports (workspace_id, id) on delete restrict
);

create index if not exists provider_session_transitions_mission_idx
  on provider_session_transitions (workspace_id, mission_id, created_at, id);
create index if not exists agent_work_result_adoptions_mission_idx
  on agent_work_result_adoptions (
    workspace_id, mission_id, selection_version, created_at
  );

do $$
declare
  tbl text;
  tables text[] := array[
    'agent_work_handoffs',
    'provider_session_transitions',
    'agent_work_current_results',
    'agent_work_result_adoptions'
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

revoke all on agent_work_handoffs from agent_calendar_app;
revoke all on provider_session_transitions from agent_calendar_app;
revoke all on agent_work_current_results from agent_calendar_app;
revoke all on agent_work_result_adoptions from agent_calendar_app;

grant select, insert, update on agent_work_handoffs to agent_calendar_app;
grant select, insert on provider_session_transitions to agent_calendar_app;
grant select, insert, update on agent_work_current_results to agent_calendar_app;
grant select, insert on agent_work_result_adoptions to agent_calendar_app;
