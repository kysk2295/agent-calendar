-- Phase 3: durable execution jobs, offers, attempts, events, artifacts, outbox.
-- Workspace-composite FKs; FORCE RLS; least-privilege app role (no mutate offers/attempts/outbox).

-- Referenced tables already carry unique (workspace_id, id) from 0010/0017.

create table if not exists execution_jobs (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  mission_id text not null,
  session_id text not null,
  requested_engine text not null default 'auto',
  resolved_engine text not null default '',
  engine_reason text not null default '',
  preferred_runner_id text,
  status text not null default 'accepted'
    check (status in (
      'accepted', 'waiting_runner', 'offered', 'leased', 'running',
      'completed', 'failed', 'cancelled', 'dead_letter'
    )),
  goal text not null default '',
  payload jsonb not null default '{}'::jsonb,
  available_at timestamptz not null default now(),
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  cancellation_requested boolean not null default false,
  last_error_code text not null default '',
  last_error_message text not null default '',
  terminal_at timestamptz,
  projection_key text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, mission_id),
  unique (workspace_id, projection_key),
  foreign key (workspace_id, mission_id)
    references agent_missions (workspace_id, id) on delete cascade,
  foreign key (workspace_id, session_id)
    references agent_sessions (workspace_id, id) on delete cascade,
  -- Column-targeted SET NULL: only preferred_runner_id nulls (workspace_id stays NOT NULL).
  foreign key (workspace_id, preferred_runner_id)
    references runners (workspace_id, id)
    on delete set null (preferred_runner_id)
);

create table if not exists execution_offers (
  id text primary key,
  workspace_id text not null,
  job_id text not null,
  runner_id text not null,
  status text not null default 'open'
    check (status in ('open', 'accepted', 'expired', 'withdrawn')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, job_id)
    references execution_jobs (workspace_id, id) on delete cascade,
  foreign key (workspace_id, runner_id)
    references runners (workspace_id, id) on delete cascade
);

create table if not exists execution_attempts (
  id text primary key,
  workspace_id text not null,
  job_id text not null,
  runner_id text not null,
  offer_id text,
  attempt_number integer not null,
  lease_epoch bigint not null,
  status text not null default 'leased'
    check (status in (
      'leased', 'running', 'completed', 'failed', 'cancelled', 'expired', 'fenced'
    )),
  engine text not null default '',
  lease_expires_at timestamptz not null,
  started_at timestamptz not null default now(),
  terminal_at timestamptz,
  result_summary text not null default '',
  error_code text not null default '',
  error_message text not null default '',
  completion_idempotency_key text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, job_id, attempt_number),
  unique (workspace_id, job_id, lease_epoch),
  foreign key (workspace_id, job_id)
    references execution_jobs (workspace_id, id) on delete cascade,
  foreign key (workspace_id, runner_id)
    references runners (workspace_id, id) on delete cascade,
  -- Non-null offer_id must reference same-workspace offer; null offer_id allowed (MATCH SIMPLE).
  foreign key (workspace_id, offer_id)
    references execution_offers (workspace_id, id)
    on delete set null (offer_id)
);

-- At most one accepted terminal attempt per job (completed/cancelled).
create unique index if not exists execution_attempts_one_terminal_success_idx
  on execution_attempts (workspace_id, job_id)
  where status in ('completed', 'cancelled');

create table if not exists execution_events (
  id text primary key,
  workspace_id text not null,
  job_id text not null,
  attempt_id text,
  sequence bigint not null,
  kind text not null default 'checkpoint',
  idempotency_key text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, job_id, sequence),
  unique (workspace_id, job_id, idempotency_key),
  foreign key (workspace_id, job_id)
    references execution_jobs (workspace_id, id) on delete cascade,
  foreign key (workspace_id, attempt_id)
    references execution_attempts (workspace_id, id) on delete cascade
);

create table if not exists execution_artifacts (
  id text primary key,
  workspace_id text not null,
  job_id text not null,
  attempt_id text,
  kind text not null default 'file',
  name text not null default '',
  content_type text not null default 'text/plain',
  content text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  idempotency_key text not null default '',
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, job_id, idempotency_key),
  foreign key (workspace_id, job_id)
    references execution_jobs (workspace_id, id) on delete cascade,
  foreign key (workspace_id, attempt_id)
    references execution_attempts (workspace_id, id) on delete cascade
);

create table if not exists execution_outbox (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  job_id text not null,
  event_type text not null default '',
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'done', 'failed')),
  available_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, job_id)
    references execution_jobs (workspace_id, id) on delete cascade
);

create index if not exists execution_jobs_workspace_status_idx
  on execution_jobs (workspace_id, status, available_at);
create index if not exists execution_offers_runner_open_idx
  on execution_offers (workspace_id, runner_id, status, expires_at);
create index if not exists execution_attempts_runner_active_idx
  on execution_attempts (workspace_id, runner_id, status, lease_expires_at);
create index if not exists execution_events_job_seq_idx
  on execution_events (workspace_id, job_id, sequence);
create index if not exists execution_outbox_pending_idx
  on execution_outbox (workspace_id, status, available_at);

do $$
declare
  tbl text;
  tables text[] := array[
    'execution_jobs',
    'execution_offers',
    'execution_attempts',
    'execution_events',
    'execution_artifacts',
    'execution_outbox'
  ];
begin
  foreach tbl in array tables loop
    execute format('alter table %I enable row level security', tbl);
    execute format('alter table %I force row level security', tbl);
    begin
      execute format('drop policy if exists %I on %I', tbl || '_workspace_isolation', tbl);
    exception when undefined_object then null;
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

-- Least privilege: user/app path may accept/cancel jobs only.
-- Offers, attempts, and outbox are service/device-owned (table owner), not app-mutable.
revoke all on execution_jobs from agent_calendar_app;
revoke all on execution_offers from agent_calendar_app;
revoke all on execution_attempts from agent_calendar_app;
revoke all on execution_events from agent_calendar_app;
revoke all on execution_artifacts from agent_calendar_app;
revoke all on execution_outbox from agent_calendar_app;

grant select, insert, update on execution_jobs to agent_calendar_app;
-- Read-only visibility for status projection if needed; no insert/update/delete.
grant select on execution_offers to agent_calendar_app;
grant select on execution_attempts to agent_calendar_app;
grant select on execution_events to agent_calendar_app;
grant select on execution_artifacts to agent_calendar_app;
grant select on execution_outbox to agent_calendar_app;
