-- Xe Wedding Studio schema. Run once in Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.studio_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  role text not null check (role in ('owner','client_admin')),
  display_name text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.galleries (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  gallery_code text not null unique,
  website_name text not null default 'Wedding Gallery',
  title text not null,
  couple_names text,
  description text,
  event_date date,
  access_mode text not null default 'private' check (access_mode in ('public','private')),
  visitor_password_hash text,
  is_published boolean not null default false,
  cover_key text,
  cover_url text,
  theme text not null default 'black-ivory',
  settings jsonb not null default '{}'::jsonb,
  created_by uuid references public.studio_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.gallery_admins (
  gallery_id uuid not null references public.galleries(id) on delete cascade,
  user_id uuid not null references public.studio_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (gallery_id,user_id)
);

create table if not exists public.albums (
  id uuid primary key default gen_random_uuid(),
  gallery_id uuid not null references public.galleries(id) on delete cascade,
  title text not null,
  description text,
  sort_order integer not null default 0,
  is_published boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  gallery_id uuid not null references public.galleries(id) on delete cascade,
  album_id uuid references public.albums(id) on delete set null,
  object_key text not null unique,
  public_url text not null,
  original_name text,
  mime_type text,
  byte_size bigint,
  width integer,
  height integer,
  sort_order integer not null default 0,
  vision_status text not null default 'pending',
  vision_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists galleries_created_by_idx on public.galleries(created_by);
create index if not exists gallery_admins_user_idx on public.gallery_admins(user_id);
create index if not exists albums_gallery_idx on public.albums(gallery_id,sort_order);
create index if not exists photos_gallery_idx on public.photos(gallery_id,album_id,sort_order);

-- The Node API connects with the Supabase database connection string.
-- Browser clients must not read or mutate these tables directly.
revoke all on public.studio_users, public.galleries, public.gallery_admins,
  public.albums, public.photos from anon, authenticated;
