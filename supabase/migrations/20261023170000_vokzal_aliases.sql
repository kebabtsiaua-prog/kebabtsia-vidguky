-- Вокзал = Львів, Чернівецька (owner, 2026-10-23). October 2026 complaints from the «Вокзал Жовтень 26» tab.
insert into complaints (location_id, channel, happened_on, text, rating, topics, source, external_id)
select l.id, v.channel, v.d::date, v.text, v.rating, v.topics::text[], 'sheet', v.ext
from (values
  ('2026-10-01', 'Bolt', 'Кебаб ніби скис, зазвичай мені попадалися мариновані огірки, бо квашені в кебабі з йогуртовим соусом..🤢ще був дивний присмак мʼяса як не свіже , соус дуже рідкий, кебаб розмокає, і ще холодний кебаб, приправ забагато, і обрізки з помідорів ніби.🤮РАНОК…', null::smallint, '{"М''ясо","Соус","Холодний","Овочі / капуста"}', 'sheet:2026-10:70e023a23f'),
  ('2026-10-02', 'Оцінки в додатку', 'Кебабця вже не та😔лаваш був занадто тонкий, все розвалилось', 2, '{"Розвалюється"}', 'sheet:2026-10:cebeabaef2'),
  ('2026-10-09', 'Bolt', 'Кебаб просто зорвалюється , це не вартує своїх грошей  (доставка або самовиніс)', null::smallint, '{"Розвалюється","Розмір і ціна"}', 'sheet:2026-10:a08b029b9d')
) as v(d, channel, text, rating, topics, ext)
join locations l on l.name = 'Львів, Чернівецька'
on conflict (external_id) do nothing;
update locations set aliases = array['Вокзал'] where name = 'Львів, Чернівецька' and not ('Вокзал' = any(aliases));
update locations set aliases = array_cat(aliases, v.a) from (values
  ('Львів, Кульпарківська', array['Вікторія','Victoria Gardens','ВГ']),
  ('Львів, Хуторівка', array['Шувар']),
  ('Львів, Шевченка 309', array['Рясне']),
  ('Львів, Широка', array['Левандівка']),
  ('Львів, Гетьмана Мазепи 1Б', array['Спартак']),
  ('Львів, Княгині Ольги 100л', array['Ольги']),
  ('Львів, Героїв УПА 73', array['УПА']),
  ('Львів, Червоної Калини 109', array['Сихів'])
) as v(n, a) where locations.name = v.n and cardinality(locations.aliases) = 0;
