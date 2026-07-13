create table if not exists agent_missions (
  id text primary key,
  status text not null default 'draft',
  agent_id text not null default '',
  report_due_at text not null default '',
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tasks add column if not exists mission_id text not null default '';
alter table tasks add column if not exists session_id text not null default '';

create table if not exists agent_sessions (
  id text primary key,
  mission_id text not null references agent_missions(id) on delete cascade,
  task_id text not null default '',
  status text not null default 'proposed',
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agent_session_events (
  id text primary key,
  session_id text not null references agent_sessions(id) on delete cascade,
  sequence integer not null,
  kind text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (session_id, sequence)
);

create table if not exists agent_reports (
  id text primary key,
  mission_id text not null references agent_missions(id) on delete cascade,
  session_id text not null default '',
  status text not null default 'ready',
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tasks_mission_id_idx on tasks(mission_id);
create index if not exists tasks_session_id_idx on tasks(session_id);
create index if not exists agent_sessions_mission_id_idx on agent_sessions(mission_id);
create index if not exists agent_sessions_task_id_idx on agent_sessions(task_id);
create index if not exists agent_session_events_session_sequence_idx on agent_session_events(session_id, sequence);
create index if not exists agent_reports_mission_id_idx on agent_reports(mission_id);
