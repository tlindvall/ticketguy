/**
 * Why something prepared for an event no longer fits the event as it stands (R2-LIFECYCLE-01), or null when it
 * still does: the event must exist, still be scheduled and not have started. With `draftedForStartAt` (advice,
 * which records the occurrence it was written for) the start must also be unchanged; a missing record can't be
 * shown to match. Without it (a watch alert, whose observation is minutes old) the start isn't compared.
 */
export function eventChangedSince(event: { status: string; localStartAt: Date } | undefined, now: Date, draftedForStartAt?: string | null): string | null {
  if (!event) return 'event_missing';
  if (event.status !== 'scheduled') return `event_${event.status}`;
  if (draftedForStartAt !== undefined && (!draftedForStartAt || new Date(draftedForStartAt).getTime() !== event.localStartAt.getTime())) return draftedForStartAt ? 'event_rescheduled' : 'event_occurrence_unrecorded';
  if (event.localStartAt <= now) return 'event_started';
  return null;
}
