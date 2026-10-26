-- Location admins can run up to four locations and see only those (owner 2026-10-24, 2026-10-26).
-- They join through one shared link, write their name and pick their locations themselves; the owner is told
-- and can remove the person or fix the locations.
create table if not exists user_locations (
  tg_id       bigint not null references users(tg_id) on delete cascade,
  location_id int not null references locations(id),
  primary key (tg_id, location_id)
);
alter table user_locations enable row level security;
grant select, insert, update, delete on user_locations to service_role;

-- Admins added before this keep their one location.
insert into user_locations (tg_id, location_id)
select tg_id, location_id from users where role = 'loc_admin' and location_id is not null
on conflict do nothing;

-- Set once the person confirmed their locations; until then the app asks for name and locations first.
alter table users add column if not exists locs_confirmed_at timestamptz;
update users set locs_confirmed_at = coalesce(locs_confirmed_at, now()) where role = 'loc_admin' and location_id is not null;

-- A shared invite is not used up: everyone who opens it joins as a location admin.
alter table invites add column if not exists shared boolean not null default false;
alter table invites add column if not exists uses int not null default 0;
