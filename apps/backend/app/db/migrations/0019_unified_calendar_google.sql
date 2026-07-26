-- Phase 4: Unified Calendar sources, external events, coverage, cursors, receipts, watches.
-- Workspace composite FKs; FORCE RLS; opaque credential_ref only (never provider tokens).

create table if not exists calendar_sources (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  provider text not null default 'google'
    check (provider in ('google', 'internal', 'agent_work', 'automation')),
  source_kind text not null default 'external_calendar'
    check (source_kind in ('external_calendar', 'internal', 'agent_work', 'automation')),
  label text not null default '',
  external_calendar_id text not null default '',
  credential_ref text not null default '',
  status text not null default 'disconnected'
    check (status in (
      'disconnected', 'connecting', 'connected', 'syncing', 'error', 'revoked', 'disabled'
    )),
  writable boolean not null default false,
  timezone text not null default 'UTC',
  last_synced_at timestamptz,
  last_error_code text not null default '',
  last_error_message text not null default '',
  selected boolean not null default true,
  shadow_only boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, provider, external_calendar_id)
);

create table if not exists calendar_provider_events (
  id text primary key,
  workspace_id text not null,
  source_id text not null,
  provider_event_id text not null default '',
  ical_uid text not null default '',
  title text not null default '',
  status text not null default 'confirmed'
    check (status in ('confirmed', 'tentative', 'cancelled', 'deleted')),
  all_day boolean not null default false,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'UTC',
  recurrence_rule text not null default '',
  recurring_event_id text not null default '',
  etag text not null default '',
  provider_version text not null default '',
  payload jsonb not null default '{}'::jsonb,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, source_id, provider_event_id),
  foreign key (workspace_id, source_id)
    references calendar_sources (workspace_id, id) on delete cascade
);

-- Materialized or singleton occurrences for range queries (recurrence expansion).
create table if not exists calendar_occurrences (
  id text primary key,
  workspace_id text not null,
  source_id text not null,
  provider_event_id text not null default '',
  occurrence_key text not null,
  title text not null default '',
  all_day boolean not null default false,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'UTC',
  status text not null default 'confirmed',
  writable boolean not null default false,
  etag text not null default '',
  entry_kind text not null default 'external'
    check (entry_kind in ('external', 'internal', 'agent_work', 'automation')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, source_id, occurrence_key),
  foreign key (workspace_id, source_id)
    references calendar_sources (workspace_id, id) on delete cascade
);

create table if not exists calendar_source_coverage (
  id text primary key,
  workspace_id text not null,
  source_id text not null,
  range_start timestamptz not null,
  range_end timestamptz not null,
  state text not null default 'unsynchronized'
    check (state in ('unsynchronized', 'incomplete', 'complete', 'stale', 'error')),
  event_count integer not null default 0,
  synced_at timestamptz,
  message text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, source_id, range_start, range_end),
  foreign key (workspace_id, source_id)
    references calendar_sources (workspace_id, id) on delete cascade
);

create table if not exists calendar_sync_cursors (
  id text primary key,
  workspace_id text not null,
  source_id text not null,
  cursor_kind text not null default 'sync_token'
    check (cursor_kind in ('sync_token', 'page_token', 'full_sync')),
  cursor_value text not null default '',
  page_complete boolean not null default true,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, source_id, cursor_kind),
  foreign key (workspace_id, source_id)
    references calendar_sources (workspace_id, id) on delete cascade
);

create table if not exists calendar_mutation_receipts (
  id text primary key,
  workspace_id text not null,
  source_id text,
  idempotency_key text not null default '',
  operation text not null default 'create'
    check (operation in ('create', 'update', 'delete')),
  status text not null default 'pending'
    check (status in ('pending', 'submitted', 'reconciled', 'conflict', 'failed')),
  client_request_id text not null default '',
  provider_event_id text not null default '',
  etag text not null default '',
  error_code text not null default '',
  error_message text not null default '',
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, source_id)
    references calendar_sources (workspace_id, id)
    on delete set null (source_id)
);

create table if not exists calendar_watches (
  id text primary key,
  workspace_id text not null,
  source_id text not null,
  channel_id text not null,
  resource_id text not null default '',
  token_digest text not null default '',
  expiration_at timestamptz,
  address text not null default '',
  status text not null default 'active'
    check (status in ('active', 'expired', 'stopped', 'error')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, channel_id),
  foreign key (workspace_id, source_id)
    references calendar_sources (workspace_id, id) on delete cascade
);

create index if not exists calendar_provider_events_range_idx
  on calendar_provider_events (workspace_id, source_id, starts_at, ends_at)
  where deleted = false;
create index if not exists calendar_occurrences_range_idx
  on calendar_occurrences (workspace_id, starts_at, ends_at);
create index if not exists calendar_sources_workspace_status_idx
  on calendar_sources (workspace_id, status, selected);

do $$
declare
  tbl text;
  tables text[] := array[
    'calendar_sources',
    'calendar_provider_events',
    'calendar_occurrences',
    'calendar_source_coverage',
    'calendar_sync_cursors',
    'calendar_mutation_receipts',
    'calendar_watches'
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

revoke all on calendar_sources from agent_calendar_app;
revoke all on calendar_provider_events from agent_calendar_app;
revoke all on calendar_occurrences from agent_calendar_app;
revoke all on calendar_source_coverage from agent_calendar_app;
revoke all on calendar_sync_cursors from agent_calendar_app;
revoke all on calendar_mutation_receipts from agent_calendar_app;
revoke all on calendar_watches from agent_calendar_app;

-- User path: sources + receipts + coverage + occurrences (projection read/write under RLS).
grant select, insert, update, delete on calendar_sources to agent_calendar_app;
grant select, insert, update, delete on calendar_provider_events to agent_calendar_app;
grant select, insert, update, delete on calendar_occurrences to agent_calendar_app;
grant select, insert, update, delete on calendar_source_coverage to agent_calendar_app;
grant select, insert, update, delete on calendar_sync_cursors to agent_calendar_app;
grant select, insert, update, delete on calendar_mutation_receipts to agent_calendar_app;
grant select, insert, update, delete on calendar_watches to agent_calendar_app;
