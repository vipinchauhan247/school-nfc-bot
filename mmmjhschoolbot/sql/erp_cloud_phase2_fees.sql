-- Phase 2: native fee / receipt rows (run once in Supabase SQL editor)
-- Safe: does not drop erp_snapshots or erp_students.
-- Does NOT affect @Vipinbellbot / NFC.

create table if not exists public.erp_payments (
  school_id text not null default 'mmm-jhs',
  admission_no text not null,
  receipt_no text not null,
  session_name text,
  amount numeric,
  paid_on text,
  month text,
  mode text,
  cancelled boolean not null default false,
  payload jsonb default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (school_id, receipt_no)
);

create index if not exists erp_payments_student_idx
  on public.erp_payments (school_id, admission_no);

create table if not exists public.erp_fee_sessions (
  school_id text not null default 'mmm-jhs',
  admission_no text not null,
  session_name text not null,
  monthly_tuition numeric,
  due_months jsonb default '[]'::jsonb,
  paid_months jsonb default '[]'::jsonb,
  wallet_balance numeric,
  payload jsonb default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (school_id, admission_no, session_name)
);

alter table public.erp_payments enable row level security;
alter table public.erp_fee_sessions enable row level security;
