-- Google reviews the daily check has seen (Places API shows up to 5 per place). Low ones become complaints.
create table if not exists google_reviews (
  id           text primary key,                  -- places/<place>/reviews/<review>
  location_id  int not null references locations(id),
  rating       int,
  text         text,
  author       text,
  published_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists google_reviews_loc_idx on google_reviews (location_id, published_at);
alter table google_reviews enable row level security;
grant select, insert, update, delete on google_reviews to service_role;
