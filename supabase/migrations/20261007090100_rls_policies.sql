-- Row-level security and role policies.
--
-- Access model:
--   * The browser (anon key + user JWT) may only READ through RLS; every write goes through
--     the Next.js API, which authorises the actor, then writes with the server connection.
--   * API reads for staff run as the `authenticated` role with request.jwt.claims set, so these
--     policies are enforced for API responses too (defence in depth).
--   * admin: everything. front_desk: all leads and exception queues. designer: assigned leads only.
--   * Service-only tables (provider events, outbox, mock provider state, rate limits) have RLS on
--     and no policies, so they are invisible to anon/authenticated.

create schema if not exists app_private;
revoke all on schema app_private from public;

create or replace function app_private.current_staff_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select s.id from public.staff s where s.auth_user_id = auth.uid() and s.active
$$;

create or replace function app_private.staff_role() returns text
language sql stable security definer set search_path = '' as $$
  select s.role from public.staff s where s.auth_user_id = auth.uid() and s.active
$$;

create or replace function app_private.can_view_lead(p_lead_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case app_private.staff_role()
    when 'admin' then true
    when 'front_desk' then true
    when 'designer' then exists (
      select 1 from public.leads l
      where l.id = p_lead_id and l.owner_staff_id = app_private.current_staff_id())
    else false
  end
$$;

grant usage on schema app_private to authenticated;
grant execute on all functions in schema app_private to authenticated;

-- Start from no table privileges for client roles, then grant SELECT where policies allow.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array[
    'staff', 'business_policies', 'leads', 'calls', 'utterances', 'field_evidence',
    'qualification_assessments', 'human_tasks', 'handoffs', 'bookings', 'integration_syncs',
    'outcome_events', 'provider_events', 'outbox_jobs', 'dispatcher_runs', 'rate_cards',
    'usage_events', 'audit_events', 'rate_limit_buckets', 'mock_remote_objects'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

grant select on public.staff, public.business_policies, public.leads, public.calls, public.utterances,
  public.field_evidence, public.qualification_assessments, public.human_tasks, public.handoffs,
  public.bookings, public.integration_syncs, public.outcome_events, public.dispatcher_runs,
  public.rate_cards, public.usage_events, public.audit_events
  to authenticated;

create policy staff_select on public.staff for select to authenticated
  using (id = app_private.current_staff_id() or app_private.staff_role() in ('admin', 'front_desk'));

create policy policies_select on public.business_policies for select to authenticated
  using (app_private.staff_role() in ('admin', 'front_desk'));

create policy leads_select on public.leads for select to authenticated
  using (
    app_private.staff_role() in ('admin', 'front_desk')
    or (app_private.staff_role() = 'designer' and owner_staff_id = app_private.current_staff_id())
  );

-- Calls without a lead yet are visible to admin/front desk only (can_view_lead(null) is false for designers).
create policy calls_select on public.calls for select to authenticated
  using (app_private.can_view_lead(lead_id));

-- Transcripts follow the lead: designers read transcripts of assigned leads only.
create policy utterances_select on public.utterances for select to authenticated
  using (exists (select 1 from public.calls c where c.id = call_id and app_private.can_view_lead(c.lead_id)));

create policy field_evidence_select on public.field_evidence for select to authenticated
  using (app_private.can_view_lead(lead_id));
create policy assessments_select on public.qualification_assessments for select to authenticated
  using (app_private.can_view_lead(lead_id));
create policy human_tasks_select on public.human_tasks for select to authenticated
  using (app_private.can_view_lead(lead_id));
create policy handoffs_select on public.handoffs for select to authenticated
  using (app_private.can_view_lead(lead_id));
create policy bookings_select on public.bookings for select to authenticated
  using (app_private.can_view_lead(lead_id));
create policy integration_syncs_select on public.integration_syncs for select to authenticated
  using (app_private.can_view_lead(lead_id));
create policy outcome_events_select on public.outcome_events for select to authenticated
  using (app_private.can_view_lead(lead_id));

create policy dispatcher_runs_select on public.dispatcher_runs for select to authenticated
  using (app_private.staff_role() in ('admin', 'front_desk'));
create policy rate_cards_select on public.rate_cards for select to authenticated
  using (app_private.staff_role() = 'admin');
create policy usage_events_select on public.usage_events for select to authenticated
  using (app_private.staff_role() = 'admin');
create policy audit_events_select on public.audit_events for select to authenticated
  using (app_private.staff_role() = 'admin');
