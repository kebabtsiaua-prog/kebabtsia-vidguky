-- Store names in Bolt's daily «Ratings_and_Comments» email: «<City> · <Provider Name>» (2026-11-09).
update locations set bolt_stores = array(select distinct unnest(coalesce(bolt_stores, '{}') || m.names))
from (values
  (23, array['Chernivtsi · Кебабця']),
  (16, array['Drohobych · Кебабця']),
  (24, array['Ivano-Frankivsk · Кебабця вул. Бельведерська']),
  (28, array['Ivano-Frankivsk · Кебабця вул. Чорновола']),
  (25, array['Lutsk · Кебабця']),
  (27, array['Ternopil · Кебабця']),
  (6,  array['Lviv · Кебабця Крива Липа']),
  (8,  array['Lviv · Кебабця Червоної калини']),
  (10, array['Lviv · Кебабця Шувар']),
  (1,  array['Lviv · Кебабця вул. Валова']),
  (2,  array['Lviv · Кебабця вул. Героїв УПА']),
  (7,  array['Lviv · Кебабця вул. Княгині Ольги']),
  (12, array['Lviv · Кебабця вул. Кульпарківська']),
  (9,  array['Lviv · Кебабця вул. Чернівецька']),
  (3,  array['Lviv · Кебабця вул. Чорновола']),
  (15, array['Lviv · Кебабця вул. Шевченка, 60']),
  (13, array['Lviv · Кебабця вул. Широка']),
  (5,  array['Lviv · Кебабця вул. Мазепи'])
) as m(id, names)
where locations.id = m.id;
