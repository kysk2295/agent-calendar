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
from agent_sessions as session
where session.task_id = task.id
  and task.payload ->> 'origin' = 'agent'
  and coalesce(session.id, '') <> ''
  and (
    coalesce(task.session_id, '') <> session.id
    or coalesce(task.payload ->> 'sessionId', '') <> session.id
  );
