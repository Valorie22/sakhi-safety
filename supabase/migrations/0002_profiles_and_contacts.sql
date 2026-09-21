-- 0002_profiles_and_contacts.sql
-- Identity (profiles), per-user safety settings, and the family trust graph.

-- ---------------------------------------------------------------------------
-- profiles: extends auth.users
-- ---------------------------------------------------------------------------

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text        not null default '',
  email       extensions.citext,
  phone       text,
  role        public.user_role not null default 'user',
  push_token  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);


create unique index profiles_email_key on public.profiles (email);
create index profiles_role_idx on public.profiles (role);

-- ---------------------------------------------------------------------------
-- New auth user -> profile row. Always role 'user'. Police/admin roles are
-- only ever set by the service role through the admin routes, never here.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into public.profiles (id, full_name, email, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    new.email,
    new.raw_user_meta_data ->> 'phone'
  )
  on conflict (id) do nothing;

  insert into public.user_settings (user_id) values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- user_settings: the "Safety Settings" screen (spec 6.1 / 6.4 / 6.5)
-- ---------------------------------------------------------------------------

create table public.user_settings (
  user_id                uuid primary key references public.profiles (id) on delete cascade,
  sos_button_enabled     boolean not null default true,
  shake_enabled          boolean not null default true,
  shake_threshold        numeric not null default 2.7  check (shake_threshold between 1.2 and 6.0),
  shake_count_required   integer not null default 3    check (shake_count_required between 2 and 10),
  shake_window_ms        integer not null default 2000 check (shake_window_ms between 500 and 10000),
  shake_cooldown_ms      integer not null default 15000 check (shake_cooldown_ms between 0 and 300000),
  timer_enabled          boolean not null default true,
  timer_default_seconds  integer not null default 30   check (timer_default_seconds between 5 and 3600),
  default_level          integer not null default 1    check (default_level between 1 and 3),
  audio_opt_in           boolean not null default true,
  updated_at             timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- emergency_contacts: the (requested -> accepted) trust edge
-- ---------------------------------------------------------------------------

create table public.emergency_contacts (
  id            uuid primary key default extensions.gen_random_uuid(),
  owner_id      uuid not null references public.profiles (id) on delete cascade,
  contact_id    uuid not null references public.profiles (id) on delete cascade,
  status        public.contact_status not null default 'pending',
  relationship  text,
  requested_at  timestamptz not null default now(),
  responded_at  timestamptz,
  constraint emergency_contacts_no_self check (owner_id <> contact_id),
  constraint emergency_contacts_unique_pair unique (owner_id, contact_id)
);

create index emergency_contacts_owner_idx   on public.emergency_contacts (owner_id, status);
create index emergency_contacts_contact_idx on public.emergency_contacts (contact_id, status);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch      before update on public.profiles      for each row execute function public.touch_updated_at();
create trigger user_settings_touch before update on public.user_settings for each row execute function public.touch_updated_at();

-- The auth.users -> profiles trigger. Created last so the function's
-- dependencies (profiles, user_settings) already exist.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
