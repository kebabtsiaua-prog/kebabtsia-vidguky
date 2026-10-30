-- Glovo reviews from the daily «Відгуки щодня» report (owner 2026-10-30). Glovo emails only a link to the portal,
-- so the owner forwards the .csv file to the bot; the bot reminds them in the evening.

-- Glovo store IDs (the «ID закладу» column) for each location, taken from the first report.
alter table locations add column if not exists glovo_ids int[];
update locations l set glovo_ids = m.ids from (values
  ('Дрогобич', '{761539}'::int[]),
  ('Львів, Червоної Калини 109', '{795986}'),
  ('Львів, Гетьмана Мазепи 1Б', '{797926}'),
  ('Львів, Валова 13', '{797934}'),
  ('Львів, Княгині Ольги 100л', '{797939}'),
  ('Львів, Крива Липа 8', '{797970}'),
  ('Львів, Героїв УПА 73', '{806262}'),
  ('Львів, Чернівецька (Вокзал)', '{830308}'),
  ('Львів, Хуторівка (Шувар)', '{837332}'),
  ('Львів, Кульпарківська (ТРЦ Вікторія Гарденс)', '{896006}'),
  ('Чернівці, Небесної Сотні', '{900817}'),
  ('Львів, Під дубом (ТРЦ Форум)', '{902000}'),
  ('Тернопіль, бульвар Шевченка', '{924790}')
) as m(name, ids) where l.name = m.name;

-- Every row of the report, also ratings without text: duplicates are skipped by order ID.
create table if not exists glovo_reviews (
  order_id     text primary key,
  store_id     int not null,
  store_name   text not null default '',
  location_id  int references locations(id),
  rated_on     date not null,
  rating       smallint,
  text         text not null default '',
  complaint_id bigint references complaints(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists glovo_reviews_day_idx on glovo_reviews (rated_on);

-- Glovo and Bolt complaints: the location admin presses «беру в роботу» (owner 2026-10-27).
alter table complaints add column if not exists taken_by bigint references users(tg_id);
alter table complaints add column if not exists taken_at timestamptz;

-- The alert messages sent about a complaint, so they can be updated once someone takes it.
create table if not exists complaint_alerts (
  complaint_id bigint not null references complaints(id) on delete cascade,
  chat_id      bigint not null,
  message_id   int not null,
  boss         boolean not null default false,  -- owner, Роман, Юра: they see whether the admin took it
  primary key (complaint_id, chat_id)
);

alter table glovo_reviews enable row level security;
alter table complaint_alerts enable row level security;
grant select, insert, update, delete on glovo_reviews, complaint_alerts to service_role;
