-- Assistant bot (functions/asystent), stage 1: reminders and memory. Its own tables (as_*), so the complaints app is not touched;
-- it only reads `locations`. Business facts are not seeded here because this repository is public: the owner sends them
-- to the bot as a .txt file.

create table if not exists as_people (
  tg_id      bigint primary key,
  name       text not null,
  role       text not null default 'owner',
  created_at timestamptz not null default now()
);

create table if not exists as_memory (
  topic      text primary key,
  fact       text not null,
  updated_at timestamptz not null default now()
);

-- status: pending → sent (waiting for «Зроблено», nagged every hour, at most 3 times) → done | missed | cancelled.
-- repeat: null, or the owner's words: «щодня 10:00», «щопонеділка 10:00», «1-го числа 10:00».
create table if not exists as_reminders (
  id         bigint generated always as identity primary key,
  tg_id      bigint not null,
  text       text not null,
  due_at     timestamptz not null,
  repeat     text,
  status     text not null default 'pending',
  nags       int not null default 0,
  msg_id     bigint,
  created_at timestamptz not null default now(),
  closed_at  timestamptz
);
create index if not exists as_reminders_due on as_reminders (status, due_at);

create table if not exists as_messages (
  id         bigint generated always as identity primary key,
  tg_id      bigint not null,
  role       text not null,
  content    text not null,
  created_at timestamptz not null default now()
);
create index if not exists as_messages_by_person on as_messages (tg_id, id desc);

-- Small state: button labels under a message, a memory import waiting for «Так», the day of the last morning summary.
create table if not exists as_kv (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- How the owner likes to work (startova-pamiat.txt, 2026-10-27). Nothing private.
insert into as_memory (topic, fact) values
  ('Як зі мною працювати', 'Я не програміст. Пояснюй просто, українською, по одному кроку, кажи куди натиснути.'),
  ('Питання', 'Не більше 5–7 за раз. Якщо не зрозуміло, давай варіанти з номерами, я відповім цифрою.'),
  ('Секрети', 'Ніколи не проси паролі й токени в чаті. Кажи, куди вставити самому.'),
  ('Зміни', 'Спершу макет або чернетка з вигаданими даними, потім чекай «так». Без «так» нічого не запускати.'),
  ('Код', 'Весь код тримати в GitHub, нічого тільки на ноутбуці. Сервер оновлюється з GitHub автоматично.'),
  ('Після оновлення застосунку', 'Нагадай: зачекати 1–2 хвилини, закрити й відкрити застосунок у Телеграмі.'),
  ('Дизайн', 'Перевіряти на вузькому телефоні і в темній темі. Без порожніх місць, колонки рівні.')
on conflict (topic) do nothing;

alter table as_people enable row level security;
alter table as_memory enable row level security;
alter table as_reminders enable row level security;
alter table as_messages enable row level security;
alter table as_kv enable row level security;
grant select, insert, update, delete on as_people, as_memory, as_reminders, as_messages, as_kv to service_role;

-- Every minute the database calls the bot, which sends what is due. GitHub schedules run only every 5+ minutes and often late.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
select cron.unschedule('asystent-tick') where exists (select 1 from cron.job where jobname = 'asystent-tick');
select cron.schedule('asystent-tick', '* * * * *',
  $$select net.http_get('https://obpmsgxanigythxkvrmh.supabase.co/functions/v1/asystent?tick=1')$$);
