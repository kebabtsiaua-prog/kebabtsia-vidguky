-- Google rating tracking through the Places API: one snapshot per location per day.
-- google_monthly is filled from these snapshots by the `google` function.
alter table locations add column if not exists google_place_id text;   -- Places API id, found by name once; an admin can correct it
alter table locations add column if not exists google_address text;    -- address Google returned, to check the match

create table if not exists google_daily (
  location_id int not null references locations(id),
  day         date not null,
  rating      numeric(2,1),
  count       int,
  primary key (location_id, day)
);
alter table google_daily enable row level security;
grant select, insert, update, delete on google_daily to service_role;

-- Monthly summary goes to admins once per month.
create table if not exists google_reports (
  month   date primary key,
  sent_at timestamptz not null default now()
);
alter table google_reports enable row level security;
grant select, insert, update, delete on google_reports to service_role;
