alter table provider_agent_sessions
  drop constraint if exists provider_agent_sessions_workspace_id_work_conversation_id_key;

create unique index if not exists provider_agent_sessions_conversation_engine_runner_unique_idx
  on provider_agent_sessions (workspace_id, work_conversation_id, engine, runner_id);

alter table provider_agent_sessions
  add column if not exists context_sync_mode text not null default 'context_only'
    check (context_sync_mode in ('native', 'context_only', 'unsupported'));

alter table provider_agent_sessions
  add column if not exists last_context_sequence integer not null default 0;
