-- Phase 1: expand remaining product tables with workspace ownership.
-- Idempotent expand → backfill → NOT NULL → FK/indexes.

do $$
declare
  tbl text;
  tables text[] := array[
    'agents',
    'runs',
    'run_logs',
    'chat_messages',
    'wiki_artifacts',
    'scheduler_jobs',
    'workboard_pages',
    'documents',
    'wiki_chunks',
    'agent_missions',
    'agent_sessions',
    'agent_session_events',
    'agent_reports',
    'state_meta'
  ];
begin
  foreach tbl in array tables loop
    execute format('alter table %I add column if not exists workspace_id text', tbl);
    execute format(
      'update %I set workspace_id = %L where workspace_id is null or btrim(workspace_id) = ''''',
      tbl,
      'legacy-personal-workspace'
    );
    execute format('alter table %I alter column workspace_id set default %L', tbl, 'legacy-personal-workspace');
    execute format('alter table %I alter column workspace_id set not null', tbl);
  end loop;
end $$;

-- state_meta: move to composite primary key (workspace_id, key) so keys are Workspace-scoped.
do $$
begin
  if exists (
    select 1 from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'public' and r.relname = 'state_meta' and c.conname = 'state_meta_pkey'
      and pg_get_constraintdef(c.oid) not ilike '%workspace_id%'
  ) then
    alter table state_meta drop constraint state_meta_pkey;
  end if;
exception
  when undefined_object then null;
end $$;

do $$
begin
  alter table state_meta add primary key (workspace_id, key);
exception
  when invalid_table_definition then null;
  when duplicate_object then null;
  when object_not_in_prerequisite_state then null;
end $$;

-- FKs to workspaces + composite uniqueness for id-bearing tables.
do $$
declare
  tbl text;
  tables text[] := array[
    'agents', 'runs', 'run_logs', 'chat_messages', 'wiki_artifacts', 'scheduler_jobs',
    'workboard_pages', 'documents', 'wiki_chunks', 'agent_missions', 'agent_sessions',
    'agent_session_events', 'agent_reports'
  ];
begin
  foreach tbl in array tables loop
    begin
      execute format(
        'alter table %I add constraint %I foreign key (workspace_id) references workspaces(id)',
        tbl,
        tbl || '_workspace_id_fkey'
      );
    exception
      when duplicate_object then null;
    end;
    execute format('create index if not exists %I on %I (workspace_id)', tbl || '_workspace_id_idx', tbl);
    begin
      execute format(
        'alter table %I add constraint %I unique (workspace_id, id)',
        tbl,
        tbl || '_workspace_id_id_key'
      );
    exception
      when duplicate_object then null;
      when unique_violation then null;
      when undefined_column then null; -- run_logs uses bigserial id; still has id
    end;
  end loop;
end $$;

do $$
begin
  alter table state_meta
    add constraint state_meta_workspace_id_fkey
    foreign key (workspace_id) references workspaces(id);
exception
  when duplicate_object then null;
end $$;

create index if not exists state_meta_workspace_id_idx on state_meta (workspace_id);

-- Same-workspace composite FKs for key children.
-- Fail closed: do NOT swallow invalid_foreign_key (orphan data must be fixed, not skipped).
do $$
begin
  alter table wiki_chunks
    add constraint wiki_chunks_workspace_document_fkey
    foreign key (workspace_id, document_id)
    references documents (workspace_id, id)
    on delete cascade;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table agent_sessions
    add constraint agent_sessions_workspace_mission_fkey
    foreign key (workspace_id, mission_id)
    references agent_missions (workspace_id, id)
    on delete cascade;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table agent_session_events
    add constraint agent_session_events_workspace_session_fkey
    foreign key (workspace_id, session_id)
    references agent_sessions (workspace_id, id)
    on delete cascade;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table run_logs
    add constraint run_logs_workspace_run_fkey
    foreign key (workspace_id, run_id)
    references runs (workspace_id, id)
    on delete cascade;
exception
  when duplicate_object then null;
end $$;

-- Always drop/recreate so replay corrects bare ON DELETE SET NULL → column-list (run_id).
alter table wiki_artifacts drop constraint if exists wiki_artifacts_workspace_run_fkey;
alter table wiki_artifacts
  add constraint wiki_artifacts_workspace_run_fkey
  foreign key (workspace_id, run_id)
  references runs (workspace_id, id)
  on delete set null (run_id);

do $$
begin
  alter table agent_reports
    add constraint agent_reports_workspace_mission_fkey
    foreign key (workspace_id, mission_id)
    references agent_missions (workspace_id, id)
    on delete cascade;
exception
  when duplicate_object then null;
end $$;
