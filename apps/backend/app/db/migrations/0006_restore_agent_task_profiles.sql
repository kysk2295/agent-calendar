update tasks
set
  payload = jsonb_set(
    payload,
    '{agent}',
    to_jsonb(payload ->> 'createdByAgentId'),
    true
  ),
  updated_at = now()
where payload ->> 'origin' = 'agent'
  and coalesce(payload ->> 'createdByAgentId', '') <> ''
  and coalesce(payload ->> 'agent', '') <> payload ->> 'createdByAgentId';
