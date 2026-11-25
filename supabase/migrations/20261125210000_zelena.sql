-- New location «Львів, Зелена 151» (owner 2026-11-25), found among the Google Business Profiles; admin Настя.
-- The other four extra profiles (Коломия, Рівне, Зубрівська, Луцьк Грушевського) are closed in Google and are not added.
insert into locations (name, city, aliases, google_place_id, google_address, gbp_name)
select 'Львів, Зелена 151', 'Львів', '{"Зелена"}', 'ChIJYUGF3LHpOkcR9GQ7ZEnejWE', 'вулиця Зелена, 151, Львів',
       'accounts/113224071207706444213/locations/2887701961984785717'
where not exists (select 1 from locations where name = 'Львів, Зелена 151');

insert into user_locations (tg_id, location_id)
select 965058499, id from locations where name = 'Львів, Зелена 151'
on conflict do nothing;
