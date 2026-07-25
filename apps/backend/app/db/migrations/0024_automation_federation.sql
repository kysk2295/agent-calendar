create table if not exists automation_sources (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  runner_id text,
  adapter_kind text not null,
  display_name text not null,
  status text not null default 'connected'
    check (status in ('connected', 'disconnected', 'stale', 'error')),
  capabilities jsonb not null default '{}'::jsonb,
  connection_ref jsonb not null default '{}'::jsonb,
  source_revision text not null default '',
  last_synced_at timestamptz,
  stale_after timestamptz,
  created_by_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table if not exists connected_automations (
  id text primary key,
  workspace_id text not null,
  source_id text not null,
  external_id text not null,
  name text not null,
  goal text not null default '',
  agent_id text not null default '',
  schedule text not null default '',
  status text not null default 'unknown'
    check (status in ('active', 'paused', 'failed', 'unknown')),
  enabled boolean,
  source_revision text not null default '',
  capabilities jsonb not null default '{}'::jsonb,
  projection jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz not null default now(),
  stale_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, source_id, external_id),
  foreign key (workspace_id, source_id)
    references automation_sources (workspace_id, id) on delete cascade
);

create table if not exists automation_changes (
  id text primary key,
  workspace_id text not null,
  source_id text not null,
  automation_id text,
  operation text not null
    check (operation in ('create', 'update', 'pause', 'resume', 'run')),
  status text not null default 'pending'
    check (status in (
      'pending', 'pending_approval', 'applying', 'succeeded',
      'failed', 'unknown', 'conflict', 'cancelled'
    )),
  client_request_id text not null,
  expected_revision text not null default '',
  input jsonb not null default '{}'::jsonb,
  policy jsonb not null default '{}'::jsonb,
  approved_by_user_id text,
  approved_at timestamptz,
  completed_at timestamptz,
  created_by_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, client_request_id),
  foreign key (workspace_id, source_id)
    references automation_sources (workspace_id, id) on delete cascade,
  foreign key (workspace_id, automation_id)
    references connected_automations (workspace_id, id) on delete set null
);

create table if not exists automation_change_receipts (
  id text primary key,
  workspace_id text not null,
  change_id text not null,
  source_id text not null,
  automation_id text,
  operation text not null,
  status text not null
    check (status in ('succeeded', 'failed', 'unknown', 'conflict')),
  source_revision text not null default '',
  external_id text not null default '',
  result jsonb not null default '{}'::jsonb,
  error_code text not null default '',
  error_message text not null default '',
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, change_id),
  foreign key (workspace_id, change_id)
    references automation_changes (workspace_id, id) on delete cascade,
  foreign key (workspace_id, source_id)
    references automation_sources (workspace_id, id) on delete cascade,
  foreign key (workspace_id, automation_id)
    references connected_automations (workspace_id, id) on delete set null
);

create table if not exists automation_occurrences (
  id text primary key,
  workspace_id text not null,
  source_id text not null,
  automation_id text not null,
  external_occurrence_id text not null,
  scheduled_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'unknown')),
  source_revision text not null default '',
  result jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, source_id, external_occurrence_id),
  foreign key (workspace_id, source_id)
    references automation_sources (workspace_id, id) on delete cascade,
  foreign key (workspace_id, automation_id)
    references connected_automations (workspace_id, id) on delete cascade
);

create table if not exists automation_sync_cursors (
  id text primary key,
  workspace_id text not null,
  source_id text not null,
  cursor text not null default '',
  source_revision text not null default '',
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error_code text not null default '',
  last_error_message text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, source_id),
  foreign key (workspace_id, source_id)
    references automation_sources (workspace_id, id) on delete cascade
);

create index if not exists automation_sources_status_idx
  on automation_sources (workspace_id, status, updated_at desc);
create index if not exists connected_automations_source_idx
  on connected_automations (workspace_id, source_id, status, name);
create index if not exists automation_changes_created_idx
  on automation_changes (workspace_id, created_at desc);
create index if not exists automation_occurrences_range_idx
  on automation_occurrences (workspace_id, scheduled_at, source_id);

alter table calendar_ai_action_drafts
  drop constraint if exists calendar_ai_action_drafts_action_kind_check;
alter table calendar_ai_action_drafts
  add constraint calendar_ai_action_drafts_action_kind_check
  check (action_kind in (
    'calendar_create',
    'calendar_update',
    'calendar_delete',
    'delegate_work',
    'automation_change'
  ));

alter table calendar_ai_action_drafts
  drop constraint if exists calendar_ai_action_drafts_status_check;
alter table calendar_ai_action_drafts
  add constraint calendar_ai_action_drafts_status_check
  check (status in (
    'pending_approval',
    'approved',
    'executing',
    'completed',
    'failed',
    'unknown',
    'conflict',
    'cancelled'
  ));

alter table calendar_ai_action_receipts
  drop constraint if exists calendar_ai_action_receipts_status_check;
alter table calendar_ai_action_receipts
  add constraint calendar_ai_action_receipts_status_check
  check (status in ('succeeded', 'failed', 'unknown', 'conflict'));

do $$
declare
  t text;
  tables text[] := array[
    'automation_sources',
    'connected_automations',
    'automation_changes',
    'automation_change_receipts',
    'automation_occurrences',
    'automation_sync_cursors'
  ];
begin
  foreach t in array tables loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists %I on %I', t || '_workspace', t);
    execute format(
      'create policy %I on %I using (workspace_id = current_setting(''app.workspace_id'', true)) with check (workspace_id = current_setting(''app.workspace_id'', true))',
      t || '_workspace', t
    );
  end loop;
end $$;

do $$
declare
  t text;
  tables text[] := array[
    'automation_sources',
    'connected_automations',
    'automation_changes',
    'automation_change_receipts',
    'automation_occurrences',
    'automation_sync_cursors'
  ];
begin
  if exists (select 1 from pg_roles where rolname = 'agent_calendar_app') then
    foreach t in array tables loop
      execute format('grant select, insert, update, delete on %I to agent_calendar_app', t);
    end loop;
  end if;
end $$;
