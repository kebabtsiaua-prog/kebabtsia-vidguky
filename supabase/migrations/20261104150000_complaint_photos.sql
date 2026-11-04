-- A complaint can carry up to 6 screenshots (a long chat takes several, 2026-11-04).
-- photo_path stays the first one, so older code and the bot keep working; photo_paths lists all of them in order.
alter table complaints add column if not exists photo_paths text[] not null default '{}';
update complaints set photo_paths = array[photo_path] where photo_path is not null and photo_paths = '{}';
