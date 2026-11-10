-- Glovo store 878812 «Kebabtsia / Кебабця (вул. Франка І) [LVI]» is Сокільники (вул. Франка бічна, 2), 2026-11-10.
-- Its 10 reviews from 30.10–09.11 had no text, so no complaints were lost; they are linked to the location here.
update locations set glovo_ids = array(select distinct unnest(coalesce(glovo_ids, '{}') || array[878812])) where id = 14;
update glovo_reviews set location_id = 14 where store_id = 878812 and location_id is null;
