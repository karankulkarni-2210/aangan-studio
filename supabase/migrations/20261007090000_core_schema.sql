-- Aangan Studio phone-enquiry MVP: core schema.
-- Conventions: UUID keys, timestamptz (UTC), INR amounts as integer paise, supplier
-- amounts as integer micros of the supplier currency. Unknown facts are NULL, never 0.

create sequence if not exists public.lead_reference_seq start 1001;

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.reject_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'table % is append-only', tg_table_name using errcode = '42501';
end;
$$;

-- Staff roster: founder/admin, front desk, designers. Roles are read from this table,
-- never from client-supplied JWT claims.
create table public.staff (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  role text not null check (role in ('admin', 'front_desk', 'designer')),
  display_name text not null,
  email text not null check (email = lower(email)),
  active boolean not null default true,
  approved_for_handoff boolean not null default false,
  services text[] not null default '{}',
  is_demo boolean not null default false,
  last_assigned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index staff_email_key on public.staff (email);
create trigger staff_touch before update on public.staff for each row execute function public.touch_updated_at();

-- Versioned business policy (services, qualification rules, scripts, operations settings).
create table public.business_policies (
  id uuid primary key default gen_random_uuid(),
  version integer not null unique check (version > 0),
  status text not null check (status in ('draft', 'active', 'retired')),
  label text not null,
  is_demo boolean not null,
  config jsonb not null,
  validation jsonb not null default '{}'::jsonb,
  created_by uuid references public.staff (id),
  created_at timestamptz not null default now(),
  published_by uuid references public.staff (id),
  published_at timestamptz,
  retired_at timestamptz
);
create unique index business_policies_single_active on public.business_policies ((true)) where status = 'active';

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default ('AGN-' || nextval('public.lead_reference_seq')::text),
  channel text not null default 'phone' check (channel in ('phone')),
  is_simulated boolean not null default false,
  caller_phone text,
  contact_name text,
  contact_email text,
  callback_preference text,
  intent text check (intent in ('new_project', 'existing_client', 'vendor_or_job', 'general_question', 'unknown')),
  service_type text,
  service_description text,
  location_city text,
  location_locality text,
  area_sqft numeric(12, 2) check (area_sqft is null or area_sqft >= 0),
  area_basis text check (area_basis in ('carpet', 'built_up', 'super_built_up', 'unspecified')),
  budget_paise bigint check (budget_paise is null or budget_paise >= 0),
  timeline_months numeric(6, 2) check (timeline_months is null or timeline_months >= 0),
  fact_status jsonb not null default '{}'::jsonb,
  missing_fields text[] not null default '{}',
  discovery_status text not null default 'not_started'
    check (discovery_status in ('not_started', 'in_progress', 'complete', 'incomplete')),
  qualification_status text not null default 'pending'
    check (qualification_status in ('pending', 'qualified', 'not_fit', 'needs_review')),
  qualification_reasons jsonb not null default '[]'::jsonb,
  current_assessment_id uuid,
  policy_id uuid references public.business_policies (id),
  owner_staff_id uuid references public.staff (id),
  handoff_status text not null default 'none'
    check (handoff_status in ('none', 'pending', 'sent', 'failed', 'acknowledged')),
  ack_overdue boolean not null default false,
  booking_status text not null default 'none'
    check (booking_status in ('none', 'confirmed', 'pending_reconciliation', 'declined', 'failed')),
  crm_status text not null default 'not_required'
    check (crm_status in ('not_required', 'pending', 'synced', 'failed')),
  outcome_status text not null default 'unknown'
    check (outcome_status in ('unknown', 'contacted', 'consultation_booked', 'won', 'lost')),
  open_escalations text[] not null default '{}',
  injection_suspected boolean not null default false,
  handoff_requested_at timestamptz,
  notes text,
  version integer not null default 1,
  intake_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index leads_intake_idx on public.leads (intake_at desc);
create index leads_owner_idx on public.leads (owner_staff_id);
create index leads_phone_idx on public.leads (caller_phone);
create index leads_qualification_idx on public.leads (qualification_status);
create trigger leads_touch before update on public.leads for each row execute function public.touch_updated_at();

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_call_id text not null,
  lead_id uuid references public.leads (id) on delete set null,
  is_simulated boolean not null default false,
  simulation_scenario text,
  direction text not null default 'inbound' check (direction = 'inbound'),
  from_number text,
  to_number text,
  status text not null check (status in ('ringing', 'in_progress', 'completed', 'no_answer', 'busy', 'failed', 'canceled')),
  status_rank smallint not null,
  arrived_at timestamptz,
  answered_at timestamptz,
  first_response_at timestamptz,
  ended_at timestamptz,
  end_reason text,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  language text,
  disclosure_given boolean not null default false,
  recording_consent text not null default 'not_asked'
    check (recording_consent in ('granted', 'declined', 'not_asked', 'not_applicable')),
  recording_ref text,
  transcript_purged_at timestamptz,
  after_hours boolean,
  sla_exclusion_reason text check (sla_exclusion_reason in ('spam', 'test', 'internal')),
  policy_id uuid references public.business_policies (id),
  last_prompted_field text,
  last_prompt_kind text check (last_prompt_kind in ('question', 'confirm')),
  capture_turns integer not null default 0,
  prompt_repeats integer not null default 0,
  skipped_fields text[] not null default '{}',
  finalized_at timestamptz,
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_call_id)
);
create index calls_lead_idx on public.calls (lead_id);
create index calls_arrived_idx on public.calls (arrived_at);
create trigger calls_touch before update on public.calls for each row execute function public.touch_updated_at();

