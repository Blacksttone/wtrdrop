-- =====================================================================
-- Waterdrop — Android app releases (in-app update prompts).
-- The platform owner uploads a new APK in the admin console; installed
-- apps compare their versionCode with the latest release and prompt the
-- user to update. Mandatory releases block older versions.
-- =====================================================================
create table public.app_releases (
  id uuid primary key default gen_random_uuid(),
  platform text not null default 'android' check (platform in ('android')),
  version_code integer not null check (version_code > 0),
  version_name text not null check (version_name ~ '^[0-9]+(\.[0-9]+){0,3}$'),
  -- https only (an APK over plain http could be tampered with); http allowed for local development
  download_url text not null check (download_url ~ '^https://' or download_url ~ '^http://(127\.0\.0\.1|localhost)[:/]'),
  file_path text,
  file_size bigint,
  notes text check (notes is null or char_length(notes) <= 1000),
  mandatory boolean not null default false,
  published boolean not null default true,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint app_releases_version_uq unique (platform, version_code)
);
create index app_releases_latest_idx on public.app_releases (platform, version_code desc) where published;

alter table public.app_releases enable row level security;
-- Release info is public (the website "Download app" button works signed out).
create policy app_releases_read_public on public.app_releases for select to anon using (published);
create policy app_releases_read on public.app_releases for select to authenticated using (published or public.is_admin());
create policy app_releases_admin_write on public.app_releases for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select on public.app_releases to anon, authenticated;
grant insert, update, delete on public.app_releases to authenticated;  -- admin-only via RLS

create or replace function public.latest_app_release(p_platform text default 'android')
returns public.app_releases
language sql stable security definer set search_path = public as $$
  select * from public.app_releases
  where platform = p_platform and published
  order by version_code desc limit 1;
$$;

-- Is an update required for this installed version? (any newer mandatory release)
create or replace function public.app_update_required(p_platform text, p_installed_version_code integer)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_releases
                 where platform = p_platform and published and mandatory and version_code > p_installed_version_code);
$$;
grant execute on function public.latest_app_release(text), public.app_update_required(text, integer) to anon, authenticated, service_role;

-- Storage: public downloads, admin-only uploads.
do $$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    raise notice 'storage schema not present; skipping app-releases bucket';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('app-releases', 'app-releases', true, 104857600,
          array['application/vnd.android.package-archive', 'application/octet-stream'])
  on conflict (id) do nothing;
  execute $p$ create policy "app releases are publicly downloadable" on storage.objects for select
    using (bucket_id = 'app-releases') $p$;
  execute $p$ create policy "admins upload app releases" on storage.objects for insert to authenticated
    with check (bucket_id = 'app-releases' and public.is_admin()) $p$;
  execute $p$ create policy "admins update app releases" on storage.objects for update to authenticated
    using (bucket_id = 'app-releases' and public.is_admin()) $p$;
  execute $p$ create policy "admins delete app releases" on storage.objects for delete to authenticated
    using (bucket_id = 'app-releases' and public.is_admin()) $p$;
end $$;
