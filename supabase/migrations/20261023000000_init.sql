-- «Відгуки Кебабця»: initial schema.
-- All tables are reachable only through the Edge Functions (service role); RLS is on with no policies,
-- so the public anon key cannot read or write anything.

create table locations (
  id          serial primary key,
  name        text not null unique,          -- "Львів, Валова 13"
  city        text not null,
  aliases     text[] not null default '{}',  -- other names people and Uployal use: "Семицвіт", "ВГ"…
  google_location text,                      -- Google Business Profile location id (stage 3)
  active      boolean not null default true
);

create table users (
  tg_id       bigint primary key,
  name        text not null,
  username    text,
  role        text not null check (role in ('admin', 'comms', 'loc_admin', 'operator')),
  location_id int references locations(id),  -- only for loc_admin
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table invites (
  code        text primary key,
  role        text not null check (role in ('admin', 'comms', 'loc_admin', 'operator')),
  location_id int references locations(id),
  name        text not null,
  created_by  bigint references users(tg_id),
  created_at  timestamptz not null default now(),
  used_by     bigint,
  used_at     timestamptz
);

create table complaints (
  id          bigserial primary key,
  location_id int not null references locations(id),
  channel     text not null,
  happened_on date not null default (now() at time zone 'Europe/Kyiv')::date,
  text        text not null,
  topics      text[] not null default '{}',
  solution    text not null default '',
  result      text not null default '',       -- empty = waiting for a decision
  who         text not null default '',       -- who handled the communication
  photo_path  text,                           -- object in the private "photos" bucket
  rating      smallint,                       -- stars, for Google / app ratings
  source      text not null default 'app',    -- app | bot | google | uployal
  external_id text unique,                    -- id in the source system, prevents duplicates
  created_by  bigint references users(tg_id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  resolved_at timestamptz
);
create index complaints_day_idx on complaints (happened_on);
create index complaints_loc_day_idx on complaints (location_id, happened_on);

-- Number of checks per location per month (Poster later, manual for now): complaints-to-checks ratio.
create table checks_monthly (
  location_id int not null references locations(id),
  month       date not null,                  -- first day of the month
  checks      int not null check (checks >= 0),
  primary key (location_id, month)
);

-- Google block per location per month, as at the bottom of each location in the reporting sheet.
create table google_monthly (
  location_id  int not null references locations(id),
  month        date not null,
  total        int,
  new_reviews  int,
  positive     int,
  negative     int,
  start_rating numeric(2,1),
  end_rating   numeric(2,1),
  primary key (location_id, month)
);

create table collabs (
  id          bigserial primary key,
  happened_on date not null,
  event       text not null,
  partner     text not null default '',
  ours        text not null default '',
  theirs      text not null default '',
  pros        text not null default '',
  cons        text not null default '',
  result      text not null default '',
  created_by  bigint references users(tg_id),
  created_at  timestamptz not null default now()
);

-- A complaint the bot has understood but the person has not confirmed yet.
create table bot_drafts (
  id          bigserial primary key,
  tg_id       bigint not null,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);

alter table locations      enable row level security;
alter table users          enable row level security;
alter table invites        enable row level security;
alter table complaints     enable row level security;
alter table checks_monthly enable row level security;
alter table google_monthly enable row level security;
alter table collabs        enable row level security;
alter table bot_drafts     enable row level security;

insert into storage.buckets (id, name, public) values ('photos', 'photos', false)
on conflict (id) do nothing;

-- Locations from the reporting sheet. Admins can rename them and add aliases in the app.
insert into locations (name, city) values
  ('Львів, Валова 13', 'Львів'),
  ('Львів, Героїв УПА 73', 'Львів'),
  ('Львів, Чорновола 16', 'Львів'),
  ('Львів, Шевченка 309', 'Львів'),
  ('Львів, Гетьмана Мазепи 1Б', 'Львів'),
  ('Львів, Крива Липа 8', 'Львів'),
  ('Львів, Княгині Ольги 100л', 'Львів'),
  ('Львів, Червоної Калини 109', 'Львів'),
  ('Львів, Чернівецька', 'Львів'),
  ('Львів, Хуторівка', 'Львів'),
  ('Львів, Під дубом', 'Львів'),
  ('Львів, Кульпарківська', 'Львів'),
  ('Львів, Широка', 'Львів'),
  ('Львів, Сокільники', 'Львів'),
  ('Львів, Шевченка 60', 'Львів'),
  ('Дрогобич', 'Дрогобич'),
  ('Стрий', 'Стрий'),
  ('Пустомити', 'Пустомити'),
  ('Поляниця', 'Поляниця'),
  ('Ужгород', 'Ужгород'),
  ('Буковель', 'Буковель'),
  ('Яремче', 'Яремче'),
  ('Чернівці, Небесної Сотні', 'Чернівці'),
  ('Івано-Франківськ, Бельведерська 28', 'Івано-Франківськ'),
  ('Луцьк, Крилова 6', 'Луцьк'),
  ('Шептицький', 'Шептицький'),
  ('Тернопіль, бульвар Шевченка', 'Тернопіль');
