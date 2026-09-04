-- Preview / staging only. Do not run against production until explicitly approved.
-- Adds per-cell marks, audit, photo URL index, and a lean snapshot RPC so
-- Supabase egress never includes embedded student photos on routine reads.

create table if not exists public.erp_marks (
  school_id text not null default 'mmm-jhs',
  admission_no text not null,
  subject_code text not null,
  assessment_key text not null,
  session_name text not null default '',
  class_name text,
  section text,
  term text,
  value text,
  max_marks numeric,
  revision integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by text,
  updated_by_user_id text,
  device_id text,
  primary key (school_id, admission_no, subject_code, assessment_key, session_name)
);

create index if not exists erp_marks_class_subject_idx
  on public.erp_marks (school_id, class_name, subject_code, session_name);

alter table public.erp_marks enable row level security;

create table if not exists public.erp_marks_audit (
  id bigserial primary key,
  school_id text not null default 'mmm-jhs',
  admission_no text not null,
  subject_code text not null,
  assessment_key text not null,
  session_name text,
  old_value text,
  new_value text,
  actor_user_id text,
  actor_username text,
  actor_name text,
  device_id text,
  created_at timestamptz not null default now()
);

create index if not exists erp_marks_audit_lookup_idx
  on public.erp_marks_audit (school_id, admission_no, subject_code, created_at desc);

alter table public.erp_marks_audit enable row level security;

create table if not exists public.erp_photos (
  school_id text not null default 'mmm-jhs',
  admission_no text not null,
  photo_url text,
  updated_at timestamptz not null default now(),
  primary key (school_id, admission_no)
);

alter table public.erp_photos enable row level security;

-- Lean snapshot: students without photo/photoDataUrl, plus directory fields only.
create or replace function public.erp_lean_boot(p_school_id text)
returns jsonb
language plpgsql
stable
as $$
declare
  src jsonb;
  students jsonb;
begin
  select payload into src
  from public.erp_snapshots
  where school_id = p_school_id
  limit 1;

  if src is null then
    return jsonb_build_object('ok', false, 'error', 'No snapshot');
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'admissionNo', coalesce(s->>'admissionNo', s->>'AdmissionNo'),
      'name', coalesce(s->>'name', s->>'fullName', ''),
      'currentClass', coalesce(s->>'currentClass', s->>'class', ''),
      'currentSection', coalesce(s->>'currentSection', s->>'section', ''),
      'rollNo', s->>'rollNo',
      'gender', s->>'gender',
      'status', s->>'status',
      'parentName', s->>'parentName',
      'parentPhone', coalesce(s->>'parentPhone', s->>'phone'),
      'nfcUid', coalesce(s->>'nfcUid', s->>'cardUid'),
      'telegramChatId', coalesce(s->>'telegramChatId', s->>'schoolBotChatId'),
      'hasPhoto', (
        coalesce(length(s->>'photo'), 0) > 32
        or coalesce(length(s->>'photoDataUrl'), 0) > 32
        or coalesce(length(s->>'photoUrl'), 0) > 8
      ),
      'photoUrl', case
        when coalesce(s->>'photoUrl', '') ~ '^https?://' then s->>'photoUrl'
        when coalesce(s->>'photo', '') ~ '^(https?://|assets/students/)' then s->>'photo'
        else ''
      end
    )
    order by coalesce(s->>'admissionNo', s->>'AdmissionNo')
  ), '[]'::jsonb)
  into students
  from jsonb_array_elements(coalesce(src->'students', '[]'::jsonb)) as s;

  return jsonb_build_object(
    'ok', true,
    'lean', true,
    'photosOmitted', true,
    'version', coalesce(src->>'version', '2.1'),
    'savedAt', coalesce(src->>'savedAt', ''),
    'activeSession', coalesce(src->>'activeSession', ''),
    'classes', coalesce(src->'classes', '[]'::jsonb),
    'subjects', coalesce(src->'subjects', '{}'::jsonb),
    'staffUsers', coalesce(src->'staffUsers', '[]'::jsonb),
    'teachers', coalesce(src->'teachers', '[]'::jsonb),
    'schoolProfile', coalesce(src->'schoolProfile', '{}'::jsonb),
    'examSubjectConfigs', coalesce(src->'examSubjectConfigs', '{}'::jsonb),
    'periodSettings', coalesce(src->'periodSettings', '{}'::jsonb),
    'sessions', coalesce(src->'sessions', '{}'::jsonb),
    'students', students,
    'studentCount', jsonb_array_length(coalesce(src->'students', '[]'::jsonb))
  );
end;
$$;

notify pgrst, 'reload schema';
