with ranked_sessions as (
  select
    id,
    task_id,
    mission_id,
    row_number() over (
      partition by task_id, mission_id
      order by updated_at desc, created_at desc, id desc
    ) as session_rank
  from agent_sessions
  where coalesce(task_id, '') <> ''
)
update tasks as task
set
  session_id = session.id,
  payload = jsonb_set(
    task.payload,
    '{sessionId}',
    to_jsonb(session.id),
    true
  ),
  updated_at = now()
from ranked_sessions as session
where session.task_id = task.id
  and session.mission_id = task.mission_id
  and session.session_rank = 1
  and task.payload ->> 'origin' = 'agent'
  and coalesce(session.id, '') <> ''
  and (
    coalesce(task.session_id, '') <> session.id
    or coalesce(task.payload ->> 'sessionId', '') <> session.id
  );
