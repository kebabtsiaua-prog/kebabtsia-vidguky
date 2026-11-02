-- Fixes after the 2026-11-01 audit (owner's go-ahead 2026-11-02).

-- Checks typed by hand in «Налаштування → Чеки» win over Poster: the daily Poster run skips them.
alter table checks_monthly add column if not exists manual boolean not null default false;

-- «Були нові скарги?» three times a day: who was asked, when, and what they answered (none / added).
create table if not exists checkins (
  tg_id       bigint not null,
  slot        text not null,              -- Kyiv time, «2026-11-02 12:00»
  sent_at     timestamptz not null default now(),
  message_id  bigint,
  answer      text,                       -- 'none' or 'added'
  answered_at timestamptz,
  primary key (tg_id, slot)
);
create index if not exists checkins_sent_idx on checkins (sent_at);
alter table checkins enable row level security;
grant select, insert, update, delete on checkins to service_role;

-- A month whose first Google snapshot came from another listing got a negative «new reviews».
update google_monthly set new_reviews = 0 where new_reviews < 0;
