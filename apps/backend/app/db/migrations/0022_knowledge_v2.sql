-- Phase 5 Knowledge v2: workspace-scoped collections, sources, versions, chunks,
-- ingestion, opaque evidence handles, answer cache, audit. Service-owned ciphertext blobs.

create table if not exists knowledge_collections (
  id text primary key,
  workspace_id text not null,
  name text not null default '',
  description text not null default '',
  status text not null default 'active'
    check (status in ('active', 'archived', 'disabled')),
  created_by_user_id text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, name)
);

create table if not exists knowledge_sources (
  id text primary key,
  workspace_id text not null,
  collection_id text not null,
  source_kind text not null
    check (source_kind in ('cloud_indexed', 'private_local', 'legacy_wiki')),
  label text not null default '',
  -- Logical path/filename; uniqueness is per workspace only (identical paths allowed across workspaces).
  path text not null default '',
  status text not null default 'active'
    check (status in ('active', 'ingesting', 'ready', 'error', 'revoked', 'disabled')),
  -- Cloud-indexed requires explicit opt-in; private_local never stores content on server.
  cloud_opt_in boolean not null default false,
  encryption_required boolean not null default false,
  runner_required boolean not null default false,
  revoked_at timestamptz,
  last_error_code text not null default '',
  last_error_message text not null default '',
  provenance jsonb not null default '{}'::jsonb,
  created_by_user_id text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, path, source_kind),
  foreign key (workspace_id, collection_id)
    references knowledge_collections (workspace_id, id) on delete cascade
);

create table if not exists knowledge_documents (
  id text primary key,
  workspace_id text not null,
  source_id text not null,
  collection_id text not null,
  title text not null default '',
  path text not null default '',
  mime_type text not null default 'text/markdown',
  status text not null default 'active'
    check (status in ('active', 'revoked', 'deleted')),
  current_version_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, source_id, path),
  foreign key (workspace_id, source_id)
    references knowledge_sources (workspace_id, id) on delete cascade
);

-- Immutable versions: content never updated in place.
create table if not exists knowledge_versions (
  id text primary key,
  workspace_id text not null,
  document_id text not null,
  source_id text not null,
  version_number integer not null default 1,
  content_sha256 text not null default '',
  -- cloud_indexed: ciphertext ref in knowledge_object_blobs; private_local: empty + opaque runner handle only
  storage_mode text not null default 'none'
    check (storage_mode in ('none', 'server_encrypted', 'runner_local')),
  blob_ref text not null default '',
  runner_content_handle text not null default '',
  byte_length integer not null default 0,
  created_by_user_id text not null default '',
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, document_id, version_number),
  foreign key (workspace_id, document_id)
    references knowledge_documents (workspace_id, id) on delete cascade,
  foreign key (workspace_id, source_id)
    references knowledge_sources (workspace_id, id) on delete cascade
);

alter table knowledge_documents
  add constraint knowledge_documents_current_version_fk
  foreign key (workspace_id, current_version_id)
  references knowledge_versions (workspace_id, id)
  deferrable initially deferred;

create table if not exists knowledge_object_blobs (
  id text primary key,
  workspace_id text not null,
  source_id text not null,
  version_id text not null,
  -- AES-256-GCM sealed content; service pool only (no agent_calendar_app grants).
  ciphertext text not null,
  content_sha256 text not null default '',
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, version_id),
  foreign key (workspace_id, source_id)
    references knowledge_sources (workspace_id, id) on delete cascade,
  foreign key (workspace_id, version_id)
    references knowledge_versions (workspace_id, id) on delete cascade
);

create table if not exists knowledge_chunks (
  id text primary key,
  workspace_id text not null,
  source_id text not null,
  document_id text not null,
  version_id text not null,
  chunk_index integer not null default 0,
  title text not null default '',
  path text not null default '',
  -- Cloud: plaintext only while ingesting then optional sealed excerpt; private_local: empty/opaque.
  content text not null default '',
  excerpt text not null default '',
  content_enc text not null default '',
  excerpt_enc text not null default '',
  keyword_hashes text[] not null default '{}'::text[],
  embedding jsonb not null default '[]'::jsonb,
  embedding_vector vector(256),
  embedding_model text not null default 'hermes-hash-embedding-v1',
  status text not null default 'active'
    check (status in ('active', 'revoked', 'deleted')),
  search_vector tsvector generated always as (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, '') || ' ' || coalesce(path, '') || ' ' || coalesce(excerpt, ''))
  ) stored,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, version_id, chunk_index),
  foreign key (workspace_id, source_id)
    references knowledge_sources (workspace_id, id) on delete cascade,
  foreign key (workspace_id, document_id)
    references knowledge_documents (workspace_id, id) on delete cascade,
  foreign key (workspace_id, version_id)
    references knowledge_versions (workspace_id, id) on delete cascade
);

create table if not exists knowledge_ingestion_jobs (
  id text primary key,
  workspace_id text not null,
  source_id text not null,
  document_id text,
  version_id text,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  stage text not null default 'queued',
  error_code text not null default '',
  error_message text not null default '',
  attempt_count integer not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, source_id)
    references knowledge_sources (workspace_id, id) on delete cascade,
  foreign key (workspace_id, document_id)
    references knowledge_documents (workspace_id, id) on delete cascade,
  foreign key (workspace_id, version_id)
    references knowledge_versions (workspace_id, id) on delete cascade
);

