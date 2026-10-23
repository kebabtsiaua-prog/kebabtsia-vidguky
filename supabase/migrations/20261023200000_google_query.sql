-- Text used to find a location in Google when its name alone finds the wrong place.
alter table locations add column if not exists google_query text;
-- Хуторівка was matched to the Широка place; search again near the Шувар market.
update locations set google_query = 'Кебабця Шувар Хуторівка Львів', google_place_id = null, google_address = null
where name = 'Львів, Хуторівка';
delete from google_daily where day = date '2026-10-23'
  and location_id = (select id from locations where name = 'Львів, Хуторівка');
