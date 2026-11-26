-- Keep the live constraint identical to migration 10 (https only; http only for localhost development).
alter table public.app_releases drop constraint app_releases_download_url_check;
alter table public.app_releases add constraint app_releases_download_url_check
  check (download_url ~ '^https://' or download_url ~ '^http://(127\.0\.0\.1|localhost)[:/]');
