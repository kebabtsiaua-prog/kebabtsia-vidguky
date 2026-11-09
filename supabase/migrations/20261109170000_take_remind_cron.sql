-- GitHub runs scheduled workflows hours late (digest.yml set for 07:00 UTC ran at 13:40–15:04 UTC on 5–8 Nov),
-- so the «беру в роботу» reminders run from the database instead: 08/12/16 UTC = 10:00, 14:00, 18:00 Kyiv in winter.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('take-remind-10', '0 8 * * *', $$select net.http_get('https://obpmsgxanigythxkvrmh.supabase.co/functions/v1/bot?take_remind=10')$$);
select cron.schedule('take-remind-14', '0 12 * * *', $$select net.http_get('https://obpmsgxanigythxkvrmh.supabase.co/functions/v1/bot?take_remind=14')$$);
select cron.schedule('take-remind-18', '0 16 * * *', $$select net.http_get('https://obpmsgxanigythxkvrmh.supabase.co/functions/v1/bot?take_remind=18')$$);
