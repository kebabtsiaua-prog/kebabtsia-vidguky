-- Complaint №93 was the owner's test of the bot (2026-10-26, «видали то була перевірка»). Guarded by its content,
-- so nothing else can be removed if the id ever points elsewhere.
delete from complaints c using locations l
where c.id = 93 and c.location_id = l.id and l.name = 'Буковель' and c.channel = 'Bolt' and c.text = 'Не приїхала доставка.';
