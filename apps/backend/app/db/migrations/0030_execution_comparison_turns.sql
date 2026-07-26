alter table execution_jobs
  add column if not exists turn_target_index integer not null default 0,
  add column if not exists turn_mode text not null default 'single';

alter table execution_jobs
  drop constraint if exists execution_jobs_turn_target_index_check,
  add constraint execution_jobs_turn_target_index_check
    check (turn_target_index between 0 and 3),
  drop constraint if exists execution_jobs_turn_mode_check,
  add constraint execution_jobs_turn_mode_check
    check (turn_mode in ('single', 'comparison')),
  drop constraint if exists execution_jobs_turn_shape_check,
  add constraint execution_jobs_turn_shape_check
    check (turn_mode = 'comparison' or turn_target_index = 0);

drop index if exists execution_jobs_mission_turn_unique_idx;
create unique index if not exists execution_jobs_mission_turn_target_unique_idx
  on execution_jobs (workspace_id, mission_id, turn_index, turn_target_index);

create index if not exists execution_jobs_mission_turn_state_idx
  on execution_jobs (workspace_id, mission_id, turn_index, status);
