-- Who gets a direct message about each negative app rating (owner, 2026-10-23: the comms managers Аня and Олена).
alter table users add column if not exists notify boolean;  -- null = not set; see recipients() in _shared/uployal.ts
