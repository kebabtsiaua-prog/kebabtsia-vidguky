-- Team survey before the cabinet opens (functions/_shared/survey.ts). A person is locked out of the cabinet
-- from survey_due_at (the owner invites) until both survey_done_at and tour_done_at are set.
alter table users add column if not exists survey_set text;          -- null = by role; 'none' = never asked
alter table users add column if not exists survey_due_at timestamptz;
alter table users add column if not exists survey_done_at timestamptz;
alter table users add column if not exists tour_done_at timestamptz;

-- The owner is the first administrator; they are never asked.
update users set survey_set = 'none'
where tg_id = (select tg_id from users where role = 'admin' order by created_at limit 1) and survey_set is null;

create table if not exists survey_answers (
  tg_id      bigint not null references users(tg_id) on delete cascade,
  q          int not null,
  answer     text not null,
  asked      text,                       -- the follow-up question the AI asked, if any
  updated_at timestamptz not null default now(),
  primary key (tg_id, q)
);
create table if not exists survey_reminders (
  tg_id bigint not null,
  day   date not null,
  primary key (tg_id, day)
);
-- Remarks about the app, sent to the bot with «Зауваження до апки».
create table if not exists app_feedback (
  id         bigserial primary key,
  tg_id      bigint not null,
  name       text not null,
  text       text not null,
  created_at timestamptz not null default now()
);
alter table survey_answers enable row level security;
alter table survey_reminders enable row level security;
alter table app_feedback enable row level security;
grant select, insert, update, delete on survey_answers, survey_reminders, app_feedback to service_role;
grant usage, select on sequence app_feedback_id_seq to service_role;

-- «Зауваження до апки» pressed: the next message from this person is a remark, not a complaint.
alter table users add column if not exists feedback_wait_at timestamptz;
