-- Finanzo: Datenbank für Konten (einmal im SQL Editor von Supabase ausführen)

-- 1) Tabelle: pro Konto eine Zeile mit allen Finanzo-Daten
create table if not exists public.finanzo_data (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 2) Schutz: jeder darf nur seine eigenen Daten sehen und ändern
alter table public.finanzo_data enable row level security;

drop policy if exists "eigene Daten lesen"   on public.finanzo_data;
drop policy if exists "eigene Daten anlegen" on public.finanzo_data;
drop policy if exists "eigene Daten ändern"  on public.finanzo_data;
drop policy if exists "eigene Daten löschen" on public.finanzo_data;

create policy "eigene Daten lesen"   on public.finanzo_data for select to authenticated using ((select auth.uid()) = user_id);
create policy "eigene Daten anlegen" on public.finanzo_data for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "eigene Daten ändern"  on public.finanzo_data for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "eigene Daten löschen" on public.finanzo_data for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.finanzo_data from anon;
grant select, insert, update, delete on public.finanzo_data to authenticated;

-- 3) „Konto löschen“ in der App: löscht das eigene Konto samt Daten
create or replace function public.delete_my_account()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from auth.users where id = auth.uid();
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
