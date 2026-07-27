alter table runner_connector_requests
  drop constraint if exists runner_connector_requests_kind_check;
alter table runner_connector_requests
  add constraint runner_connector_requests_kind_check
  check (kind in (
    'agent_catalog',
    'session_catalog',
    'automation_capabilities',
    'automation_list',
    'automation_mutation',
    'agent_builder_test'
  ));

create table if not exists agent_profile_versions (
  workspace_id text not null references workspaces(id) on delete cascade,
  agent_id text not null,
  profile_version integer not null check (profile_version > 0),
  profile_snapshot jsonb not null,
  test_evidence jsonb not null,
  activated_at timestamptz not null default now(),
  primary key (workspace_id, agent_id, profile_version),
  foreign key (workspace_id, agent_id)
    references agents (workspace_id, id) on delete cascade
);

create index if not exists agent_profile_versions_agent_idx
  on agent_profile_versions (workspace_id, agent_id, profile_version desc);

alter table agent_profile_versions enable row level security;
alter table agent_profile_versions force row level security;
drop policy if exists agent_profile_versions_workspace_isolation on agent_profile_versions;
create policy agent_profile_versions_workspace_isolation on agent_profile_versions
  for all
  to agent_calendar_app
  using (workspace_id = nullif(current_setting('app.workspace_id', true), ''))
  with check (workspace_id = nullif(current_setting('app.workspace_id', true), ''));

revoke all on agent_profile_versions from agent_calendar_app;
grant select, insert on agent_profile_versions to agent_calendar_app;
grant update on runner_connector_requests to agent_calendar_app;
