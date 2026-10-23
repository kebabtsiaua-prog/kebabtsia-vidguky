-- Ню Поінт = Львів, Чорновола 16 (owner, 2026-10-23). Its one October complaint from the review sheet.
insert into complaints (location_id, channel, happened_on, text, topics, source, external_id)
select l.id, 'Instagram', date '2026-10-11', 'без бонусу всі', '{"Додаток / бонуси"}', 'sheet', 'sheet:2026-10:newpoint-1011'
from locations l where l.name = 'Львів, Чорновола 16'
on conflict (external_id) do nothing;
update locations set aliases = array_append(aliases, 'Ню Поінт')
where name = 'Львів, Чорновола 16' and not ('Ню Поінт' = any(aliases));
