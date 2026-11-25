-- Every new Google review goes to the team in the bot; they reply from the bot (owner 2026-11-25).
alter table google_reviews add column if not exists key serial;                 -- short id for bot buttons
create unique index if not exists google_reviews_key_idx on google_reviews (key);
alter table google_reviews add column if not exists tg_msgs jsonb not null default '[]'; -- [{chat_id, message_id}] of the cards
alter table google_reviews add column if not exists notified_at timestamptz;
alter table google_reviews add column if not exists replied_by text;            -- name of who answered from the bot
alter table google_reviews add column if not exists complaint_id int references complaints(id) on delete set null;
alter table google_reviews add column if not exists result text;                -- «Чим закінчилось» in the app
alter table google_reviews add column if not exists note text;
grant usage, select on sequence google_reviews_key_seq to service_role;

-- Link the complaints already made from Google reviews.
update google_reviews g set complaint_id = c.id
from complaints c where c.external_id = 'google:' || g.id and g.complaint_id is null;

-- A reply being written in the bot: one per person.
create table if not exists google_reply_drafts (
  tg_id      bigint primary key,
  review_key int not null,
  text       text,
  awaiting   boolean not null default false,   -- the next text message is the reply
  msg_id     int,                              -- the bot message with «Надіслати в Google?»
  created_at timestamptz not null default now()
);
alter table google_reply_drafts enable row level security;
grant select, insert, update, delete on google_reply_drafts to service_role;
