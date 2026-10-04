-- MarketPulse analytics + accounts — run ONCE in Supabase: Project → SQL Editor → New query → paste → Run.
-- Safe to re-run (everything is "if not exists").

create table if not exists visits (
  id           text primary key,            -- one browser-tab session
  visitor_id   text not null,               -- same browser across visits (anonymous)
  started_at   timestamptz not null,
  last_seen    timestamptz,
  duration_sec integer default 0,           -- active time on the site
  ip text, country text, region text, city text, isp text,
  device text, browser text, os text, screen text, lang text, tz text,
  referrer text,
  pages        jsonb default '[]'::jsonb,   -- tabs opened during the visit
  user_id      bigint, user_name text, user_email text
);
create index if not exists visits_started_idx on visits (started_at desc);
create index if not exists visits_visitor_idx on visits (visitor_id);

create table if not exists users (
  id         bigserial primary key,
  name       text not null,
  email      text not null unique,
  pass_hash  text not null,                 -- scrypt hash; the real password is never stored
  created_at timestamptz not null default now(),
  last_login timestamptz
);

-- Lock both tables away from the public API key. Only the server (secret key) can read/write.
alter table visits enable row level security;
alter table users  enable row level security;

-- Explicit grants for the server's secret key, so this works even when the project has
-- "Automatically expose new tables" switched off (the recommended setting).
grant select, insert, update, delete on table visits, users to service_role;
grant usage, select on sequence users_id_seq to service_role;
