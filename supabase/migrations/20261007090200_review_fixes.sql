-- Review fixes.
-- At most one booking per lead may be in flight or confirmed. Conflicts, failures and declines
-- do not count, so a caller can pick another slot after those.
create unique index bookings_one_active_per_lead on public.bookings (lead_id)
  where status in ('requested', 'pending_reconciliation', 'confirmed');
