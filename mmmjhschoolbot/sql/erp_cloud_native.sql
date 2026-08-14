-- Cloud-native ERP core (run once in Supabase SQL editor)
-- Safe: keeps snapshot table for compatibility + adds native student rows.
-- Does NOT affect @Vipinbellbot / NFC.

create table if not exists public.erp_snapshots (
  school_id text primary key,
  payload jsonb not null,
  saved_at timestamptz not null default now(),
  saved_by text,
  version text
);

create table if not exists public.erp_students (
  school_id text not null default 'mmm-jhs',
  admission_no text not null,
  name text,
  current_class text,
  current_section text,
  parent_name text,
  parent_phone text,
  nfc_uid text,
  school_bot_chat_id text,
  telegram_user_name text,
  status text,
  payload jsonb default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (school_id, admission_no)
);

create index if not exists erp_students_chat_idx
  on public.erp_students (school_id, school_bot_chat_id);

alter table public.erp_snapshots enable row level security;
alter table public.erp_students enable row level security;

-- Service role from Render bypasses RLS; anon has no policies by default (secure).
