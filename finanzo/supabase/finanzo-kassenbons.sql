-- Finanzo: Kassenbon-Fotos im Konto speichern (einmal im SQL Editor von Supabase ausführen)
-- Man kann diese Datei gefahrlos mehrmals ausführen.

-- 1) Ablage „receipts“: privat, nur JPEG-Fotos bis 3 MB
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 3145728, array['image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- 2) Schutz: jeder sieht und ändert nur Fotos in seinem eigenen Ordner (Ordnername = Konto-ID)
drop policy if exists "Kassenbons lesen"     on storage.objects;
drop policy if exists "Kassenbons hochladen" on storage.objects;
drop policy if exists "Kassenbons ersetzen"  on storage.objects;
drop policy if exists "Kassenbons löschen"   on storage.objects;

create policy "Kassenbons lesen" on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Kassenbons hochladen" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Kassenbons ersetzen" on storage.objects for update to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Kassenbons löschen" on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);
