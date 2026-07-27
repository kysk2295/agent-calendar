alter table work_conversation_channel_receipts
  add column if not exists claimed_at timestamptz,
  add column if not exists send_started_at timestamptz,
  add column if not exists terminal_at timestamptz;

alter table work_conversation_channel_receipts
  drop constraint if exists work_conversation_channel_receipts_status_check;

alter table work_conversation_channel_receipts
  add constraint work_conversation_channel_receipts_status_check
  check (status in (
    'pending',
    'claimed',
    'sending',
    'delivered',
    'failed',
    'delivery_unknown'
  ));

create unique index if not exists work_conversation_channel_outbound_event_uidx
  on work_conversation_channel_receipts (workspace_id, endpoint_id, event_id)
  where direction = 'outbound';

create index if not exists work_conversation_channel_active_delivery_idx
  on work_conversation_channel_receipts (
    workspace_id,
    endpoint_id,
    direction,
    status,
    sequence
  );
