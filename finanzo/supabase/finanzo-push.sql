-- Finanzo: Mitteilungen aufs Handy (einmal im SQL Editor von Supabase ausführen)
-- Vorher die Edge Function „finanzo-push“ anlegen. Man kann diese Datei gefahrlos mehrmals ausführen.

-- 1) Werkzeuge: Zeitplan (jede Minute nachsehen) und Internet-Anfragen aus der Datenbank
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2) Tabellen
-- Geräte, die Mitteilungen bekommen (iPhone, PC …)
create table if not exists public.push_subs (
  endpoint   text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now(),
  last_ok    timestamptz
);
create index if not exists push_subs_user on public.push_subs(user_id);

-- Geplante Mitteilungen (die App trägt sie ein)
create table if not exists public.push_jobs (
  id       bigint generated always as identity primary key,
  user_id  uuid not null references auth.users(id) on delete cascade,
  key      text not null,
  send_at  timestamptz not null,
  title    text not null,
  body     text not null default '',
  sent_at  timestamptz,
  unique (user_id, key)
);
create index if not exists push_jobs_due on public.push_jobs(send_at) where sent_at is null;

-- Einstellungen (Adresse der Funktion und Schlüssel). Nur die Datenbank selbst kommt da ran.
create table if not exists public.push_config (
  id         int primary key default 1 check (id = 1),
  fn_url     text not null,
  public_key text,
  jwk        jsonb,
  init_req   bigint,
  init_at    timestamptz
);
insert into public.push_config (id, fn_url)
values (1, 'https://tmdagajpcdpeurqpmdih.supabase.co/functions/v1/finanzo-push')
on conflict (id) do update set fn_url = excluded.fn_url;

-- Offene Antworten der Funktion
create table if not exists public.push_log (
  req_id     bigint primary key,
  created_at timestamptz not null default now()
);

-- 3) Schutz: niemand kommt von außen direkt an die Tabellen, nur über die Funktionen unten
alter table public.push_subs   enable row level security;
alter table public.push_jobs   enable row level security;
alter table public.push_config enable row level security;
alter table public.push_log    enable row level security;
revoke all on public.push_subs, public.push_jobs, public.push_config, public.push_log from anon, authenticated;

-- 4) Funktionen für die App
-- Öffentlicher Schlüssel (darf jeder sehen, wie eine Adresse)
create or replace function public.push_public_key()
returns text language sql stable security definer set search_path = '' as $$
  select public_key from public.push_config where id = 1;
$$;

-- Dieses Gerät anmelden
create or replace function public.push_subscribe(endpoint_url text, p256dh_key text, auth_secret text)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not logged in'; end if;
  if endpoint_url is null or endpoint_url !~ '^https://' or length(endpoint_url) > 1000
     or coalesce(length(p256dh_key), 0) not between 80 and 100 or coalesce(length(auth_secret), 0) not between 16 and 30 then
    raise exception 'bad subscription';
  end if;
  insert into public.push_subs as s (endpoint, user_id, p256dh, auth)
  values (endpoint_url, uid, p256dh_key, auth_secret)
  on conflict (endpoint) do update
    set user_id = uid, p256dh = excluded.p256dh, auth = excluded.auth,
        created_at = case when s.user_id = uid then s.created_at else now() end;
  -- höchstens 10 Geräte pro Konto
  delete from public.push_subs d where d.user_id = uid and d.endpoint in (
    select x.endpoint from public.push_subs x where x.user_id = uid order by x.created_at desc offset 10);
end $$;

-- Dieses Gerät abmelden
create or replace function public.push_unsubscribe(endpoint_url text)
returns void language sql security definer set search_path = '' as $$
  delete from public.push_subs where endpoint = endpoint_url and user_id = auth.uid();
$$;

-- Geplante Mitteilungen ersetzen (schon verschickte bleiben, damit nichts doppelt kommt)
create or replace function public.push_set_jobs(jobs jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not logged in'; end if;
  if jsonb_typeof(jobs) <> 'array' then raise exception 'bad jobs'; end if;
  delete from public.push_jobs where user_id = uid and sent_at is null;
  insert into public.push_jobs (user_id, key, send_at, title, body)
  select uid, left(j->>'key', 200), (j->>'at')::timestamptz, left(coalesce(j->>'title', ''), 200), left(coalesce(j->>'body', ''), 500)
  from (select value as j from jsonb_array_elements(jobs) limit 300) x
  where coalesce(j->>'key', '') <> '' and (j->>'at')::timestamptz > now() - interval '10 minutes'
  on conflict (user_id, key) do nothing;
end $$;

-- Test-Mitteilung (kommt in spätestens einer Minute)
create or replace function public.push_test(title text, body text)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not logged in'; end if;
  if (select count(*) from public.push_jobs where user_id = uid and key like 'test|%' and send_at > now() - interval '1 minute') >= 3 then
    raise exception 'too many tests';
  end if;
  insert into public.push_jobs (user_id, key, send_at, title, body)
  values (uid, 'test|' || gen_random_uuid(), now(), left(coalesce(title, ''), 200), left(coalesce(body, ''), 500));
end $$;

-- Für die App: ist alles bereit und kommt etwas an?
create or replace function public.push_status(endpoint_url text default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'ready',    (select public_key is not null from public.push_config where id = 1),
    'device',   exists(select 1 from public.push_subs s where s.endpoint = endpoint_url and s.user_id = auth.uid()),
    'devices',  (select count(*) from public.push_subs s where s.user_id = auth.uid()),
    'last_ok',  (select max(last_ok) from public.push_subs s where s.user_id = auth.uid())
  );
$$;

-- 5) Jede Minute: fällige Mitteilungen an die Funktion geben
create or replace function public.push_json(t text)
returns jsonb language plpgsql immutable set search_path = '' as $$
begin return t::jsonb; exception when others then return null; end $$;

