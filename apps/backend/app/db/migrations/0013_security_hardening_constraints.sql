-- Phase 1 security hardening: unique access hashes, refresh parent FK, missing composite FKs.
-- Fail closed: no silent invalid_foreign_key swallows.

-- Unique access token hash (lookup + prevent collisions).
do $$
begin
  alter table auth_sessions
    add constraint auth_sessions_access_token_hash_key unique (access_token_hash);
exception
  when duplicate_object then null;
end $$;

-- Refresh parent chain must reference a real token row when set.
do $$
begin
  alter table auth_refresh_tokens
    add constraint auth_refresh_tokens_parent_id_fkey
    foreign key (parent_id) references auth_refresh_tokens (id)
    on delete set null;
exception
  when duplicate_object then null;
end $$;

create index if not exists auth_refresh_tokens_parent_id_idx on auth_refresh_tokens (parent_id);

-- Always drop/recreate so replay corrects bare ON DELETE SET NULL → column-list (run_id).
-- Bare SET NULL would null workspace_id too and conflict with NOT NULL.
alter table wiki_artifacts drop constraint if exists wiki_artifacts_workspace_run_fkey;
alter table wiki_artifacts
  add constraint wiki_artifacts_workspace_run_fkey
  foreign key (workspace_id, run_id)
  references runs (workspace_id, id)
  on delete set null (run_id);

do $$
begin
  alter table agent_reports
    add constraint agent_reports_workspace_mission_fkey
    foreign key (workspace_id, mission_id)
    references agent_missions (workspace_id, id)
    on delete cascade;
exception
  when duplicate_object then null;
end $$;

-- Ensure prior child composites exist (idempotent add; fail if definition conflicts).
do $$
begin
  alter table wiki_chunks
    add constraint wiki_chunks_workspace_document_fkey
    foreign key (workspace_id, document_id)
    references documents (workspace_id, id)
    on delete cascade;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table agent_sessions
    add constraint agent_sessions_workspace_mission_fkey
    foreign key (workspace_id, mission_id)
    references agent_missions (workspace_id, id)
    on delete cascade;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table agent_session_events
    add constraint agent_session_events_workspace_session_fkey
    foreign key (workspace_id, session_id)
    references agent_sessions (workspace_id, id)
    on delete cascade;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table run_logs
    add constraint run_logs_workspace_run_fkey
    foreign key (workspace_id, run_id)
    references runs (workspace_id, id)
    on delete cascade;
exception
  when duplicate_object then null;
end $$;
