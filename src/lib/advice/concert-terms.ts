import { flat, minutesOf } from './text-offers';

export type Admission = 'included' | 'excluded' | 'unknown';
export type ProductKind = 'admission' | 'parking' | 'shuttle' | 'upgrade' | 'package' | 'unknown';

/** Entitlement belongs to one product, never to the cheapest number in the email. */
export function admissionTerms(text: string): { admission: Admission; admissionStated: boolean; productKind: ProductKind } {
  const t = flat(text);
  const productKind: ProductKind = /\b(?:packages?|bundles?)\b/i.test(t) ? 'package' : /\bparking\b/i.test(t) ? 'parking' : /\bshuttle\b/i.test(t) ? 'shuttle' : /\b(?:upgrade|merchandise)\b/i.test(t) ? 'upgrade' : /\b(?:admissions?|concert tickets?|festival pass|entry)\b/i.test(t) ? 'admission' : 'unknown';
  const excluded = /\b(?:concert tickets?|event tickets?|admission)\b[^.;?]{0,25}\b(?:sold|purchased|bought) separately\b|\b(?:no|zero|0|without)\s+(?:(?:concert|event|festival)\s+)?admissions?\b|\b(?:concert|event|festival|admission) tickets? (?:is |are )?not included\b|\b(?:does not|doesn't|do not|don't) include (?:a |an |any )?(?:(?:concert|event|festival) )?(?:tickets?|admission)\b|\b(?:parking|shuttle|merchandise)[- ]only\b|\b(?:separate|additional) (?:concert |event )?(?:admission|ticket) (?:is )?required\b|\b(?:must|need to) already (?:hold|have) a separate (?:show|concert|event) ticket\b|\b(?:does not|doesn't) get you (?:through the door|into the (?:show|concert))\b/i.test(t);
  const uncertain = /\b(?:is|whether|unsure)\b[^.;?]{0,35}\badmission\b[^.;]{0,25}\?|\badmission (?:is )?included\?|\b(?:admission|ticket)\b[^.;]{0,30}\b(?:unknown|unclear|not stated|not specified|may|might)\b|\b(?:may|might) include\b/i.test(t);
  const included = /\b(?:concert|event|festival|general)[- ]admissions?\b|\b(?:concert|admission) (?:tickets?|seats?)\b|\bconcert where\b|\b(?:DJ|dance) (?:dance )?party\b|\bfestival pass\b|\bany[- ]?time entry\b|\bentry before (?:midnight|\d{1,2})\b|\badmission valid (?:until|through)\b|\b(?:includes?|including|with)\s+(?:(?:two|2|a|an)\s+)?(?:(?:GA|concert|event|festival)\s+)?admissions?\b/i.test(t);
  const explicitAdmission = /\b(?:concert|event|festival|general)[- ]admissions?\b|\bconcert tickets?\b/i.test(t);
  const ancillary = ['parking', 'shuttle', 'upgrade'].includes(productKind);
  const admission: Admission = excluded ? 'excluded' : uncertain ? 'unknown' : included && (!ancillary || explicitAdmission) ? 'included' : ['parking', 'shuttle'].includes(productKind) ? 'excluded' : 'unknown';
  return { productKind: productKind === 'unknown' && admission === 'included' ? 'admission' : productKind, admission, admissionStated: excluded || uncertain || included || ancillary };
}

export type EntryTerm = { kind: 'anytime' } | { kind: 'before'; minutes: number; boundary?: 'strict' | 'inclusive' | 'unspecified'; date?: string | null } | { kind: 'unknown' };
const TIME = '(midnight|noon|\\d{1,2}(?::\\d{2})?\\s*[ap]m)';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function dateIn(s: string, year: number): string | null {
  const m = /\b(Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)\s+(\d{1,2})(?:,?\s+(20\d{2}))?\b/i.exec(s);
  if (!m || !year) return null;
  const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1;
  const day = Number(m[2]);
  const y = Number(m[3] ?? year);
  const iso = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}
export function entryTerm(text: string, year = 0): EntryTerm | null {
  const t = flat(text);
  if (/\bany[- ]?time entry\b|\bentry (?:at )?any time\b/i.test(t)) return { kind: 'anytime' };
  // A replacement often quotes the old condition negatively ("until 2am, not before midnight").
  const m = new RegExp(`\\b(?:entry|enter|admission(?: valid)?|last entry)\\s+(?:only\\s+)?(before|until|by|through)\\s+${TIME}([^.;]*)`, 'i').exec(t);
  if (m && minutesOf(m[2]!) === null) return { kind: 'unknown' };
  if (m) return { kind: 'before', minutes: minutesOf(m[2]!)!, boundary: /before/i.test(m[1]!) ? 'strict' : /by/i.test(m[1]!) ? 'inclusive' : 'unspecified', date: dateIn(m[3]!, Number(/\b(20\d{2})\b/.exec(t)?.[1] ?? year)) };
  return /\bentry (?:cutoff|deadline|restriction)\b/i.test(t) ? { kind: 'unknown' } : null;
}

export type NightTiming = { eventDate: string | null; start: number | null; doors: number | null; arrivalDate: string | null; arrival: number | null };
/** Calendar dates and venue-local wall-clock times stay separate. Only arrival statements update arrival. */
export function nightTiming(messages: string[]): NightTiming | null {
  const out: NightTiming = { eventDate: null, start: null, doors: null, arrivalDate: null, arrival: null };
  for (const raw of messages) {
    const t = flat(raw);
    const year = Number(/\b(20\d{2})\b/.exec(t)?.[1] ?? out.eventDate?.slice(0, 4) ?? 0);
    const start = new RegExp(`\\b(?:event|it|night|show|house night)\\s+([^.;!?]{0,70}?)\\bstart(?:s|ing)?\\s+([^.;!?]{0,70}?)${TIME}`, 'i').exec(t);
    if (start) {
      out.eventDate = dateIn(`${start[1]} ${start[2]}`, year) ?? out.eventDate;
      out.start = minutesOf(start[3]!);
    }
    // A date can precede the time or follow it. A price-only or cutoff correction isn't an arrival change.
    const arrival = /\b(?:we (?:will |will be |are back to |are |will be back to )?(?:arriv\w*|mean)|we'll arrive|arrival(?: is| changes)?|our arrival changes)\b([^.;!?]+)/i.exec(t)?.[1];
    if (arrival) {
      const tm = new RegExp(TIME, 'i').exec(arrival);
      const date = dateIn(arrival, year);
      if (date) out.arrivalDate = date;
      else if (/not specified|unspecified|which calendar date/i.test(t)) out.arrivalDate = null;
      if (tm) out.arrival = minutesOf(tm[1]!);
    }
    const doors = new RegExp(`\\bdoors(?: open)?(?: at)?\\s+${TIME}`, 'i').exec(t);
    if (doors) out.doors = minutesOf(doors[1]!);
  }
  return out.arrival !== null ? out : null;
}

export function entryFailure(term: EntryTerm | null, timing: NightTiming | null): string | null {
  if (!timing) return null;
  if (term?.kind === 'anytime') return null;
  if (!term || term.kind === 'unknown') return 'the entry cutoff is unknown; confirm that the ticket allows your arrival time';
  if (!timing.eventDate || !timing.arrivalDate || timing.start === null) return 'the entry cutoff needs the event and arrival calendar dates before I can confirm it works';
  const days = (Date.parse(timing.arrivalDate) - Date.parse(timing.eventDate)) / 86_400_000;
  const cutoffDays = term.date ? (Date.parse(term.date) - Date.parse(timing.eventDate)) / 86_400_000 : term.minutes < 720 && timing.start >= 720 ? 1 : 0;
  const cutoff = term.minutes + cutoffDays * 1440;
  const arrival = days * 1440 + timing.arrival!;
  if (arrival < timing.start) return 'your arrival precedes the event start; confirm when this ticket permits entry';
  if (arrival === cutoff && term.boundary === 'unspecified') return 'arrival exactly at the cutoff is not confirmed by “until”; check whether the organizer includes that instant';
  return (term.boundary === 'inclusive' ? arrival > cutoff : arrival >= cutoff) ? `entry ${term.boundary === 'inclusive' ? 'by the stated time' : term.minutes === 0 ? 'before midnight' : 'before the stated time'} does not allow your arrival ${term.boundary === 'inclusive' ? 'after' : 'at or after'} the cutoff` : null;
}

/** Music context is independent of a model's calendar/entity guess. */
export function concertContext(messages: string[]): boolean {
  return /\b(?:concert|festival|house night|DJ (?:event|night|dance|party)|pop gig|country show|music gig|different DJ event|separately ticketed)\b/i.test(messages.join(' '));
}

export type MusicExperience = { artist: string | null; kind: 'artist' | 'party' | null };
export function musicExperience(messages: string[]): MusicExperience {
  const out: MusicExperience = { artist: null, kind: null };
  for (const raw of messages) {
    const t = flat(raw);
    // Party identity is a requirement only when the customer says they want that experience.
    if (/\b(?:(?:now|just|only) )?want (?:a |the |to dance at the )?(?:DJ|dance|party|recordings|tribute)\b/i.test(t)) out.kind = 'party';
    else if (/\b(?:we|us|I)\b[^.!?]{0,35}\bwant\b[^.!?]{0,80}\b(?:herself|himself|themselves|actual artist|original artist|performing|perform)\b/i.test(t)) out.kind = 'artist';
    const named = /\b(?:want(?: to see)?|see)\s+([A-Z][a-z]+(?: [A-Z][a-z]+){0,3})\s+(?:at|herself|himself|themselves|performing|live)\b/.exec(t);
    if (named) out.artist = named[1]!;
  }
  return out;
}

export type PerformanceTerms = { appearance: 'live' | 'absent' | 'unknown' | null; differentEvent: boolean; sameEventStated?: boolean; description: string };
export function performanceTerms(text: string): PerformanceTerms {
  const t = flat(text);
  const absent = /\b(?:will not|won't|does not|doesn't|NOT)\s+(?:appear|perform|appearing)\b|\bnot on (?:its|the) lineup\b|\brecordings only\b/i.test(t);
  const live = /\b(?:will|does)\s+(?:appear|perform)\b|\b(?:herself|himself|themselves) (?:performs?|performing)\b|\bperforming live\b/i.test(t);
  const unknown = /\b(?:appearance|performer)\b[^.;]{0,25}\b(?:unknown|unconfirmed|unclear)\b/i.test(t);
  return { sameEventStated: /\b(?:replacement|now|corrected)\b[^.;]{0,50}\b(?:same|requested) (?:event|performance|show)\b/i.test(t), appearance: unknown ? 'unknown' : absent ? 'absent' : live ? 'live' : null, differentEvent: /\b(?:different|separate) (?:DJ[- ]?)?(?:event|performance)\b|\bnot on (?:its|the) lineup\b/i.test(t), description: t };
}

function confirmsRequestedArtist(text: string, artist: string | null): boolean {
  if (/\b(?:original artist|actual artist|artist herself|artist himself) (?:will|does) (?:appear|perform)\b/i.test(text)) return true;
  if (!artist) return false;
  const name = artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${name}\\s+(?:(?:herself|himself|themselves)\\s+)?(?:(?:will|does)\\s+(?:appear|perform)|performs?\\b|performing\\b)`, 'i').test(text);
}

export function performanceFailure(performance: PerformanceTerms | undefined, goal: MusicExperience | undefined): string | null {
  if (!performance || !goal) return null;
  if (goal.kind === 'party') return performance.appearance === 'live' ? 'it is the original-artist performance, not the DJ or tribute experience you now want' : null;
  if (performance.differentEvent) return 'it admits you to a different event, not the requested performance; being in the same venue does not establish cross-event access';
  if (goal.kind === 'artist' && performance.appearance === 'absent') return 'the original artist will not appear; this admission does not meet your live-artist goal';
  if (goal.kind === 'artist' && goal.artist && performance.appearance === 'live' && !confirmsRequestedArtist(performance.description, goal.artist)) return 'the requested artist’s live appearance is unconfirmed; another performer’s appearance does not establish it';
  if (goal.artist && !performance.description.toLowerCase().includes(goal.artist.toLowerCase()) && performance.appearance !== null) return 'the requested artist’s appearance is not established by this offer’s description';
  if (goal.kind === 'artist' && performance.appearance !== 'live') return 'the requested artist’s live appearance is unconfirmed in these supplied terms';
  return null;
}

/** A deliberate shift to taste-based discovery clears the obsolete exact-artist target. */
export function similarMusicGoal(text: string): boolean {
  const t = flat(text);
  return /\b(?:music|pop|artist|concert|shows?)\b/i.test(t) && /\b(?:don't|do not|no longer) need\b[^.!?]{0,70}\bspecifically\b|\b(?:other|similar|different) (?:big )?(?:pop )?shows? instead\b/i.test(t);
}

export type CopiedAdmissionPolicy = {
  minimumAge: number | null;
  guardianRequired: boolean | null;
  guardianUnderAge?: number | null;
  unaccompaniedFromAge?: number | null;
  acceptedId: string | null;
  sourceUrl: string | null;
  provenance: 'customer_supplied';
};

/** Read a customer's quoted conditions; a copied page is never independently verified evidence. */
export function copiedAdmissionPolicy(text: string): CopiedAdmissionPolicy | null {
  const full = flat(text);
  if (!/\b(?:policy|terms|event page|ticket page|organizer)\b|\bvenue says\b/i.test(full)) return null;
  const start = /\b(?:says|states|reads)\s*:?\s*|:\s*/i.exec(full);
  // The customer's plan ("will go without an adult") is not the organizer's permission.
  const t = (start ? full.slice(start.index + start[0].length) : full).split(/\b(?:Both (?:have|\d{1,2}[- ]year)|They (?:only )?have|Do (?:these|both)|Can they|Is being)\b/i)[0]!;
  const from = /\b(?:aged?\s+|minimum(?: age)?\s+)(\d{1,2})(?: and (?:above|older)| or older|\s*[,;])/i.exec(t);
  const minimum = /\b(?:ages? |aged? )?(1[0-9]|2[01])\s*\+|\bminimum age (?:is )?(\d{1,2})\b/i.exec(t);
  const threshold = /\b(?:anyone |guests? |attendees? )?under[- ](\d{1,2})(?:s|[- ]year[- ]olds?)?\b[^.;]{0,55}\b(?:parent|guardian|adult)\b/i.exec(t);
  const prohibited = /\b(?:may not|cannot|can't|not allowed to) (?:enter|attend) (?:unaccompanied|without (?:an? )?(?:adult|parent|guardian))\b|\bunaccompanied (?:is )?not permitted\b/i.test(t);
  const unaccompanied = !prohibited && /\b(?:guests?|attendees?|minors?|1[0-7][- ]year[- ]olds?)\b[^.;]{0,65}\b(?:may|can|are allowed to) (?:enter|attend) (?:unaccompanied|without (?:an? )?(?:adult|guardian|parent))\b|\bunaccompanied (?:is )?permitted\b/i.test(t);
  const noGuardian = !prohibited && (/\bno (?:adult|guardian|parent) (?:is )?required\b/i.test(t) || unaccompanied);
  const guardian = prohibited || /\b(?:must|have to) (?:be accompanied by|attend with) (?:an? )?(?:adult|guardian|parent)\b|\b(?:adult|guardian|parent) (?:is )?required\b/i.test(t);
  const id = /\b((?:government[- ]issued(?: photo)?|school[- ]issued(?: photo)?|school photo|photo|student) ID)\b/i.exec(t);
  if (!minimum && !from && !threshold && !noGuardian && !guardian && !id) return null;
  return {
    minimumAge: minimum ? Number(minimum[1] ?? minimum[2]) : /\ball ages\b/i.test(t) ? 0 : from ? Number(from[1]) : null,
    guardianRequired: noGuardian ? false : threshold ? null : guardian ? true : null,
    guardianUnderAge: threshold ? Number(threshold[1]) : null,
    unaccompaniedFromAge: unaccompanied && from ? Number(from[1]) : null,
    acceptedId: id?.[1] ?? null,
    sourceUrl: /https:\/\/[^\s<>"']+/i.exec(t)?.[0]?.replace(/[.,);]+$/, '') ?? null,
    provenance: 'customer_supplied',
  };
}

function policyAnswer(messages: string[], youngest: number | null): { lead: string; items: string[] } {
  let policy: CopiedAdmissionPolicy | null = null;
  let heldId: 'school' | 'government' | null = null;
  for (const raw of messages) {
    const t = flat(raw);
    const next = copiedAdmissionPolicy(t);
    if (next) {
      // An ID-only correction must not erase the event's age and guardian conditions.
      policy = policy ? {
        ...next,
        minimumAge: next.minimumAge ?? policy.minimumAge,
        guardianRequired: next.guardianRequired ?? policy.guardianRequired,
        guardianUnderAge: next.guardianRequired === false ? null : next.guardianUnderAge ?? policy.guardianUnderAge,
        unaccompaniedFromAge: next.unaccompaniedFromAge ?? policy.unaccompaniedFromAge,
        acceptedId: next.acceptedId ?? policy.acceptedId,
        sourceUrl: next.sourceUrl ?? policy.sourceUrl,
      } : next;
    }
    if (/\b(?:they|both|each|we) (?:only )?have (?:a |their )?school(?:[- ]issued)? photo IDs?\b/i.test(t)) heldId = 'school';
    else if (/\b(?:they|both|each|we) (?:now )?have (?:a |their )?government[- ]issued (?:photo )?IDs?\b/i.test(t)) heldId = 'government';
  }
  if (!policy) return { lead: 'I haven’t verified any event-specific policy admitting them without an adult, so I can’t confirm that either can enter unaccompanied.', items: ['An age label such as “16+” or “all ages” alone does not verify the guardian or ID requirements. This does not mean the venue refuses minors.', 'Before buying, confirm unaccompanied admission for their ages and accepted ID with the event organizer. If you paste the policy, I can work through it with you.'] };
  const ageFails = youngest !== null && policy.minimumAge !== null && youngest < policy.minimumAge;
  const guardianFails = policy.guardianRequired === true || youngest !== null && policy.guardianUnderAge != null && youngest < policy.guardianUnderAge;
  const guardianPasses = policy.guardianRequired === false && (policy.unaccompaniedFromAge == null || youngest !== null && youngest >= policy.unaccompaniedFromAge) || policy.guardianUnderAge != null && youngest !== null && youngest >= policy.guardianUnderAge;
  const idFails = /government/i.test(policy.acceptedId ?? '') && heldId === 'school';
  const idPasses = heldId !== null && policy.acceptedId !== null && (/school|student/i.test(policy.acceptedId) ? heldId === 'school' : /government/i.test(policy.acceptedId) ? heldId === 'government' : /photo ID/i.test(policy.acceptedId));
  const agePasses = youngest !== null && policy.minimumAge !== null && youngest >= policy.minimumAge;
  const lead = guardianFails || ageFails
    ? 'Based on the policy you pasted, they cannot attend unaccompanied under those terms.'
    : idFails
      ? 'Their school photo ID does not meet the supplied government-issued ID requirement. The age-rule change alone doesn’t make this plan work.'
      : agePasses && guardianPasses && idPasses
        ? 'Based on the policy you pasted, both meet the supplied entry requirements: age, unaccompanied admission and accepted ID.'
        : agePasses && guardianPasses
          ? 'Based on the policy you pasted, their ages meet the minimum and no guardian is required. Their accepted ID still needs confirming.'
          : 'The policy you pasted does not establish all the age and guardian conditions needed to confirm unaccompanied admission.';
  return { lead, items: [policy.acceptedId ? `The supplied policy names ${policy.acceptedId}${idPasses ? ', which matches the ID you say they have.' : idFails ? '; school photo ID isn’t that form of ID.' : '; confirm they each have an accepted form.'}` : 'Accepted ID is not established by the supplied policy.', 'I haven’t independently verified that this policy is current or applies to the exact event. Check the actual event page before buying.'] };
}

/** Attendee ages come from the customer's plan, never age thresholds inside the copied policy. */
function youngestAttendee(messages: string[]): number | null {
  let youngest: number | null = null;
  for (const raw of messages) {
    for (const sentence of flat(raw).split(/(?<=[.!?])\s+/)) {
      const both = /\bboth (?:are |aged? )?(\d{1,2})\b/i.exec(sentence);
      if (both) { youngest = Number(both[1]); continue; }
      if (!/^(?:My|Our|We|They|Two|Three|Four|\d+)\b/i.test(sentence)) continue;
      const own = sentence.split(/\b(?:policy|terms|(?:event|ticket)[- ](?:specific[- ])?page|I copied)\b/i)[0]!;
      const ages = [...own.matchAll(/\b(\d{1,2})[- ]year[- ]olds?\b|\baged? (\d{1,2})(?: and (\d{1,2}))?\b/gi)].flatMap((m) => [m[1] ?? m[2], m[3]].filter((a) => a !== undefined).map(Number));
      if (ages.length) youngest = Math.min(...ages);
    }
  }
  return youngest;
}

export function concertQuestion(messages: string[]): { lead: string; items: string[] } | null {
  const latest = flat(messages.at(-1) ?? '');
  const all = flat(messages.join(' '));
  const minor = /\b(?:1[0-7][- ]year[- ]olds?|minors?|both 1[0-7]|aged? 1[0-7])\b/i.test(all);
  const alone = /\bunaccompanied\b|\bwithout (?:any |an? )?(?:adults?|guardians?|parents?)\b/i.test(all);
  if (minor && alone && concertContext(messages) && /\b(?:enter|entry|admi\w*|policy|policies|terms|guardian|adult|unaccompanied)\b/i.test(latest)) {
    return policyAnswer(messages, youngestAttendee(messages));
  }
  // A single entitlement question needs no calendar search or second offer.
  if (concertContext(messages) && admissionTerms(latest).admission === 'excluded' && /\b(?:get us into|through the door|entitlement|would these|would this)\b/i.test(latest)) return { lead: 'No — these upgrades include no concert admission, so they cannot get you into the concert.', items: ['You need a separate concert admission ticket for each person. The merchandise or upgrade price does not change that.', 'That is based on the description you sent; I haven’t independently verified the seller’s terms.'] };
  if (/\b(?:separate|different)\b[^.!?]{0,45}\b(?:ticket|event)\b/i.test(latest) && /\b(?:let us into|room-access|cross[- ]event|because it.s all)\b/i.test(latest)) return { lead: 'A ticket to a separate event does not establish entry to the performance you want. I wouldn’t buy it for that purpose without explicit cross-event access.', items: ['Being in the same building doesn’t make two separately ticketed rooms one event. Use the ticket for the named performance and room, or get the organizer’s confirmation.', 'Based on the event details you sent; I haven’t independently verified the current room-access terms.'] };
  const goalArtist = musicExperience(messages).artist;
  const appearance = [...messages].reverse().map(performanceTerms).find((p) => p.appearance !== null && (p.appearance !== 'live' || !goalArtist || confirmsRequestedArtist(p.description, goalArtist)))?.appearance;
  const party = /\b(?:DJ|tribute|listening|dance)\b[^.!?]{0,40}\b(?:party|show|recordings|tracks)\b|\btribute\b/i.test(all);
  if (party && !similarMusicGoal(latest) && /\b(?:DJ|tribute|listening|party|recordings|this|it|that|description)\b/i.test(latest) && /\b(?:buy|skip|see|perform|goal)\b/i.test(latest)) {
    if (musicExperience(messages).kind === 'party') return { lead: 'For your new goal, the party could fit: it is the DJ or tribute experience described, not an appearance by the original artist.', items: ['Based on the description you sent; I haven’t verified admission terms or availability.'] };
    // A new different show is not a correction to the old party.
    if (/\b(?:a |new |another )different concert with\b/i.test(latest)) return null;
    if (performanceTerms(latest).appearance === 'live' && (!goalArtist || confirmsRequestedArtist(latest, goalArtist))) return { lead: 'Based on the updated description you sent, the original artist will perform. That meets your artist-appearance goal, subject to those terms being accurate.', items: ['I haven’t independently verified the appearance, ticket entitlement or availability.'] };
    if (appearance === 'absent' && /\b(?:herself|himself|themselves|actual artist|original artist|see .{1,40} live)\b/i.test(all)) return { lead: 'Skip it if you want to see the original artist perform. The description you sent says the artist will not appear.', items: ['This ticket buys the DJ, tribute or listening-party experience described, not a performance by that artist. I haven’t independently verified the listing.'] };
    if (/\b(?:herself|himself|original artist|actual artist)\b/i.test(latest)) return { lead: 'A tribute or listening party does not establish that the original artist will perform. Don’t buy it for that goal without an explicit artist appearance in the event terms.', items: ['Artist appearance is unverified from the description you sent.'] };
  }
  return null;
}

/** Only a customer's explicitly named budget, never the first offer's price. */
export function concertBudget(text: string): { cents: number; basis: 'whole_party' | 'per_ticket' | null } | null {
  const t = flat(text);
  const m = /\b(?:budget|cap|limit|up to|max(?:imum)?|no more than|at most|under|can spend|can afford|willing to pay)\s*(?:is|of|to|stayed)?\s*\$([\d,]+(?:\.\d{2})?)([^.!?;]{0,35})/i.exec(t)
    ?? /\$([\d,]+(?:\.\d{2})?)\s*((?:(?:TOTAL|all-in|each|per ticket)\s+)?(?:admission )?(?:budget|max|cap))\b/i.exec(t);
  const own = m ?? /(?:^|[.!?]\s+)\$([\d,]+(?:\.\d{2})?)\s*(TOTAL)(?:\s+for (?:both|the pair|all[^.!?]{0,20}))?\s*[.!?]/i.exec(t)
    ?? /\b(?:we have|our budget is|(?:one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2}) (?:people|adults),)\s*\$([\d,]+(?:\.\d{2})?)\s*(TOTAL|each|per ticket)?/i.exec(t);
  if (!own) return null;
  const basis = /each|per ticket/i.test(own[2]!) ? 'per_ticket' : /total|pair|both|all-in/i.test(own[2]!) ? 'whole_party' : null;
  return { cents: Math.round(Number(own[1]!.replace(/,/g, '')) * 100), basis };
}
