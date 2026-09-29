import { formatUsd } from '@/lib/domain/money';

/**
 * Plain-language wording for the staff console. The console showed internal state names
 * ("awaiting_review", "needs_clarification"), request ids and brief field names, so a reviewer had to know
 * the schema to know what to do. Everything a person reads there goes through here.
 */
export type Tone = 'danger' | 'warn' | 'ok' | 'muted' | 'info';

export type StateInfo = { label: string; tone: Tone; group: InboxGroup; next: string };
export type InboxGroup = 'needs_you' | 'waiting_customer' | 'working' | 'answered' | 'closed';

export const STATE: Record<string, StateInfo> = {
  awaiting_review: { label: 'Reply ready to approve', tone: 'warn', group: 'needs_you', next: 'Read the draft below and approve it, or re-check the prices first.' },
  manual_attention: { label: 'Stuck — needs a person', tone: 'danger', group: 'needs_you', next: 'The system could not handle this on its own. See why below, then reply to the customer yourself.' },
  needs_clarification: { label: 'Waiting on the customer', tone: 'muted', group: 'waiting_customer', next: 'We asked the customer a question. Nothing to do until they reply.' },
  received: { label: 'Just arrived', tone: 'info', group: 'working', next: 'Being read now. Nothing to do yet.' },
  interpreting: { label: 'Reading the email', tone: 'info', group: 'working', next: 'Being read now. Nothing to do yet.' },
  resolving_event: { label: 'Finding the event', tone: 'info', group: 'working', next: 'Matching the request to an event. Nothing to do yet.' },
  researching: { label: 'Checking prices', tone: 'info', group: 'working', next: 'Checking sellers. A draft reply will appear here for approval.' },
  recommendation_sent: { label: 'Answered', tone: 'ok', group: 'answered', next: 'The customer has our answer. Nothing to do unless they reply.' },
  referred: { label: 'Sent to the official sale', tone: 'ok', group: 'answered', next: 'Tickets are still on general sale, so we pointed the customer there. They can reply "compare" for resale.' },
  monitoring: { label: 'Watching for them', tone: 'ok', group: 'answered', next: 'We are watching for the customer: a sale opening or a new date emails them by itself; a price alert comes to you for approval.' },
  closed: { label: 'Closed', tone: 'muted', group: 'closed', next: 'Nothing to do.' },
  unsupported: { label: 'Outside what we cover', tone: 'muted', group: 'closed', next: 'We told the customer we can’t help with this one.' },
};

export function stateInfo(state: string): StateInfo {
  return STATE[state] ?? { label: state.replace(/_/g, ' '), tone: 'muted', group: 'working', next: '' };
}

export const GROUPS: Array<{ id: InboxGroup; title: string; empty: string }> = [
  { id: 'needs_you', title: 'Needs you', empty: 'Nothing waiting on you.' },
  { id: 'waiting_customer', title: 'Waiting on the customer', empty: 'No open questions to customers.' },
  { id: 'working', title: 'Working on it', empty: 'Nothing in progress.' },
  { id: 'answered', title: 'Answered', empty: 'Nothing answered yet.' },
];

/** Why a request is where it is, from the last transition's reason code. Unknown codes are shown as written. */
const REASON: Record<string, string> = {
  removed_by_staff: 'Removed from the board by staff.',
  draft_ready: 'Draft reply with a recommendation is ready.',
  no_verified_result_pending_review: 'Draft reply is ready, but it has no listing to recommend.',
  approved_recommendation_sent: 'Sent after approval.',
  price_check_auto_sent: 'Price check answered automatically (no listing in it).',
  official_sale_open: 'Still on general sale; pointed to the official seller.',
  event_alert_on_sale: 'Not on sale yet; we’ll email them when the general sale opens.',
  event_alert_new_date: 'Nothing scheduled yet; we’ll email them when a date is announced.',
  event_alert_sent: 'We emailed them that it’s on sale / announced.',
  browse_options: 'Sent a few event ideas; waiting for them to pick one.',
  brief_complete: 'We have everything we need; checking prices.',
  deletion_requested_pending_verification: 'Customer asked us to delete their data. Verify it is really them.',
  opt_out_only: 'Customer only unsubscribed.',
  customer_outside_us: 'Customer is outside the US.',
  event_outside_us: 'The event is outside the US.',
};

const FIELD_QUESTION: Record<string, string> = {
  quantity: 'how many tickets',
  resolvedLocalDate: 'which date',
  dateExpression: 'which date',
  performerOrTeam: 'which event',
  eventName: 'which event',
  city: 'which city',
  budgetBasis: 'whether the budget is per ticket or total',
  event: 'which event',
};

