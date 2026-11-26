-- App release management
insert into tests.ctx values
  ('admin', tests.create_user('a@r.in', 'customer', 'Admin')),
  ('user', tests.create_user('u@r.in', 'customer', 'User'));
update public.profiles set role = 'admin' where id = (select v from tests.ctx where k = 'admin');

select tests.login((select v from tests.ctx where k = 'user')); set role authenticated;
select tests.throws($$insert into public.app_releases (version_code, version_name, download_url) values (9, '9.0', 'https://x/y.apk')$$,
  'row-level security', 'normal users cannot publish releases');
reset role;

select tests.login((select v from tests.ctx where k = 'admin')); set role authenticated;
insert into public.app_releases (version_code, version_name, download_url, notes) values (3, '1.0.2', 'https://x/1.apk', 'first');
insert into public.app_releases (version_code, version_name, download_url, mandatory) values (4, '1.0.3', 'https://x/2.apk', true);
insert into public.app_releases (version_code, version_name, download_url, published) values (5, '1.0.4', 'https://x/3.apk', false);
select tests.throws($$insert into public.app_releases (version_code, version_name, download_url) values (4, '1.0.9', 'https://x/z.apk')$$,
  'duplicate key', 'version codes are unique');
select tests.throws($$insert into public.app_releases (version_code, version_name, download_url) values (6, '1.0.6', 'http://insecure/a.apk')$$,
  'check constraint', 'downloads must use https');
reset role;

select tests.logout(); set role anon;
select tests.eq((public.latest_app_release()).version_name, '1.0.3', 'latest published release (drafts hidden), readable signed out');
select tests.eq(public.app_update_required('android', 3), true, 'version 3 must update to mandatory 4');
select tests.eq(public.app_update_required('android', 4), false, 'version 4 is up to date');
select tests.eq((select count(*)::int from public.app_releases), 2, 'anonymous users see only published releases');
reset role;
