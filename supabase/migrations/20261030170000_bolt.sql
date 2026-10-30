-- Bolt reviews read by the Chrome extension from the Bolt Merchant page «Оцінки та відгуки» (2026-10-30).
-- Bolt names its stores («KEBABTSIA Chernivtsi»); each location lists the Bolt store names that are its.
alter table locations add column if not exists bolt_stores text[];
update locations set bolt_stores = '{"KEBABTSIA Chernivtsi"}' where name = 'Чернівці, Небесної Сотні';

create table if not exists bolt_reviews (
  id           text primary key,          -- store name + the row's id on the page
  store        text not null,
  location_id  int references locations(id),
  rated_at     timestamptz not null,
  rating       smallint,
  tags         text[] not null default '{}',
  text         text not null default '',
  complaint_id bigint references complaints(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists bolt_reviews_day_idx on bolt_reviews (rated_at);

alter table bolt_reviews enable row level security;
grant select, insert, update, delete on bolt_reviews to service_role;