export function reasonText(reason: string | null | undefined, state: string): string {
  if (!reason) return '';
  if (REASON[reason]) return REASON[reason]!;
  if (state === 'needs_clarification' && /^[a-zA-Z_,]+$/.test(reason)) {
    const asked = [...new Set(reason.split(',').map((f) => FIELD_QUESTION[f] ?? f.replace(/_/g, ' ')))];
    return `We asked ${asked.join(' and ')}.`;
  }
  return reason.replace(/_/g, ' ');
}

/** "3 min ago", "2 h ago", "4 days ago". */
export function ago(fromMs: number, nowMs: number): string {
  const m = Math.max(0, Math.floor((nowMs - fromMs) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** "Sun, Oct 11, 1:00 PM" in the venue's own time zone. */
export function whenLocal(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone }).format(at);
}

/** "Sep 28, 8:13 PM" in the staff's time (Eastern, where staffed hours are kept). */
export function whenStaff(at: Date): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' }).format(at);
}

/** The buying brief as a reviewer would say it. Unset fields are left out, not shown as "—". */
export function briefLines(b: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const yes = (v: unknown) => v === true;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const INTENT: Record<string, string> = { new_search: 'Tickets for an event', browse: 'Ideas for what to see', clarification: 'Answering our question', watch_request: 'Watch prices for them', cancel_watch: 'Stop watching', marketing_opt_out: 'Unsubscribe', delete_data: 'Delete their data', other: 'Something else' };
  if (str(b.intent)) out.push(['Wants', INTENT[b.intent as string] ?? String(b.intent)]);
  const what = str(b.performerOrTeam) ?? str(b.eventName);
  if (what) out.push(['Event', what]);
  if (str(b.city)) out.push(['City', str(b.city)!]);
  const iso = str(b.resolvedLocalDate);
  const date = iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`)) : str(b.dateExpression);
  if (date) out.push(['When', date]);
  if (typeof b.quantity === 'number') out.push(['Tickets', `${b.quantity}${yes(b.togetherRequired) ? ', together' : ''}`]);
  if (typeof b.budgetCents === 'number') out.push(['Budget', `${formatUsd(b.budgetCents)}${b.budgetBasis === 'whole_party' ? ' total' : b.budgetBasis === 'per_ticket' ? ' per ticket' : ''}`]);
  if (typeof b.quotedPriceCents === 'number') out.push(['Price they saw', `${formatUsd(b.quotedPriceCents)}${b.quotedPriceBasis === 'whole_party' ? ' total' : ' per ticket'}`]);
  if (yes(b.resaleAsked)) out.push(['Asked about resale', 'Yes']);
  if (str(b.seatingPreference)) out.push(['Seats', str(b.seatingPreference)!]);
  if (str(b.accessibilityNeeds)) out.push(['Accessibility', str(b.accessibilityNeeds)!]);
  if (yes(b.mustAttend)) out.push(['Must go', 'Yes — would rather pay more than miss it']);
  const WAIT: Record<string, string> = { low: 'Would rather buy now', medium: 'Open to waiting a bit', high: 'Happy to wait for a better price' };
  if (str(b.waitRiskTolerance)) out.push(['Waiting', WAIT[b.waitRiskTolerance as string] ?? String(b.waitRiskTolerance)]);
  if (str(b.genreHint)) out.push(['Music', str(b.genreHint)!]);
  if (str(b.categoryHint)) out.push(['Kind of event', String(b.categoryHint)]);
  return out;
}

const SEND_CLASS: Record<string, string> = {
  acknowledgment: 'Automatic reply',
  clarification: 'Question to customer',
  recommendation: 'Recommendation',
  no_result: 'Answer (no listing)',
  watch_confirmation: 'Watch confirmation',
  watch_alert: 'Price alert',
  event_alert: 'Sale / new date alert',
  marketing: 'Marketing',
  verification: 'Verification',
};
export const sendClassLabel = (c: string) => SEND_CLASS[c] ?? c;

const SEND_STATE: Record<string, [string, Tone]> = {
  queued: ['Queued', 'muted'],
  claimed: ['Sending', 'muted'],
  provider_accepted: ['Sent', 'ok'],
  delivered: ['Delivered', 'ok'],
  delayed: ['Delayed', 'warn'],
  bounced: ['Bounced', 'danger'],
  complained: ['Marked as spam', 'danger'],
  failed: ['Failed', 'danger'],
  suppressed: ['Not sent (suppressed)', 'warn'],
  uncertain: ['Unknown — check Resend', 'warn'],
  blocked: ['Not sent (blocked)', 'warn'],
};
export const sendStateInfo = (s: string): [string, Tone] => SEND_STATE[s] ?? [s, 'muted'];

export const toneClass: Record<Tone, string> = {
  danger: 'tg-badge-danger',
  warn: 'tg-badge-warn',
  ok: 'tg-badge-ok',
  muted: 'tg-badge-muted',
  info: 'tg-badge-info',
};
