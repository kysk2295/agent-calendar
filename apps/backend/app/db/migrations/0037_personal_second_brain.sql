create table if not exists second_brain_runs (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  idempotency_key text not null,
  status text not null check (status in ('source_required','running','ready_for_review','active','failed','interrupted')),
  stage text not null check (stage in ('source_required','collecting','indexing','extracting','linking','ready_for_review','active','failed')),
  processed integer not null default 0 check (processed >= 0),
  total integer not null default 0 check (total >= 0),
  source_ids jsonb not null default '[]'::jsonb,
  stage_history jsonb not null default '[]'::jsonb,
  error_code text not null default '',
  error_message text not null default '',
  worker_token text not null default '',
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id, idempotency_key),
  unique (workspace_id, user_id, id)
);

create table if not exists second_brain_snapshots (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  run_id text not null,
  version integer not null check (version > 0),
  status text not null check (status in ('ready_for_review','active')),
  claims jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id, id),
  unique (workspace_id, user_id, run_id, version),
  foreign key (workspace_id, user_id, run_id)
    references second_brain_runs (workspace_id, user_id, id) on delete cascade
);

create table if not exists second_brain_reviews (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  snapshot_id text not null,
  claim_id text not null,
  action text not null check (action in ('confirm','correct','reject')),
  basis text not null check (length(trim(basis)) > 0),
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, user_id, snapshot_id)
    references second_brain_snapshots (workspace_id, user_id, id) on delete cascade
);

create index if not exists second_brain_runs_current_idx
  on second_brain_runs (workspace_id, user_id, created_at desc);

alter table second_brain_runs enable row level security;
alter table second_brain_runs force row level security;
alter table second_brain_snapshots enable row level security;
alter table second_brain_snapshots force row level security;
alter table second_brain_reviews enable row level security;
alter table second_brain_reviews force row level security;

do $$
declare table_name text;
begin
  foreach table_name in array array['second_brain_runs','second_brain_snapshots','second_brain_reviews'] loop
    execute format('drop policy if exists %I_user on %I', table_name, table_name);
    execute format(
      'create policy %I_user on %I using (workspace_id = current_setting(''app.workspace_id'', true) and user_id = current_setting(''app.user_id'', true)) with check (workspace_id = current_setting(''app.workspace_id'', true) and user_id = current_setting(''app.user_id'', true))',
      table_name, table_name
    );
  end loop;
  if exists (select 1 from pg_roles where rolname = 'agent_calendar_app') then
    grant select, insert, update, delete on second_brain_runs to agent_calendar_app;
    grant select, insert, update, delete on second_brain_snapshots to agent_calendar_app;
    grant select, insert, update, delete on second_brain_reviews to agent_calendar_app;
  end if;
end $$;
