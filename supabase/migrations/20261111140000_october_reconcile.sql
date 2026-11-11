-- October 2026 reconciliation against the girls' sheets (2026-11-11, user said «так»).
-- 1) duplicates merged, 2) wrong date / channel fixed, 3) low Google reviews the first check skipped,
-- 4) complaints that are in the sheets but never reached the app. Re-running is safe.

-- Ids that were merged into another complaint. Importers (sheet sync, Google, Glovo, Bolt) skip these ids,
-- so a merged duplicate never comes back.
-- For a copy merged away the text, place, day and channel are kept too, so a copy typed again later is recognised.
create table if not exists complaint_aliases (
  external_id text primary key,
  complaint_id bigint not null references complaints(id) on delete cascade,
  location_id int references locations(id),
  happened_on date,
  channel text,
  text text,
  created_at timestamptz not null default now()
);
create index if not exists complaint_aliases_loc_day on complaint_aliases (location_id, happened_on);
grant all on complaint_aliases to service_role;
alter table complaint_aliases enable row level security;

-- 1) Duplicates: keep the one the team already worked on (solution, photo), drop the other.
do $$
declare d record;
begin
  for d in select * from (values (12::bigint, 130::bigint), (22, 128), (137, 122)) as v(drop_id, keep_id) loop
    if exists (select 1 from complaints where id = d.drop_id) and exists (select 1 from complaints where id = d.keep_id) then
      insert into complaint_aliases (external_id, complaint_id, location_id, happened_on, channel, text)
        select coalesce(external_id, 'merged:' || id), d.keep_id, location_id, happened_on, channel, text from complaints where id = d.drop_id
        on conflict (external_id) do nothing;
      update complaints k set rating = coalesce(k.rating, x.rating), topics = case when cardinality(k.topics) = 0 then x.topics else k.topics end
        from complaints x where k.id = d.keep_id and x.id = d.drop_id;
      delete from complaints where id = d.drop_id;
    end if;
  end loop;
end $$;

-- 2) Wrong month / channel
update complaints set happened_on = '2026-10-31', rating = coalesce(rating, 1) where id = 120 and happened_on = '2026-11-02';
update complaints set channel = 'Google', happened_on = '2026-10-10', rating = 1 where id = 27 and channel = 'Bolt';

-- 3) Low Google reviews the bot saw on its first check (23.10) but skipped as "older than 2 days"
insert into complaints (location_id, channel, happened_on, text, rating, topics, source, external_id)
select g.location_id, 'Google', (g.published_at at time zone 'Europe/Kyiv')::date, g.text, g.rating, v.topics::text[], 'google', 'google:' || g.id
from (values
  ('places/ChIJY5ExRlXdOkcRF0GVk1o56x8/reviews/Ci9DQUlRQUNvZENodHljRjlvT21wRWQzSTVUVXRQYVc1dlMyRlRWVWRXTlV0U2RsRRAB', '{"М''ясо","Забули додаток"}'),
  ('places/ChIJ-QRBLQ4lN0cRqf8CZXaXHpA/reviews/Ci9DQUlRQUNvZENodHljRjlvT2xKT2RIUmhZbmxsTlZSeGNFeERWVzExY25FNVEzYxAB', '{"Персонал"}'),
  ('places/ChIJ-QRBLQ4lN0cRqf8CZXaXHpA/reviews/Ci9DQUlRQUNvZENodHljRjlvT21oSFIzaFZWMUJDYlhoVllrSnhiMHRHTjNaRE1GRRAB', '{"Персонал"}'),
  ('places/ChIJv5VozYrBMEcRbq0p89rZMNM/reviews/Ci9DQUlRQUNvZENodHljRjlvT2xjMFkycDRZV1pzTldObE5XWmthbmhvYTJKd1FVRRAB', '{"Персонал","М''ясо"}')
) as v(gid, topics)
join google_reviews g on g.id = v.gid
on conflict (external_id) do nothing;