create table public.utterances (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls (id) on delete cascade,
  seq integer not null check (seq >= 0),
  speaker text not null check (speaker in ('caller', 'agent', 'system')),
  text text not null,
  spoken_at timestamptz,
  provider_utterance_id text,
  price_guard_flag boolean not null default false,
  created_at timestamptz not null default now(),
  unique (call_id, seq)
);

create table public.field_evidence (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  call_id uuid references public.calls (id) on delete set null,
  utterance_id uuid references public.utterances (id) on delete set null,
  field text not null check (field in ('service', 'location', 'area', 'budget', 'timeline', 'contact_name', 'contact_email', 'callback_preference')),
  value jsonb not null,
  quote text,
  source text not null check (source in ('ai_extraction', 'caller_confirmation', 'human_edit')),
  confidence numeric(4, 3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  ambiguity text[] not null default '{}',
  confirmation_status text not null default 'stated'
    check (confirmation_status in ('stated', 'needs_confirmation', 'confirmed', 'rejected', 'superseded')),
  extractor text,
  created_by uuid references public.staff (id),
  created_at timestamptz not null default now()
);
create index field_evidence_lead_idx on public.field_evidence (lead_id, field);

create table public.qualification_assessments (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  call_id uuid references public.calls (id) on delete set null,
  policy_id uuid references public.business_policies (id),
  policy_version integer,
  kind text not null check (kind in ('automatic', 'reassessment', 'human_override')),
  decision text not null check (decision in ('qualified', 'not_fit', 'needs_review')),
  reasons jsonb not null,
  missing_fields text[] not null default '{}',
  contradictory_fields text[] not null default '{}',
  facts_snapshot jsonb not null,
  proposed_route text,
  override_reason text,
  created_by uuid references public.staff (id),
  created_at timestamptz not null default now()
);
create index qualification_assessments_lead_idx on public.qualification_assessments (lead_id, created_at);
alter table public.leads
  add constraint leads_current_assessment_fk foreign key (current_assessment_id)
  references public.qualification_assessments (id) on delete set null;

create table public.human_tasks (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references public.leads (id) on delete cascade,
  call_id uuid references public.calls (id) on delete set null,
  kind text not null check (kind in (
    'pricing_request', 'complaint', 'commitment_request', 'human_requested', 'urgent', 'needs_review',
    'callback', 'booking_pending', 'integration_failure', 'ack_overdue', 'injection_review',
    'agent_price_utterance', 'other')),
  status text not null default 'open' check (status in ('open', 'resolved', 'cancelled')),
  assigned_role text not null check (assigned_role in ('admin', 'front_desk', 'designer')),
  assigned_staff_id uuid references public.staff (id),
  summary text not null,
  evidence_utterance_id uuid references public.utterances (id) on delete set null,
  dedupe_key text not null unique,
  due_at timestamptz,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.staff (id),
  resolution_note text
);
create index human_tasks_lead_idx on public.human_tasks (lead_id);
create index human_tasks_open_idx on public.human_tasks (status, kind);

create table public.handoffs (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  purpose text not null check (purpose in ('designer_handoff', 'front_desk_review', 'ack_escalation')),
  dedupe_key text not null unique,
  recipient_kind text not null check (recipient_kind in ('designer', 'front_desk_queue')),
  recipient_staff_id uuid references public.staff (id),
  recipient_email text not null,
  delivery_status text not null default 'queued'
    check (delivery_status in ('queued', 'sending', 'sent', 'simulated', 'failed')),
  delivery_mode text check (delivery_mode in ('live', 'mock')),
  provider_message_id text,
  attempts integer not null default 0,
  last_error text,
  subject text,
  body_text text,
  body_html text,
  requested_by text not null check (requested_by in ('system', 'voice_agent', 'staff')),
  sent_at timestamptz,
  ack_required boolean not null default true,
  ack_deadline_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid references public.staff (id),
  ack_overdue_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index handoffs_lead_idx on public.handoffs (lead_id);
create trigger handoffs_touch before update on public.handoffs for each row execute function public.touch_updated_at();

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  call_id uuid references public.calls (id) on delete set null,
  provider text not null default 'calcom',
  mode text not null check (mode in ('live', 'mock')),
  status text not null check (status in ('requested', 'confirmed', 'conflict', 'pending_reconciliation', 'failed', 'declined', 'cancelled')),
  request_key text not null unique,
  event_type_id text,
  slot_start timestamptz,
  slot_end timestamptz,
  timezone text not null default 'Asia/Kolkata',
  caller_confirmed_at timestamptz,
  provider_booking_uid text,
  attendee_name text,
  attendee_email text,
  attendee_phone text,
  decline_reason text,
  last_error text,
  requested_by text not null check (requested_by in ('voice_agent', 'staff')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index bookings_lead_idx on public.bookings (lead_id);
create unique index bookings_provider_uid_key on public.bookings (provider, provider_booking_uid)
  where provider_booking_uid is not null;
create trigger bookings_touch before update on public.bookings for each row execute function public.touch_updated_at();

create table public.integration_syncs (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  provider text not null check (provider in ('hubspot', 'calcom', 'resend', 'gemini', 'vaani')),
  object_kind text not null,
  mode text not null check (mode in ('live', 'mock')),
  status text not null check (status in ('pending', 'succeeded', 'failed', 'ambiguous')),
  remote_id text,
  attempts integer not null default 0,
  last_error text,
  last_attempt_at timestamptz,
  succeeded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lead_id, provider, object_kind)
);
create trigger integration_syncs_touch before update on public.integration_syncs for each row execute function public.touch_updated_at();

create table public.outcome_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  outcome text not null check (outcome in ('contacted', 'consultation_booked', 'won', 'lost')),
  occurred_at timestamptz not null,
  source text not null check (source in ('manual', 'calcom', 'system')),
  contract_value_paise bigint check (contract_value_paise is null or contract_value_paise > 0),
  reason text,
  recorded_by uuid references public.staff (id),
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  constraint outcome_contract_value_only_for_won check (contract_value_paise is null or outcome = 'won')
);
create index outcome_events_lead_idx on public.outcome_events (lead_id, occurred_at);
create trigger outcome_events_append_only before update or delete on public.outcome_events
  for each row execute function public.reject_mutation();

create table public.provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  event_type text not null,
  provider_call_id text,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  payload_redacted jsonb not null,
  processing_status text not null default 'received'
    check (processing_status in ('received', 'processed', 'ignored_stale', 'failed')),
  processed_at timestamptz,
  unique (provider, event_id)
);

