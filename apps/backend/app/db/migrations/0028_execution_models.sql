alter table execution_jobs
  add column if not exists requested_model text not null default '',
  add column if not exists resolved_model text not null default '';

alter table execution_jobs
  drop constraint if exists execution_jobs_requested_model_public_id_check,
  add constraint execution_jobs_requested_model_public_id_check
    check (
      requested_model = ''
      or (
        requested_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$'
        and requested_model !~* '^(sk-|bearer|token|cookie|secret)'
      )
    ),
  drop constraint if exists execution_jobs_resolved_model_public_id_check,
  add constraint execution_jobs_resolved_model_public_id_check
    check (
      resolved_model = ''
      or (
        resolved_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$'
        and resolved_model !~* '^(sk-|bearer|token|cookie|secret)'
      )
    );
