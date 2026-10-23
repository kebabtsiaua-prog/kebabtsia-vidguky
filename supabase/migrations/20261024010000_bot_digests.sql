-- One morning digest per day (see digest() in functions/bot): a second run the same day sends nothing.
create table if not exists bot_digests (
  day     date primary key,
  sent_at timestamptz not null default now()
);
alter table bot_digests enable row level security;
grant select, insert, update, delete on bot_digests to service_role;
