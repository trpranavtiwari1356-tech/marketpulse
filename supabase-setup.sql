-- MarketPulse analytics + accounts — run in Supabase: Project → SQL Editor → New query → paste → Run.
-- Safe to re-run after every update (everything is "if not exists" / "create or replace").

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
alter table visits add column if not exists source text;   -- campaign tag from a ?ref= / utm_source link
create index if not exists visits_started_idx on visits (started_at desc);
create index if not exists visits_visitor_idx on visits (visitor_id);
create index if not exists visits_visitor_started_idx on visits (visitor_id, started_at);
create index if not exists visits_user_idx on visits (user_id) where user_id is not null;

create table if not exists users (
  id         bigserial primary key,
  name       text not null,
  email      text not null unique,
  pass_hash  text not null,                 -- scrypt hash; the real password is never stored
  created_at timestamptz not null default now(),
  last_login timestamptz
);

-- Your own devices + friendly names, set from /admin ("This is me" / "Name").
create table if not exists visitor_labels (
  visitor_id text primary key,
  name       text,
  is_owner   boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Lock the tables away from the public API key. Only the server (secret key) can read/write.
alter table visits enable row level security;
alter table users  enable row level security;
alter table visitor_labels enable row level security;

-- Explicit grants for the server's secret key, so this works even when the project has
-- "Automatically expose new tables" switched off (the recommended setting).
grant select, insert, update, delete on table visits, users, visitor_labels to service_role;
grant usage, select on sequence users_id_seq to service_role;

-- ─────────── dashboard numbers, computed inside Postgres ───────────
-- The admin page asks for one period at a time; nothing scans more than it needs, and the
-- numbers stay exact however many visits pile up. Definitions (mirrored in visitors.js for
-- local dev — keep the two in step):
--   visit          = one browser-tab session (ends after 30 min of silence)
--   visitor        = one browser (anonymous id kept in the browser's storage)
--   new visitor    = a visitor whose first-ever visit is inside the period
--   engaged visit  = 10+ seconds of active time, or 2+ sections opened
--   buckets        = Indian time (Asia/Kolkata)
--   active time    = seconds the tab was visible and used (no input for 5 min = idle, not counted)
-- Your own devices (visitor_labels.is_owner) are left out unless p_include_me.

-- The previous period [p_prev_from, p_prev_to) is the same window shifted back (e.g. today so far vs
-- yesterday up to the same time), so the comparison is like for like.
drop function if exists mp_overview(timestamptz, timestamptz, timestamptz, boolean, text);
create or replace function mp_overview(p_from timestamptz, p_to timestamptz, p_prev_from timestamptz, p_prev_to timestamptz,
                                       p_include_me boolean default false, p_bucket text default 'day')
returns jsonb language sql stable set search_path = public as $$
with v as (
  select x.visitor_id, x.started_at, x.referrer, x.source, x.country, x.region, x.city, x.device, x.os,
         coalesce(x.pages, '[]'::jsonb) as pages, coalesce(x.duration_sec, 0) as secs
  from visits x
  where x.started_at >= least(p_from, coalesce(p_prev_from, p_from)) and x.started_at < p_to
    and (p_include_me or not exists (select 1 from visitor_labels l where l.visitor_id = x.visitor_id and l.is_owner))
),
firsts as (   -- first-ever visit of each visitor in the window: one index lookup per visitor
  select d.visitor_id, (select min(y.started_at) from visits y where y.visitor_id = d.visitor_id) as first_at
  from (select distinct visitor_id from v) d
),
cur  as (select v.*, f.first_at from v join firsts f using (visitor_id) where v.started_at >= p_from),
prev as (select v.*, f.first_at from v join firsts f using (visitor_id)
         where p_prev_from is not null and v.started_at >= p_prev_from and v.started_at < p_prev_to)
select jsonb_build_object(
  'cur', (select jsonb_build_object(
            'visitors', count(distinct visitor_id),
            'new_visitors', count(distinct visitor_id) filter (where first_at >= p_from),
            'visits', count(*), 'secs', coalesce(sum(secs), 0),
            'engaged', count(*) filter (where secs >= 10 or jsonb_array_length(pages) >= 2)) from cur),
  'prev', case when p_prev_from is null then null else (select jsonb_build_object(
            'visitors', count(distinct visitor_id),
            'new_visitors', count(distinct visitor_id) filter (where first_at >= p_prev_from),
            'visits', count(*), 'secs', coalesce(sum(secs), 0),
            'engaged', count(*) filter (where secs >= 10 or jsonb_array_length(pages) >= 2)) from prev) end,
  'series', (select coalesce(jsonb_agg(jsonb_build_object('t', to_char(b, 'YYYY-MM-DD"T"HH24:MI'),
                      'visitors', vis, 'new_visitors', nv, 'visits', n) order by b), '[]'::jsonb)
             from (select date_trunc(p_bucket, started_at at time zone 'Asia/Kolkata') as b,
                          count(distinct visitor_id) as vis,
                          count(distinct visitor_id) filter (where date_trunc(p_bucket, first_at at time zone 'Asia/Kolkata')
                                                                 = date_trunc(p_bucket, started_at at time zone 'Asia/Kolkata')) as nv,
                          count(*) as n
                   from cur group by 1) s),
  'sources', (select coalesce(jsonb_agg(jsonb_build_object('source', src, 'host', host, 'visits', n)), '[]'::jsonb)
              from (select nullif(source, '') as src,
                           lower(substring(referrer from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/:?#]+)')) as host,
                           count(*) as n
                    from cur group by 1, 2) s),
  'places', (select coalesce(jsonb_agg(jsonb_build_object('country', country, 'region', region, 'city', city, 'visitors', n)
                      order by n desc, country, region, city), '[]'::jsonb)
             from (select country, region, city, count(distinct visitor_id) as n from cur group by 1, 2, 3
                   order by n desc, country, region, city limit 50) s),
  'devices', (select coalesce(jsonb_agg(jsonb_build_object('device', device, 'visitors', n) order by n desc, device), '[]'::jsonb)
              from (select device, count(distinct visitor_id) as n from cur group by 1) s),
  'os', (select coalesce(jsonb_agg(jsonb_build_object('os', os, 'visitors', n) order by n desc, os), '[]'::jsonb)
         from (select os, count(distinct visitor_id) as n from cur group by 1) s),
  'sections', (select coalesce(jsonb_agg(jsonb_build_object('section', p, 'visits', n) order by n desc, p), '[]'::jsonb)
               from (select p, count(*) as n from cur, jsonb_array_elements_text(cur.pages) as p group by 1) s),
  'alltime', (select jsonb_build_object('visitors', count(distinct x.visitor_id), 'visits', count(*)) from visits x
              where p_include_me or not exists (select 1 from visitor_labels l where l.visitor_id = x.visitor_id and l.is_owner)),
  'users', (select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'visits', n, 'secs', s)), '[]'::jsonb)
            from (select user_id, count(*) as n, coalesce(sum(duration_sec), 0) as s
                  from visits where user_id is not null group by 1) u)
);
$$;

-- Visitors active in a period, most recent first, each with their all-time totals.
create or replace function mp_visitor_list(p_from timestamptz, p_to timestamptz, p_include_me boolean default false,
                                           p_limit integer default 50, p_offset integer default 0)
returns jsonb language sql stable set search_path = public as $$
with ids as (
  select x.visitor_id, max(coalesce(x.last_seen, x.started_at)) as ls
  from visits x
  where x.started_at >= p_from and x.started_at < p_to
    and (p_include_me or not exists (select 1 from visitor_labels l where l.visitor_id = x.visitor_id and l.is_owner))
  group by x.visitor_id
  order by ls desc, x.visitor_id
  limit least(greatest(p_limit, 1), 500) offset greatest(p_offset, 0)
)
select coalesce(jsonb_agg(to_jsonb(t) order by t.active_at desc, t.visitor_id), '[]'::jsonb) from (
  select i.visitor_id, i.ls as active_at, a.visits, a.total_sec, a.first_seen, a.last_seen,
         lv.ip, lv.isp, lv.city, lv.region, lv.country, lv.device, lv.os, lv.browser, lv.screen,
         fv.referrer, fv.source, pg.pages,
         lab.name as label, coalesce(lab.is_owner, false) as owner,
         un.user_name as name, un.user_email as email
  from ids i
  cross join lateral (select count(*) as visits, coalesce(sum(duration_sec), 0) as total_sec,
                             min(started_at) as first_seen, max(coalesce(last_seen, started_at)) as last_seen
                      from visits where visitor_id = i.visitor_id) a
  cross join lateral (select ip, isp, city, region, country, device, os, browser, screen
                      from visits where visitor_id = i.visitor_id order by started_at desc limit 1) lv
  cross join lateral (select referrer, source from visits where visitor_id = i.visitor_id order by started_at asc limit 1) fv
  cross join lateral (select coalesce(jsonb_agg(distinct p order by p), '[]'::jsonb) as pages
                      from visits y, jsonb_array_elements_text(coalesce(y.pages, '[]'::jsonb)) as p
                      where y.visitor_id = i.visitor_id) pg
  left join visitor_labels lab on lab.visitor_id = i.visitor_id
  left join lateral (select user_name, user_email from visits
                     where visitor_id = i.visitor_id and user_name is not null order by started_at desc limit 1) un on true
) t;
$$;

-- Only the server may call these (they read every visit); the public API key may not.
revoke execute on function mp_overview(timestamptz, timestamptz, timestamptz, timestamptz, boolean, text) from public, anon, authenticated;
revoke execute on function mp_visitor_list(timestamptz, timestamptz, boolean, integer, integer) from public, anon, authenticated;
grant execute on function mp_overview(timestamptz, timestamptz, timestamptz, timestamptz, boolean, text) to service_role;
grant execute on function mp_visitor_list(timestamptz, timestamptz, boolean, integer, integer) to service_role;
notify pgrst, 'reload schema';
