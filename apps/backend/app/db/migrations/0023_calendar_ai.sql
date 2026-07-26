create table if not exists calendar_ai_conversations (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  created_by_user_id text not null,
  title text not null default '',
  status text not null default 'active'
    check (status in ('active', 'archived')),
  latest_turn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table if not exists calendar_ai_turns (
  id text primary key,
  workspace_id text not null,
  conversation_id text not null,
  sequence integer not null,
  role text not null check (role in ('user', 'assistant', 'system')),
  kind text not null default 'message',
  text text not null default '',
  client_request_id text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, conversation_id, sequence),
  foreign key (workspace_id, conversation_id)
    references calendar_ai_conversations (workspace_id, id) on delete cascade
);

create unique index if not exists calendar_ai_turns_request_uidx
  on calendar_ai_turns (workspace_id, client_request_id)
  where client_request_id <> '';

create table if not exists calendar_ai_context_snapshots (
  id text primary key,
  workspace_id text not null,
  conversation_id text not null,
  turn_id text not null,
  query_kind text not null default 'conversation',
  range_start timestamptz,
  range_end timestamptz,
  coverage jsonb not null default '[]'::jsonb,
  source_refs jsonb not null default '[]'::jsonb,
  knowledge_handles jsonb not null default '[]'::jsonb,
  memory_ids jsonb not null default '[]'::jsonb,
  context_digest text not null default '',
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, turn_id),
  foreign key (workspace_id, conversation_id)
    references calendar_ai_conversations (workspace_id, id) on delete cascade,
  foreign key (workspace_id, turn_id)
    references calendar_ai_turns (workspace_id, id) on delete cascade
);

create table if not exists calendar_ai_memories (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  label text not null default '',
  value text not null,
  status text not null default 'active'
    check (status in ('active', 'forgotten')),
  provenance jsonb not null default '{}'::jsonb,
  retention_until timestamptz,
  forgotten_at timestamptz,
  created_by_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table if not exists calendar_ai_action_drafts (
  id text primary key,
  workspace_id text not null,
  conversation_id text not null,
  turn_id text not null,
  action_kind text not null
    check (action_kind in ('calendar_create', 'calendar_update', 'calendar_delete', 'delegate_work')),
  status text not null default 'pending_approval'
    check (status in ('pending_approval', 'approved', 'executing', 'completed', 'failed', 'cancelled')),
  input jsonb not null default '{}'::jsonb,
  policy jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  approved_by_user_id text,
  approved_at timestamptz,
  cancelled_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, conversation_id)
    references calendar_ai_conversations (workspace_id, id) on delete cascade,
  foreign key (workspace_id, turn_id)
    references calendar_ai_turns (workspace_id, id) on delete cascade
);

create table if not exists calendar_ai_action_receipts (
  id text primary key,
  workspace_id text not null,
  draft_id text not null,
  status text not null
    check (status in ('succeeded', 'failed')),
  operation text not null,
  result jsonb not null default '{}'::jsonb,
  error_code text not null default '',
  error_message text not null default '',
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, draft_id),
  foreign key (workspace_id, draft_id)
    references calendar_ai_action_drafts (workspace_id, id) on delete cascade
);

create index if not exists calendar_ai_conversations_latest_idx
  on calendar_ai_conversations (workspace_id, latest_turn_at desc);
create index if not exists calendar_ai_turns_conversation_idx
  on calendar_ai_turns (workspace_id, conversation_id, sequence);
create index if not exists calendar_ai_memories_status_idx
  on calendar_ai_memories (workspace_id, status, updated_at desc);
create index if not exists calendar_ai_drafts_status_idx
  on calendar_ai_action_drafts (workspace_id, status, created_at desc);

do $$
declare
  t text;
  tables text[] := array[
    'calendar_ai_conversations',
    'calendar_ai_turns',
    'calendar_ai_context_snapshots',
    'calendar_ai_memories',
    'calendar_ai_action_drafts',
    'calendar_ai_action_receipts'
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
    'calendar_ai_conversations',
    'calendar_ai_turns',
    'calendar_ai_context_snapshots',
    'calendar_ai_memories',
    'calendar_ai_action_drafts',
    'calendar_ai_action_receipts'
  ];
begin
  if exists (select 1 from pg_roles where rolname = 'agent_calendar_app') then
    foreach t in array tables loop
      execute format('grant select, insert, update, delete on %I to agent_calendar_app', t);
    end loop;
  end if;
end $$;