create table public.outbox_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  payload jsonb not null,
  dedupe_key text not null unique,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'dead', 'cancelled')),
  attempts integer not null default 0,
  max_attempts integer not null default 5 check (max_attempts > 0),
  run_after timestamptz not null default now(),
  locked_by text,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index outbox_jobs_ready_idx on public.outbox_jobs (run_after) where status in ('queued', 'running');
create trigger outbox_jobs_touch before update on public.outbox_jobs for each row execute function public.touch_updated_at();

create table public.dispatcher_runs (
  id uuid primary key default gen_random_uuid(),
  trigger text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  claimed integer not null default 0,
  succeeded integer not null default 0,
  retried integer not null default 0,
  dead integer not null default 0
);

create table public.rate_cards (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  category text not null,
  meter text not null,
  unit text not null,
  unit_size numeric(14, 2) not null default 1 check (unit_size > 0),
  unit_price_micros bigint not null check (unit_price_micros >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  fx_rate_to_inr numeric(14, 6) not null check (fx_rate_to_inr > 0),
  fx_source text not null,
  billing text not null check (billing in ('per_unit', 'fixed_monthly')),
  bundled_in text,
  includes text[] not null default '{}',
  is_synthetic boolean not null default true,
  operating_cost boolean not null default true,
  effective_from date not null,
  effective_to date,
  notes text,
  created_at timestamptz not null default now(),
  unique (provider, meter, effective_from)
);

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  category text not null check (category in (
    'voice_telephony', 'ai_inference', 'speech', 'notification', 'calendar', 'crm',
    'hosting', 'database_storage', 'source_control', 'development_tools')),
  entry_kind text not null check (entry_kind in ('usage', 'invoice')),
  meter text,
  description text,
  call_id uuid references public.calls (id) on delete set null,
  lead_id uuid references public.leads (id) on delete set null,
  resource_ref text,
  quantity numeric(16, 4),
  unit text,
  rate_card_id uuid references public.rate_cards (id),
  currency text check (currency ~ '^[A-Z]{3}$'),
  -- NULL amount = usage with no rate card yet (unpriced), never assumed free.
  amount_micros bigint check (amount_micros >= 0),
  fx_rate_to_inr numeric(14, 6) check (fx_rate_to_inr > 0),
  fx_source text,
  amount_paise bigint check (amount_paise >= 0),
  cost_basis text not null check (cost_basis in ('estimated', 'invoiced')),
  bundled_in text,
  operating_cost boolean not null default true,
  is_simulated boolean not null default false,
  is_synthetic_rate boolean not null default false,
  reconciliation_status text not null default 'unreconciled'
    check (reconciliation_status in ('unreconciled', 'reconciled', 'not_applicable')),
  invoice_ref text,
  occurred_at timestamptz not null,
  period_start timestamptz,
  period_end timestamptz,
  dedupe_key text unique,
  created_by uuid references public.staff (id),
  created_at timestamptz not null default now(),
  constraint usage_invoice_period check (entry_kind <> 'invoice' or (period_start is not null and period_end is not null and period_end > period_start))
);
create index usage_events_occurred_idx on public.usage_events (occurred_at);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_kind text not null check (actor_kind in ('staff', 'system', 'voice_service', 'provider')),
  actor_staff_id uuid references public.staff (id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  request_id text,
  created_at timestamptz not null default now()
);
create index audit_events_entity_idx on public.audit_events (entity_type, entity_id, created_at);
create trigger audit_events_append_only before update or delete on public.audit_events
  for each row execute function public.reject_mutation();

create table public.rate_limit_buckets (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);

-- Persistent state for mock providers, so simulated CRM/calendar/email behaviour is
-- deterministic across serverless invocations. Never used in live mode.
create table public.mock_remote_objects (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  object_kind text not null,
  remote_id text not null unique,
  lookup_key text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index mock_remote_objects_lookup_idx on public.mock_remote_objects (provider, object_kind, lookup_key);