create or replace function public.push_tick()
returns void language plpgsql security definer set search_path = '' as $$
declare
  cfg  public.push_config;
  r    record;
  j    jsonb;
  msgs jsonb;
begin
  select * into cfg from public.push_config where id = 1;
  if not found then return; end if;

  -- a) Noch kein Schlüssel: die Funktion erzeugt einen, die Datenbank merkt ihn sich
  if cfg.jwk is null then
    if cfg.init_req is not null then
      select status_code, content into r from net._http_response where id = cfg.init_req;
      if found then
        j := case when r.status_code = 200 then public.push_json(r.content) end;
        begin delete from net._http_response where id = cfg.init_req; exception when others then null; end;
        if j ? 'jwk' and j ? 'publicKey' then
          update public.push_config set jwk = j->'jwk', public_key = j->>'publicKey', init_req = null, init_at = null where id = 1;
          return;
        end if;
      elsif cfg.init_at > now() - interval '2 minutes' then
        return; -- Antwort kommt noch
      end if;
    end if;
    update public.push_config
      set init_req = net.http_post(url := cfg.fn_url, body := '{"action":"keys"}'::jsonb, timeout_milliseconds := 15000),
          init_at = now()
      where id = 1;
    return;
  end if;

  -- b) Antworten der letzten Runden: abgemeldete Geräte löschen, erfolgreiche merken
  for r in select l.req_id, h.status_code, h.content from public.push_log l join net._http_response h on h.id = l.req_id loop
    j := case when r.status_code = 200 then public.push_json(r.content) end;
    if j ? 'results' then
      delete from public.push_subs where endpoint in (
        select x->>'endpoint' from jsonb_array_elements(j->'results') x where (x->>'status') in ('404', '410'));
      update public.push_subs set last_ok = now() where endpoint in (
        select x->>'endpoint' from jsonb_array_elements(j->'results') x where (x->>'status') ~ '^2');
    end if;
    delete from public.push_log where req_id = r.req_id;
  end loop;
  delete from public.push_log where created_at < now() - interval '1 hour';

  -- c) Fällige Mitteilungen verschicken (zu alte nicht mehr)
  with due as (
    update public.push_jobs set sent_at = now()
    where id in (select id from public.push_jobs where sent_at is null and send_at <= now()
                 order by send_at limit 200 for update skip locked)
    returning user_id, key, title, body, send_at
  )
  select jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth,
                                      'title', d.title, 'body', d.body, 'tag', d.key))
    into msgs
  from due d join public.push_subs s on s.user_id = d.user_id
  where d.send_at > now() - interval '12 hours';

  if msgs is not null then
    insert into public.push_log (req_id)
    values (net.http_post(url := cfg.fn_url,
                          body := jsonb_build_object('action', 'send', 'jwk', cfg.jwk, 'messages', msgs),
                          timeout_milliseconds := 20000));
  end if;

  -- d) Aufräumen
  delete from public.push_jobs where sent_at < now() - interval '60 days';
end $$;

-- 6) Wer darf was
revoke all on function public.push_public_key(), public.push_subscribe(text, text, text), public.push_unsubscribe(text),
  public.push_set_jobs(jsonb), public.push_test(text, text), public.push_status(text), public.push_tick(), public.push_json(text)
  from public, anon, authenticated;
grant execute on function public.push_public_key() to anon, authenticated;
grant execute on function public.push_subscribe(text, text, text), public.push_unsubscribe(text), public.push_set_jobs(jsonb),
  public.push_test(text, text), public.push_status(text) to authenticated;

-- 7) Zeitplan: jede Minute
select cron.unschedule(jobid) from cron.job where jobname = 'finanzo-push';
select cron.schedule('finanzo-push', '* * * * *', 'select public.push_tick()');

-- 8) Gleich jetzt den Schlüssel anfordern
select public.push_tick();