-- Opaque evidence handles: never expose raw local paths or foreign workspace content.
create table if not exists knowledge_evidence_handles (
  id text primary key,
  workspace_id text not null,
  source_id text not null,
  document_id text,
  version_id text,
  chunk_id text,
  runner_job_id text,
  runner_attempt_id text,
  evidence_key text,
  handle_token text not null,
  citation_label text not null default '',
  excerpt text not null default '',
  excerpt_enc text not null default '',
  status text not null default 'active'
    check (status in ('active', 'revoked', 'expired')),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, handle_token),
  foreign key (workspace_id, source_id)
    references knowledge_sources (workspace_id, id) on delete cascade,
  foreign key (workspace_id, document_id)
    references knowledge_documents (workspace_id, id) on delete cascade,
  foreign key (workspace_id, version_id)
    references knowledge_versions (workspace_id, id) on delete cascade,
  foreign key (workspace_id, chunk_id)
    references knowledge_chunks (workspace_id, id) on delete cascade,
  foreign key (workspace_id, runner_job_id)
    references execution_jobs (workspace_id, id) on delete cascade,
  foreign key (workspace_id, runner_attempt_id)
    references execution_attempts (workspace_id, id) on delete cascade
);

create table if not exists knowledge_answer_cache (
  id text primary key,
  workspace_id text not null,
  cache_key text not null,
  question text not null default '',
  answer text not null default '',
  answer_enc text not null default '',
  evidence_handle_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (workspace_id, id),
  unique (workspace_id, cache_key)
);

create table if not exists knowledge_audit_events (
  id text primary key,
  workspace_id text not null,
  actor_user_id text not null default '',
  action text not null,
  entity_kind text not null default '',
  entity_id text not null default '',
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create index if not exists knowledge_sources_ws_status_idx
  on knowledge_sources (workspace_id, status, source_kind);
create index if not exists knowledge_chunks_ws_status_idx
  on knowledge_chunks (workspace_id, status, source_id);
create index if not exists knowledge_chunks_search_idx
  on knowledge_chunks using gin (search_vector);
create index if not exists knowledge_chunks_keyword_hashes_idx
  on knowledge_chunks using gin (keyword_hashes);
create index if not exists knowledge_chunks_embedding_idx
  on knowledge_chunks using hnsw (embedding_vector vector_cosine_ops);
create index if not exists knowledge_evidence_ws_token_idx
  on knowledge_evidence_handles (workspace_id, handle_token);
create unique index if not exists knowledge_evidence_ws_key_uidx
  on knowledge_evidence_handles (workspace_id, evidence_key)
  where evidence_key is not null;
create index if not exists knowledge_answer_cache_ws_key_idx
  on knowledge_answer_cache (workspace_id, cache_key);

-- RLS FORCE
do $$
declare
  t text;
  tables text[] := array[
    'knowledge_collections',
    'knowledge_sources',
    'knowledge_documents',
    'knowledge_versions',
    'knowledge_chunks',
    'knowledge_ingestion_jobs',
    'knowledge_evidence_handles',
    'knowledge_answer_cache',
    'knowledge_audit_events'
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

-- Blobs: FORCE RLS deny app role; no grants to agent_calendar_app
alter table knowledge_object_blobs enable row level security;
alter table knowledge_object_blobs force row level security;
drop policy if exists knowledge_object_blobs_deny_app on knowledge_object_blobs;
drop policy if exists knowledge_object_blobs_workspace on knowledge_object_blobs;
create policy knowledge_object_blobs_workspace on knowledge_object_blobs
  using (workspace_id = current_setting('app.workspace_id', true))
  with check (workspace_id = current_setting('app.workspace_id', true));

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_calendar_app') then
    grant select, insert, update, delete on knowledge_collections to agent_calendar_app;
    grant select, insert, update, delete on knowledge_sources to agent_calendar_app;
    grant select, insert, update, delete on knowledge_documents to agent_calendar_app;
    grant select, insert, update, delete on knowledge_versions to agent_calendar_app;
    grant select, insert, update, delete on knowledge_chunks to agent_calendar_app;
    grant select, insert, update, delete on knowledge_ingestion_jobs to agent_calendar_app;
    grant select, insert, update, delete on knowledge_evidence_handles to agent_calendar_app;
    grant select, insert, update, delete on knowledge_answer_cache to agent_calendar_app;
    grant select, insert, update, delete on knowledge_audit_events to agent_calendar_app;
    revoke all on table knowledge_object_blobs from agent_calendar_app;
  end if;
end $$;

comment on table knowledge_object_blobs is
  'Service-owned AES-GCM ciphertext for cloud_indexed knowledge. No agent_calendar_app grants.';
comment on table knowledge_sources is
  'cloud_indexed requires cloud_opt_in + encryption; private_local stores metadata only (runner holds content).';
comment on table knowledge_evidence_handles is
  'Opaque workspace-bound citation tokens; never raw filesystem paths.';
