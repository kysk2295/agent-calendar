create table if not exists agents (
  id text primary key,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tasks (
  id text primary key,
  title text not null default '',
  status text not null default '',
  owner text not null default '',
  due_at text not null default '',
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists calendar_events (
  id text primary key,
  task_id text references tasks(id) on delete set null,
  title text not null default '',
  starts_at text not null default '',
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists runs (
  id text primary key,
  goal text not null default '',
  agent text not null default '',
  model text not null default '',
  status text not null default '',
  wiki_path text not null default '',
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists run_logs (
  id bigserial primary key,
  run_id text not null references runs(id) on delete cascade,
  line text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists chat_messages (
  id text primary key,
  role text not null default '',
  text text not null default '',
  run_id text not null default '',
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists wiki_artifacts (
  id text primary key,
  run_id text references runs(id) on delete set null,
  path text not null default '',
  status text not null default '',
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists scheduler_jobs (
  id text primary key,
  name text not null default '',
  agent text not null default '',
  model text not null default '',
  enabled boolean not null default true,
  interval_minutes integer not null default 60,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
