-- One-off bot messages to named people (see announce() in functions/bot): each key is sent once, whatever the number of deploys.
create table if not exists bot_announcements (
  key     text primary key,
  sent_at timestamptz not null default now(),
  info    jsonb
);
alter table bot_announcements enable row level security;
grant select, insert, update, delete on bot_announcements to service_role;
