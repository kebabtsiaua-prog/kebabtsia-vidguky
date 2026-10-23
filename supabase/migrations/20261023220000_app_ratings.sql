-- Telegram groups the bot sits in (Uployal posts app order ratings there), and every rating for the monthly count.
create table if not exists tg_chats (
  chat_id         bigint primary key,
  title           text not null default '',
  type            text not null default '',
  location_id     int references locations(id),   -- learned from the ratings' addresses or the group title
  is_admin        boolean not null default false,
  "left"          boolean not null default false,
  messages        int not null default 0,
  ratings         int not null default 0,
  last_message_at timestamptz
);
alter table tg_chats enable row level security;
grant select, insert, update, delete on tg_chats to service_role;

create table if not exists app_ratings (
  id          bigserial primary key,
  location_id int not null references locations(id),
  rated_on    date not null,
  rating      smallint not null check (rating between 1 and 5),
  comment     text not null default '',
  external_id text not null unique,                -- uployal:<order> or tg:<chat>:<message>
  chat_id     bigint,
  created_at  timestamptz not null default now()
);
create index if not exists app_ratings_loc_day_idx on app_ratings (location_id, rated_on);
alter table app_ratings enable row level security;
grant select, insert, update, delete on app_ratings to service_role;
grant usage, select on sequence app_ratings_id_seq to service_role;
