-- XE Vision AI v2 migration. Run after the main studio schema.
create extension if not exists pgcrypto;
create table if not exists public.vision_jobs (
 id uuid primary key default gen_random_uuid(), gallery_id uuid not null references public.galleries(id) on delete cascade,
 status text not null default 'queued' check(status in ('queued','processing','completed','failed','cancelled')),
 face_grouping boolean not null default false, consent_confirmed boolean not null default false,
 total_photos integer not null default 0, processed_photos integer not null default 0, retry_count integer not null default 0,
 request_data jsonb not null default '{}'::jsonb, summary jsonb not null default '{}'::jsonb,
 error text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 started_at timestamptz, completed_at timestamptz
);
create index if not exists vision_jobs_queue_idx on public.vision_jobs(status,created_at) where status='queued';
create index if not exists vision_jobs_gallery_idx on public.vision_jobs(gallery_id,created_at desc);
create table if not exists public.vision_photo_results (
 id uuid primary key default gen_random_uuid(), job_id uuid not null references public.vision_jobs(id) on delete cascade,
 gallery_id uuid not null references public.galleries(id) on delete cascade,
 photo_id uuid not null references public.photos(id) on delete cascade,
 metrics jsonb not null default '{}'::jsonb, quality_rank integer, review_flags text[] not null default '{}',
 created_at timestamptz not null default now(), unique(job_id,photo_id)
);
create index if not exists vision_photo_results_gallery_idx on public.vision_photo_results(gallery_id,job_id,quality_rank);
create table if not exists public.vision_duplicate_pairs (
 id uuid primary key default gen_random_uuid(), job_id uuid not null references public.vision_jobs(id) on delete cascade,
 gallery_id uuid not null references public.galleries(id) on delete cascade,
 photo_a uuid not null references public.photos(id) on delete cascade,
 photo_b uuid not null references public.photos(id) on delete cascade,
 kind text not null check(kind in ('exact','near')), distance integer not null default 0,
 created_at timestamptz not null default now(), unique(job_id,photo_a,photo_b,kind)
);
create table if not exists public.vision_face_groups (
 id uuid primary key default gen_random_uuid(), job_id uuid not null references public.vision_jobs(id) on delete cascade,
 gallery_id uuid not null references public.galleries(id) on delete cascade,
 label text not null, face_count integer not null default 0, review_status text not null default 'needs_review',
 created_at timestamptz not null default now()
);
create table if not exists public.vision_face_members (
 id uuid primary key default gen_random_uuid(), group_id uuid not null references public.vision_face_groups(id) on delete cascade,
 photo_id uuid not null references public.photos(id) on delete cascade, face_index integer not null,
 bounding_box integer[] not null, detector_score real,
 created_at timestamptz not null default now(), unique(group_id,photo_id,face_index)
);
-- The API and worker use the server-side database role. No browser role access.
revoke all on public.vision_jobs,public.vision_photo_results,public.vision_duplicate_pairs,public.vision_face_groups,public.vision_face_members from anon,authenticated;
