create table if not exists workboard_pages (
  id text primary key,
  title text not null default '',
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
