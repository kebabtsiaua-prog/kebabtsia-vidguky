-- Names people use, shown in brackets after the address (owner, 2026-10-23). Old names stay as aliases.
update locations set aliases = array_append(aliases, v.alias), name = v.new_name
from (values
  ('Львів, Під дубом', 'Львів, Під дубом (ТРЦ Форум)', 'Форум'),
  ('Львів, Кульпарківська', 'Львів, Кульпарківська (ТРЦ Вікторія Гарденс)', 'Вікторія Гарденс'),
  ('Львів, Хуторівка', 'Львів, Хуторівка (Шувар)', 'Шувар'),
  ('Львів, Чернівецька', 'Львів, Чернівецька (Вокзал)', 'Вокзал'),
  ('Львів, Чорновола 16', 'Львів, Чорновола 16 (Ню Поінт)', 'Ню Поінт'),
  ('Львів, Шевченка 309', 'Львів, Шевченка 309 (Рясне)', 'Рясне'),
  ('Львів, Шевченка 60', 'Львів, Шевченка 60 (Семицвіт)', 'Семицвіт')
) as v(old_name, new_name, alias)
where locations.name = v.old_name;
-- array_append may repeat an alias that was already there; keep each once.
update locations set aliases = array(select distinct unnest(aliases)) where name like '%(%';
