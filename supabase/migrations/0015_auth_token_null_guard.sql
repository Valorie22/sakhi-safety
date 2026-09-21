-- 0015_auth_token_null_guard.sql
--
-- GoTrue reads auth.users.confirmation_token and friends into Go `string`,
-- which cannot hold NULL. A row seeded with raw `insert into auth.users` gets
-- NULL for those columns and becomes unreadable: that user's sign-in fails with
-- a 500 "Database error querying schema", while every account created through
-- the Auth API works fine. That asymmetry makes it a nasty one to spot - the
-- whole test suite passed while every seeded demo account was unable to log in.
--
-- Seed accounts through the Auth admin API, not raw SQL. This repairs existing
-- rows and exposes a checker the test suite asserts on, so a future re-seed
-- cannot reintroduce it quietly.

update auth.users
   set confirmation_token         = coalesce(confirmation_token, ''),
       recovery_token             = coalesce(recovery_token, ''),
       email_change_token_new     = coalesce(email_change_token_new, ''),
       email_change_token_current = coalesce(email_change_token_current, ''),
       email_change               = coalesce(email_change, ''),
       phone_change               = coalesce(phone_change, ''),
       phone_change_token         = coalesce(phone_change_token, ''),
       reauthentication_token     = coalesce(reauthentication_token, '')
 where confirmation_token is null
    or recovery_token is null
    or email_change_token_new is null
    or email_change_token_current is null
    or email_change is null
    or phone_change is null
    or phone_change_token is null
    or reauthentication_token is null;

create or replace function public.count_users_with_null_auth_tokens()
returns integer
language sql stable security definer set search_path = public, extensions, auth
as $$
  select count(*)::integer
    from auth.users
   where confirmation_token is null
      or recovery_token is null
      or email_change_token_new is null
      or email_change_token_current is null
      or email_change is null
      or phone_change is null
      or phone_change_token is null
      or reauthentication_token is null;
$$;

comment on function public.count_users_with_null_auth_tokens() is
  'Returns how many auth.users rows have NULL in a column GoTrue reads as a non-nullable string. Must be 0; anything else means some accounts cannot sign in.';

revoke all on function public.count_users_with_null_auth_tokens() from public, anon, authenticated;
