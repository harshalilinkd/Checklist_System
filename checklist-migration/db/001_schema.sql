-- Checklist Sys schema
-- Run in Supabase SQL editor (or via psql against DATABASE_URL)
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. doers
-- ---------------------------------------------------------------------------
create table if not exists doers (
  id          serial primary key,
  name        text not null,
  department  text,
  email       text unique not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. tasks
-- ---------------------------------------------------------------------------
create table if not exists tasks (
  task_id      text primary key,
  task_name    text not null,
  doer_email   text not null references doers(email),
  frequency    text not null check (frequency in
                ('D','W','F','M','Q','Y','SM','E1ST','E2ND','E3RD','E4TH','ELAST')),
  start_date   date not null,
  end_date     date,
  assigned_by  text,
  status       text not null default 'Active' check (status in ('Active','Inactive')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. master_checklist
-- `freq` is denormalized from tasks.frequency for fast status computation
-- on read without a join (see PROMPT 3).
-- ---------------------------------------------------------------------------
create table if not exists master_checklist (
  id              bigserial primary key,
  occurrence_key  text unique not null,
  task_id         text not null references tasks(task_id) on delete cascade,
  doer_email      text not null references doers(email),
  planned_date    date not null,
  actual_date     date,
  freq            text,
  status          text not null default 'Scheduled' check (status in
                    ('Scheduled','Today','Delayed','Upcoming Focus','Done')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. archive (same shape as master_checklist + archived_at)
-- ---------------------------------------------------------------------------
create table if not exists archive (
  id              bigserial primary key,
  occurrence_key  text not null,
  task_id         text not null,
  doer_email      text not null,
  planned_date    date not null,
  actual_date     date,
  freq            text,
  status          text not null,
  task_name       text,  -- denormalized so the name survives task deletion
  created_at      timestamptz not null,
  updated_at      timestamptz not null,
  archived_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes (critical for window-query performance)
-- ---------------------------------------------------------------------------
create index if not exists idx_master_planned        on master_checklist(planned_date);
create index if not exists idx_master_doer_planned   on master_checklist(doer_email, planned_date);
create index if not exists idx_master_status         on master_checklist(status) where status != 'Done';
create index if not exists idx_master_occurrence     on master_checklist(occurrence_key);
create index if not exists idx_tasks_doer            on tasks(doer_email);
create index if not exists idx_archive_planned       on archive(planned_date);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_tasks_updated_at on tasks;
create trigger trg_tasks_updated_at
  before update on tasks
  for each row execute function set_updated_at();

drop trigger if exists trg_master_updated_at on master_checklist;
create trigger trg_master_updated_at
  before update on master_checklist
  for each row execute function set_updated_at();
