-- Refresh rows must match their session identity (user, workspace, family).
-- Composite UNIQUE on sessions enables a matching composite FK from refresh tokens.

do $$
begin
  alter table auth_sessions
    add constraint auth_sessions_id_user_workspace_family_key
    unique (id, user_id, workspace_id, refresh_family_id);
exception
  when duplicate_object then null;
end $$;

alter table auth_refresh_tokens drop constraint if exists auth_refresh_tokens_session_identity_fkey;

alter table auth_refresh_tokens
  add constraint auth_refresh_tokens_session_identity_fkey
  foreign key (session_id, user_id, workspace_id, family_id)
  references auth_sessions (id, user_id, workspace_id, refresh_family_id)
  on delete cascade;
