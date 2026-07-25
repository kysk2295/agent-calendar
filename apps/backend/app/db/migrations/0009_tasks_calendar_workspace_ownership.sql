-- Phase 1 vertical slice: workspace ownership for calendar-first tables only.
-- Expand → backfill → NOT NULL → FK/indexes. Idempotent for migrate.js replay.

alter table tasks add column if not exists workspace_id text;
alter table calendar_events add column if not exists workspace_id text;

update tasks
set workspace_id = 'legacy-personal-workspace'
where workspace_id is null or btrim(workspace_id) = '';

update calendar_events
set workspace_id = 'legacy-personal-workspace'
where workspace_id is null or btrim(workspace_id) = '';

alter table tasks alter column workspace_id set default 'legacy-personal-workspace';
alter table calendar_events alter column workspace_id set default 'legacy-personal-workspace';

alter table tasks alter column workspace_id set not null;
alter table calendar_events alter column workspace_id set not null;

do $$
begin
  alter table tasks
    add constraint tasks_workspace_id_fkey
    foreign key (workspace_id) references workspaces(id);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table calendar_events
    add constraint calendar_events_workspace_id_fkey
    foreign key (workspace_id) references workspaces(id);
exception
  when duplicate_object then null;
end $$;

create index if not exists tasks_workspace_id_idx on tasks (workspace_id);
create index if not exists calendar_events_workspace_id_idx on calendar_events (workspace_id);
create index if not exists tasks_workspace_id_id_idx on tasks (workspace_id, id);
create index if not exists calendar_events_workspace_id_id_idx on calendar_events (workspace_id, id);

do $$
begin
  alter table tasks add constraint tasks_workspace_id_id_key unique (workspace_id, id);
exception
  when duplicate_object then null;
  when unique_violation then null;
end $$;

do $$
begin
  alter table calendar_events add constraint calendar_events_workspace_id_id_key unique (workspace_id, id);
exception
  when duplicate_object then null;
  when unique_violation then null;
end $$;

-- Same-workspace composite FK: event.task_id must reference a task in the same workspace.
-- Drop the legacy global tasks(id)-only FK so cross-workspace task_id links cannot satisfy integrity.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select c.conname
    from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'calendar_events'
      and c.contype = 'f'
      and pg_get_constraintdef(c.oid) ilike '%references tasks%'
      and pg_get_constraintdef(c.oid) not ilike '%(workspace_id, task_id)%'
  loop
    execute format('alter table calendar_events drop constraint %I', constraint_name);
  end loop;
end $$;

-- Recreate composite FK with column-list SET NULL so only task_id is nulled.
-- Bare ON DELETE SET NULL would null workspace_id too, conflicting with NOT NULL.
alter table calendar_events drop constraint if exists calendar_events_workspace_task_fkey;

do $$
begin
  alter table calendar_events
    add constraint calendar_events_workspace_task_fkey
    foreign key (workspace_id, task_id)
    references tasks (workspace_id, id)
    on delete set null (task_id);
exception
  when duplicate_object then null;
end $$;
