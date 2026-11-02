-- 2026-11-02, after comparing with the owner's Google Business Profile (33 verified companies).

-- Хуторівка was matched to a competitor's Google page (search took any name with «кебаб»). Forget that page and
-- everything taken from it; the daily run finds the chain's own page again by «Кебабця». The October start rating 3,7
-- came from the reporting sheet and stays.
update locations set google_place_id = null, google_address = null where id = 10;
delete from google_daily where location_id = 10;
delete from google_reviews where location_id = 10;
update google_monthly set end_rating = null, total = null, new_reviews = null where location_id = 10 and month = '2026-10-01';
delete from google_monthly where location_id = 10 and month >= '2026-11-01';

-- Five companies from the profile that the app did not have. All five are «Тимчасово зачинено» in Google, so they are
-- added switched off (active = false): they do not show in the tables until they open again.
insert into locations (name, city, aliases, active) values
  ('Луцьк, Грушевського 2', 'Луцьк', '{}', false),
  ('Сокільники, Зубрівська 27', 'Сокільники', '{"Зубрівська"}', false),
  ('Коломия', 'Коломия', '{"Чорновола 27"}', false),
  ('Рівне', 'Рівне', '{"Соборна"}', false),
  ('Львів, Зелена 151', 'Львів', '{"Зелена"}', false)
on conflict do nothing;
