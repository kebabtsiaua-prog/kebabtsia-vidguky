-- Google Business Profile API (Basic API Access approved 2026-11-25): the owner signs in to Google once, the server
-- keeps the refresh token here and reads every review of every location, not just the 5 the Places API shows.
create table if not exists google_auth (
  id            int primary key default 1 check (id = 1),
  refresh_token text not null,
  connected_by  bigint,
  connected_at  timestamptz not null default now(),
  last_sync     timestamptz,
  last_error    text
);
alter table google_auth enable row level security;
grant select, insert, update, delete on google_auth to service_role;

alter table locations add column if not exists gbp_name text;          -- accounts/<account>/locations/<location>
alter table locations add column if not exists gbp_synced_at timestamptz; -- all reviews read up to this time

alter table google_reviews add column if not exists gbp_name text unique; -- accounts/…/locations/…/reviews/…
alter table google_reviews add column if not exists reply text;
alter table google_reviews add column if not exists reply_at timestamptz;
alter table google_reviews add column if not exists updated_at timestamptz;

-- Every 10 minutes. Until the owner connects Google the function answers «not connected» and does nothing.
select cron.schedule('gbp-sync', '*/10 * * * *', $$select net.http_get('https://obpmsgxanigythxkvrmh.supabase.co/functions/v1/gbp?sync=1', timeout_milliseconds := 120000)$$);
