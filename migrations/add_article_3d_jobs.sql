-- Run in the Supabase SQL editor before using article photo to 3D.
-- One row per upload. The photo and the GLB live in the private
-- storage bucket `article-3d`. Cloud Run can answer the next poll
-- from a different instance, so the job cannot live in process memory.

create table if not exists article_3d_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  status text not null default 'processing'
    check (status in ('processing', 'saving', 'ready', 'failed')),
  source_path text,
  model_path text,
  prediction_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists article_3d_jobs_user_id_idx
  on article_3d_jobs (user_id);

insert into storage.buckets (id, name, public)
values ('article-3d', 'article-3d', false)
on conflict (id) do nothing;