-- 4) In the sheets, not in the app (operators, Glovo/Bolt before the feeds, app ratings lost around 23.10, manual)
insert into complaints (location_id, channel, happened_on, text, topics, source, external_id)
select v.loc, v.channel, v.d::date, v.text, v.topics::text[], 'sheet', 'sheet:2026-10:' || left(md5(v.loc || v.channel || v.d || v.text), 10)
from (values
  (2, 'Оператори', '2026-10-03', 'мав бути максі зробили міні', '{"Розмір і ціна"}'),
  (7, 'Оператори', '2026-10-15', 'замовляли бокси а зробили кебаби', '{"Забули додаток"}'),
  (9, 'Оператори', '2026-10-16', 'не поклали 3 коли', '{"Забули додаток"}'),
  (1, 'Оператори', '2026-10-16', 'замість боксу зробили кебаб', '{"Забули додаток"}'),
  (1, 'Оператори', '2026-10-23', 'зробили цезар замість фірмового', '{"Забули додаток"}'),
  (1, 'Оператори', '2026-10-31', 'не поклали картоплю', '{"Забули додаток"}'),
  (8, 'Оператори', '2026-10-21', 'не поклали 1 кебаб', '{"Забули додаток"}'),
  (12, 'Оператори', '2026-10-25', 'за останні рази дуже спортився ваш кебаб у victoria gardens. кебаб весь розпадається весь соус витікає. стало дуже пересушене м''ясо', '{"Розвалюється","М''ясо","Соус"}'),
  (5, 'Оператори', '2026-10-24', 'замовляв у закладі просив без огірка і цибулі, зробили з усім', '{"Овочі / капуста"}'),
  (15, 'Оператори', '2026-10-30', 'зробили міні замість максі', '{"Розмір і ціна"}'),
  (6, 'Оператори', '2026-10-30', 'замість боксів зробили кебаби', '{"Забули додаток"}'),
  (2, 'Glovo', '2026-10-11', 'тайська кукурудза відчутня. замість халапеньйо просто спеції. не замовляйте додатки.', '{"Забули додаток"}'),
  (2, 'Glovo', '2026-10-15', 'Привезли не той кебаб, замовляв гострий з мясом а привезли якийсь з яйцями', '{"Доставка"}'),
  (11, 'Glovo', '2026-10-14', 'Зробили з огірком, мало бути без', '{"Овочі / капуста"}'),
  (12, 'Glovo', '2026-10-07', 'Пекінська капуста просто зіпсувала все. Плюс таке враження що забули додати сіль взагалі. Кебаб на половину складався із самої капусти та лише кілька скибок огірка було.', '{"Овочі / капуста"}'),
  (12, 'Glovo', '2026-10-13', 'Кебаб холодний, ні в що не замотаний, просто коробка без фольги, халапеньйо можливо пластерок поклали', '{"Холодний","Забули додаток"}'),
  (3, 'Glovo', '2026-10-10', 'в меню не було кебабу з куркою', '{"Доставка"}'),
  (10, 'Glovo', '2026-10-18', 'Замовила кебаб Hangover. Отримала найгіршу шаурму, яку я їла. Замість айсбергу півкебабу твердої частини від пекінської капусти, жодного шматочка бекону, а замість «фірмового айолі» гострий кетчонез, лаваш розлазився', '{"Овочі / капуста","Соус","Розвалюється","Забули додаток"}'),
  (7, 'Glovo', '2026-10-15', 'Немає перцю халапеньйо, а я оплатила з перцем.', '{"Забули додаток"}'),
  (7, 'Glovo', '2026-10-25', 'Замовляв соус, оплатив, його не поклали до замовлення', '{"Забули додаток","Соус"}'),
  (1, 'Glovo', '2026-10-23', 'Мені прислали не той кебаб', '{"Доставка"}'),
  (5, 'Glovo', '2026-10-06', 'кебаб мав бути без помідорів зробили з', '{"Овочі / капуста"}'),
  (5, 'Glovo', '2026-10-07', 'цвілий лаваш', '{"Сторонній предмет"}'),
  (1, 'Bolt', '2026-10-01', 'підсмажено або підгоріло', '{"М''ясо"}'),
  (1, 'Bolt', '2026-10-08', 'не дали колу', '{"Забули додаток"}'),
  (1, 'Bolt', '2026-10-23', 'не правильні товари, проігнорували примітки', '{"Забули додаток"}'),
  (5, 'Bolt', '2026-10-04', 'Пиріжки були гарячі, а кебаб холодний. Доставка від Спартака до мене займає 5 хвилин, тому напевно мені просто поклали холодний кебаб', '{"Холодний"}'),
  (1, 'Оцінки в додатку', '2026-10-23', 'Хоча я спеціально сказав їм добре розігріти його та не додавати забагато соусу, вони не послухали. Соус буквально забризкав мене, поки я їв.', '{"Соус","Холодний"}'),
  (1, 'Оцінки в додатку', '2026-10-23', 'Кебаб був трохи холодним, не було курки, її трохи не вистачає для смаку', '{"Холодний","М''ясо"}'),
  (3, 'Оцінки в додатку', '2026-10-23', 'Просто жах. Замість соусу в шаурмі вода якась, ні смаку ні жирності, ще й знову чайна ложка його на всю шаурму, шаурма явно на 30% менша ніж завжди і майже нічого не важить. В гостру поставили 2 шт халапеньо.', '{"Соус","Розмір і ціна"}'),
  (5, 'Оцінки в додатку', '2026-10-12', 'Мʼясо курки сухе, ви втрачаєте позиції, я вас люблю але виправляйтесь', '{"М''ясо"}'),
  (5, 'Оцінки в додатку', '2026-10-23', 'Сьогодні чомусь був присмак несвіжого йогурту. Прохання ретельніше перевіряти дати приготування!', '{"Соус"}'),
  (15, 'Оцінки в додатку', '2026-10-21', 'Кебаби всередині ледве теплі. Скручуєте як завжди погано, розвалюється моментально. Без подвійного мʼяса всередині дуже мало мʼяса. Розподіл начинки нерівномірний. Якщо я додаю халапеньйо я не хочу вкусити 4 штуки в одному укусі а потім пів шаурми його не бачити. НАЛАГОДІТЬ ЯКІСТЬ', '{"Холодний","Розвалюється","М''ясо"}'),
  (2, 'Оцінки в додатку', '2026-10-07', 'довге очікування', '{"Довге очікування"}'),
  (11, 'Telegram', '2026-10-25', 'Розвалюється, мясо холодне і пересушене, соус витікає', '{"Розвалюється","Холодний","М''ясо","Соус"}'),
  (12, 'Instagram', '2026-10-03', 'волосина у кебабі', '{"Сторонній предмет"}'),
  (12, 'Google', '2026-10-27', 'Останнім часом дуже спортився кебаб. Мʼясо жахливо пересушене, кебаб весь розлітається і відповідно весь витікає', '{"М''ясо","Розвалюється"}'),
  (24, 'Google', '2026-10-22', 'шавуха топ, касир діана максимально неприємна', '{"Персонал"}')
) as v(loc, channel, d, text, topics)
on conflict (external_id) do nothing;

-- 5) October 4–5★ app ratings with a complaint in the text, which the girls counted (owner 2026-11-11: such ratings
--    are complaints from now on).
insert into complaints (location_id, channel, happened_on, text, rating, topics, source, external_id)
select r.location_id, 'Оцінки в додатку', r.rated_on, r.comment, r.rating, v.topics::text[], 'uployal', r.external_id
from (values
  (2, '2026-10-30', 'Був частково холодним%', '{"Холодний","Розмір і ціна"}'),
  (1, '2026-10-22', 'Вже третій раз приходжу на сніданковий%', '{"Забули додаток"}'),
  (5, '2026-10-14', 'Все файно, але просила кебаб без огірка%', '{"Овочі / капуста"}'),
  (15, '2026-10-14', 'добре, порвався%', '{"Розвалюється"}'),
  (11, '2026-10-02', 'не погано но довго чекав%', '{"Довге очікування"}'),
  (3, '2026-10-09', 'загалом добре але занадто пересолений%', '{"М''ясо"}')
) as v(loc, d, pat, topics)
join app_ratings r on r.location_id = v.loc and r.rated_on = v.d::date and r.comment ilike v.pat
where r.external_id is not null
on conflict (external_id) do nothing;
