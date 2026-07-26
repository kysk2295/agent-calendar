create table if not exists work_conversation_channel_endpoints (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  work_conversation_id text not null,
  runner_id text not null,
  channel text not null check (channel in ('telegram')),
  binding_handle text not null,
  status text not null default 'active'
    check (status in ('active', 'offline', 'revoked')),
  inbound_cursor text not null default '',
  outbound_cursor bigint not null default 0,
  public_metadata jsonb not null default '{}'::jsonb,
  last_activity_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, runner_id, channel, binding_handle),
  foreign key (workspace_id, runner_id)
    references runners (workspace_id, id) on delete cascade,
  foreign key (workspace_id, work_conversation_id)
    references agent_sessions (workspace_id, id) on delete cascade
);

create table if not exists work_conversation_channel_receipts (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  endpoint_id text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  delivery_key text not null,
  event_id text not null default '',
  sequence bigint,
  status text not null default 'delivered'
    check (status in ('pending', 'delivered', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, endpoint_id, direction, delivery_key),
  foreign key (workspace_id, endpoint_id)
    references work_conversation_channel_endpoints (workspace_id, id) on delete cascade
);

create index if not exists work_conversation_channel_outbound_idx
  on work_conversation_channel_endpoints (workspace_id, runner_id, status, outbound_cursor);

do $$
declare
  tbl text;
  tables text[] := array[
    'work_conversation_channel_endpoints',
    'work_conversation_channel_receipts'
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

revoke all on work_conversation_channel_endpoints from agent_calendar_app;
revoke all on work_conversation_channel_receipts from agent_calendar_app;
grant select on work_conversation_channel_endpoints to agent_calendar_app;
grant select on work_conversation_channel_receipts to agent_calendar_app;
