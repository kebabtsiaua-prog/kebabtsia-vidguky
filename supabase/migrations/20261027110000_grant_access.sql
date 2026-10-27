-- Only the owner, Роман and Юра give access (owner 2026-10-27). Found by role and name, so no ids or codes land in
-- this public repository.
alter table users add column if not exists can_grant boolean not null default false;
update users set can_grant = true
where tg_id = (select tg_id from users where survey_set = 'none' and role = 'admin' order by created_at limit 1)
   or survey_set = 'tour'
   or (role = 'admin' and name ~* '^(роман|roma|roman)');

-- The owner switches the shared link for location admins off once everyone is in (owner 2026-10-27).
alter table invites add column if not exists closed_at timestamptz;
