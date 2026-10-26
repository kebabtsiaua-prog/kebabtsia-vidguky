-- Some people get only the tour, no questions (owner 2026-10-26: Юра, the CEO). An invite can carry the question
-- set; 'tour' means the survey counts as done at sign-up and the cabinet opens after the tour.
alter table invites add column if not exists survey_set text;

-- Юра's invite, found by name so the access code itself never lands in this public repository.
update invites set survey_set = 'tour' where name ~* '^(юра|юрій|юрко|yura|yurii|yuriy)' and survey_set is null;
update users u set survey_set = 'tour', survey_due_at = coalesce(u.survey_due_at, now()), survey_done_at = coalesce(u.survey_done_at, now())
from invites i where i.used_by = u.tg_id and i.survey_set = 'tour' and u.survey_set is null;

-- Short morning report on reviews for the people who lead the company (owner 2026-10-26: Юра gets it every day).
alter table users add column if not exists morning_report boolean not null default false;
update users u set morning_report = true from invites i where i.used_by = u.tg_id and i.survey_set = 'tour';
create table if not exists morning_reports (
  tg_id bigint not null,
  day   date not null,
  primary key (tg_id, day)
);
alter table morning_reports enable row level security;
grant select, insert, update, delete on morning_reports to service_role;
