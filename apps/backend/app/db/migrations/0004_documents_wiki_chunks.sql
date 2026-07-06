create extension if not exists vector;

create table if not exists documents (
  id text primary key,
  title text not null default '',
  path text not null default '',
  source text not null default '',
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists wiki_chunks (
  id text primary key,
  source text not null default '',
  source_id text not null default '',
  document_id text references documents(id) on delete cascade,
  path text not null default '',
  title text not null default '',
  chunk_index integer not null default 0,
  content text not null default '',
  excerpt text not null default '',
  embedding jsonb not null default '[]'::jsonb,
  embedding_vector vector(256),
  embedding_model text not null default 'hermes-hash-embedding-v1',
  metadata jsonb not null default '{}'::jsonb,
  search_vector tsvector generated always as (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, '') || ' ' || coalesce(path, ''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table wiki_chunks add column if not exists embedding_vector vector(256);

create index if not exists documents_path_idx on documents(path);
create index if not exists documents_source_idx on documents(source);
create index if not exists wiki_chunks_path_idx on wiki_chunks(path);
create index if not exists wiki_chunks_source_idx on wiki_chunks(source, source_id);
create index if not exists wiki_chunks_search_vector_idx on wiki_chunks using gin(search_vector);
create index if not exists wiki_chunks_embedding_vector_hnsw_idx on wiki_chunks using hnsw (embedding_vector vector_cosine_ops);
