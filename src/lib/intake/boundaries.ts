import type { RequestExtraction } from '@/lib/domain/types';

/**
 * Limits on what one sender can make us do (DECISION_LOG #48). Every inbound email costs a model call and
 * can cost a reply, so a sender over these limits gets neither until the window has passed: the message is
 * kept and staff are told once, but nothing is extracted and nothing is sent. The limits are well above
 * what a real conversation needs (a long thread is a handful of emails an hour).
 */
export const INBOUND_PER_HOUR = 10;
export const INBOUND_PER_DAY = 30;
/** The "I only do tickets" reply goes to a sender at most this often; after that an off-topic email gets none. */
export const OFF_TOPIC_REPLY_EVERY_HOURS = 24;

export function overInboundLimit(counts: { lastHour: number; lastDay: number }): 'hour' | 'day' | null {
  if (counts.lastHour > INBOUND_PER_HOUR) return 'hour';
  if (counts.lastDay > INBOUND_PER_DAY) return 'day';
  return null;
}

const TICKET_WORDS = /\b(tickets?|seats?|game|games|show|shows|concerts?|gigs?|match|matches|tour|festival|events?|resale|stubhub|ticketmaster|seatgeek|vivid|box office|presale|on sale|section|row|courtside|floor|broadway|musical|comedy|stand-?up|playoffs?|season)\b/i;

/**
 * A first message that isn't about tickets: nobody, nothing and no kind of event named, no number of
 * tickets, budget, price or link, and none of the words people use for tickets. A city alone ("something
 * interesting about New York") is not a request. The model's own "other" counts only with the same absence,
 * so a terse real request it misfiles still gets answered.
 */
export function isOffTopic(x: RequestExtraction, text: string): boolean {
  const named = !!(x.performerOrTeam || x.eventName || x.categoryHint || x.genreHint);
  const specifics = x.quantity != null || x.budgetCents != null || x.quotedPriceCents != null || x.submittedUrls.length > 0 || !!x.dateExpression;
  const acted = ['watch_request', 'cancel_watch', 'marketing_opt_out', 'delete_data', 'browse'].includes(x.intent) || x.notifyAsked === true || x.resaleAsked === true || x.wantsMore === true;
  if (named || specifics || acted) return false;
  return !TICKET_WORDS.test(text);
}
