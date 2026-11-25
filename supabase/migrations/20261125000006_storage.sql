-- =====================================================================
-- Waterdrop — storage bucket for supplier logos.
-- Path convention: logos/<auth.uid()>/<filename>. Public read (logos
-- appear on invoices), owner-only write.
-- =====================================================================
do $$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    raise notice 'storage schema not present; skipping bucket setup';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('logos', 'logos', true, 1048576, array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])
  on conflict (id) do nothing;

  execute $p$
    create policy "logos are publicly readable" on storage.objects for select
    using (bucket_id = 'logos')
  $p$;
  execute $p$
    create policy "users upload their own logo" on storage.objects for insert to authenticated
    with check (bucket_id = 'logos' and (storage.foldername(name))[1] = auth.uid()::text)
  $p$;
  execute $p$
    create policy "users update their own logo" on storage.objects for update to authenticated
    using (bucket_id = 'logos' and (storage.foldername(name))[1] = auth.uid()::text)
  $p$;
  execute $p$
    create policy "users delete their own logo" on storage.objects for delete to authenticated
    using (bucket_id = 'logos' and (storage.foldername(name))[1] = auth.uid()::text)
  $p$;
end $$;
