-- Since 2026 Supabase no longer grants API roles access to new public tables.
-- Only the server (service_role) talks to the database; the app and bot never use anon keys.
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to service_role;
