alter table runner_connector_requests
  drop constraint if exists runner_connector_requests_kind_check;

alter table runner_connector_requests
  add constraint runner_connector_requests_kind_check
  check (kind in (
    'agent_catalog',
    'session_catalog',
    'automation_capabilities',
    'automation_list',
    'automation_mutation'
  ));
