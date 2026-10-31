-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.

create table if not exists public.attempts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  test_id       text not null,                       -- 'reading-320' | 'listening-1'
  status        text not null default 'in_progress'  check (status in ('in_progress','submitted')),
  payload       jsonb,                               -- resumable session (answers, timer, notes...)
  answered      int  not null default 0,
  score         int,
  total         int,
  band          text,
  part_scores   jsonb,
  answers       jsonb,                               -- final answers, set on submit
  started_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  submitted_at  timestamptz
);

-- At most one unfinished attempt per user per test (this is what "resume" uses).
create unique index if not exists attempts_one_active
  on public.attempts (user_id, test_id) where status = 'in_progress';

create index if not exists attempts_user_updated
  on public.attempts (user_id, updated_at desc);

-- Keep updated_at fresh.
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists attempts_touch on public.attempts;
create trigger attempts_touch before update on public.attempts
  for each row execute function public.touch_updated_at();

-- Row Level Security: every user can only see and change their own rows.
alter table public.attempts enable row level security;

drop policy if exists "own attempts select" on public.attempts;
drop policy if exists "own attempts insert" on public.attempts;
drop policy if exists "own attempts update" on public.attempts;
drop policy if exists "own attempts delete" on public.attempts;

create policy "own attempts select" on public.attempts for select to authenticated using (user_id = auth.uid());
create policy "own attempts insert" on public.attempts for insert to authenticated with check (user_id = auth.uid());
create policy "own attempts update" on public.attempts for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own attempts delete" on public.attempts for delete to authenticated using (user_id = auth.uid());
