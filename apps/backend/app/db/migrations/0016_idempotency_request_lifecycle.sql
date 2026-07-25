-- Phase 1 cutover: idempotency lifecycle columns for universal production middleware.
-- Expand-only; safe under FORCE RLS (workspace_id already present).

alter table idempotency_keys add column if not exists status text;
alter table idempotency_keys add column if not exists route text;
alter table idempotency_keys add column if not exists action text;
alter table idempotency_keys add column if not exists locked_at timestamptz;

update idempotency_keys
set status = case
  when response_status is null then 'in_progress'
  when response_status >= 400 then 'failed'
  else 'completed'
end
where status is null or btrim(status) = '';

alter table idempotency_keys alter column status set default 'in_progress';
update idempotency_keys set status = 'in_progress' where status is null;
alter table idempotency_keys alter column status set not null;

update idempotency_keys set route = coalesce(route, '') where route is null;
alter table idempotency_keys alter column route set default '';
update idempotency_keys set route = '' where route is null;
alter table idempotency_keys alter column route set not null;

update idempotency_keys set action = coalesce(action, '') where action is null;
alter table idempotency_keys alter column action set default '';
update idempotency_keys set action = '' where action is null;
alter table idempotency_keys alter column action set not null;

create index if not exists idempotency_keys_expires_at_idx
  on idempotency_keys (expires_at)
  where expires_at is not null;

create index if not exists idempotency_keys_workspace_status_idx
  on idempotency_keys (workspace_id, status);
