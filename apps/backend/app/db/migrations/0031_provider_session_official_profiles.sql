alter table provider_agent_sessions
  add column if not exists official_profile text not null default '';

alter table provider_agent_sessions
  alter column agent_id drop not null;

alter table provider_agent_sessions
  drop constraint if exists provider_agent_sessions_owner_check;

alter table provider_agent_sessions
  add constraint provider_agent_sessions_owner_check
  check (
    (agent_id is not null and official_profile = '')
    or (
      agent_id is null
      and official_profile in (
        'default',
        'bizconsultant',
        'stockagent',
        'uniportpm',
        'wikicurator'
      )
    )
  );

create index if not exists provider_agent_sessions_official_profile_activity_idx
  on provider_agent_sessions (
    workspace_id,
    official_profile,
    archived_at,
    last_activity_at desc
  )
  where official_profile <> '';
