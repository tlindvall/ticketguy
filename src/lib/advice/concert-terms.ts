import { flat, minutesOf } from './text-offers';

export type Admission = 'included' | 'excluded' | 'unknown';
export type ProductKind = 'admission' | 'parking' | 'shuttle' | 'upgrade' | 'package' | 'unknown';

/** Entitlement belongs to one product, never to the cheapest number in the email. */
export function admissionTerms(text: string): { admission: Admission; admissionStated: boolean; productKind: ProductKind } {
  const t = flat(text);
  const productKind: ProductKind = /\b(?:package|bundle)\b/i.test(t) ? 'package' : /\bparking\b/i.test(t) ? 'parking' : /\bshuttle\b/i.test(t) ? 'shuttle' : /\b(?:upgrade|merchandise)\b/i.test(t) ? 'upgrade' : /\b(?:admission|concert tickets?|festival pass|entry)\b/i.test(t) ? 'admission' : 'unknown';
  const excluded = /\b(?:no|zero|0|without)\s+(?:(?:concert|event|festival)\s+)?admissions?\b|\b(?:concert|event|festival|admission) tickets? (?:is |are )?not included\b|\b(?:does not|doesn't|do not|don't) include (?:a |an |any )?(?:(?:concert|event|festival) )?(?:tickets?|admission)\b|\b(?:parking|shuttle|merchandise)[- ]only\b|\b(?:separate|additional) (?:concert |event )?(?:admission|ticket) (?:is )?required\b/i.test(t);
  const uncertain = /\b(?:admission|ticket)\b[^.;]{0,30}\b(?:unknown|unclear|not stated|not specified|may|might)\b|\b(?:may|might) include\b/i.test(t);
  const included = /\b(?:concert|event|festival|general)[- ]admissions?\b|\b(?:concert|admission) (?:tickets?|seats?)\b|\bfestival pass\b|\bany[- ]?time entry\b|\bentry before (?:midnight|\d{1,2})\b|\b(?:includes?|including|with)\s+(?:(?:two|2|a|an)\s+)?(?:(?:GA|concert|event|festival)\s+)?admissions?\b/i.test(t);
  const explicitAdmission = /\b(?:concert|event|festival|general)[- ]admissions?\b|\bconcert tickets?\b/i.test(t);
  const ancillary = ['parking', 'shuttle', 'upgrade'].includes(productKind);
  const admission: Admission = excluded ? 'excluded' : uncertain ? 'unknown' : included && (!ancillary || explicitAdmission) ? 'included' : ['parking', 'shuttle'].includes(productKind) ? 'excluded' : 'unknown';
  return { productKind, admission, admissionStated: excluded || uncertain || included || ancillary };
}

export type EntryTerm = { kind: 'anytime' } | { kind: 'before'; minutes: number } | { kind: 'unknown' };
const TIME = '(midnight|noon|\\d{1,2}(?::\\d{2})?\\s*[ap]m)';
export function entryTerm(text: string): EntryTerm | null {
  if (/\bany[- ]?time entry\b|\bentry (?:at )?any time\b/i.test(text)) return { kind: 'anytime' };
  const m = new RegExp(`\\b(?:entry|enter|admission)\\s+(?:only\\s+)?before\\s+${TIME}`, 'i').exec(text);
  if (m) return { kind: 'before', minutes: minutesOf(m[1]!)! };
  return /\bentry (?:cutoff|deadline|restriction)\b/i.test(text) ? { kind: 'unknown' } : null;
}

export type NightTiming = { eventDate: string | null; start: number | null; doors: number | null; arrivalDate: string | null; arrival: number | null };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function dateIn(s: string, year: number): string | null {
  const m = /\b(Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)\s+(\d{1,2})(?:,?\s+(20\d{2}))?\b/i.exec(s);
  if (!m) return null;
  return `${m[3] ?? year}-${String(MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
}
/** Calendar dates and wall-clock times are separate; doors never stand in for show time. */
export function nightTiming(messages: string[]): NightTiming | null {
  const out: NightTiming = { eventDate: null, start: null, doors: null, arrivalDate: null, arrival: null };
  for (const raw of messages) {
    const t = flat(raw);
    const year = Number(/\b(20\d{2})\b/.exec(t)?.[1] ?? out.eventDate?.slice(0, 4) ?? 0);
    for (const [re, dateKey, timeKey] of [
      [/\b(?:event starts|it starts|night starts|show starts)\b([^.;]+)/i, 'eventDate', 'start'],
      [/\b(?:we arrive|we'll arrive|we will arrive|arrival is)\b([^.;]+)/i, 'arrivalDate', 'arrival'],
    ] as const) {
      const seg = re.exec(t)?.[1];
      if (!seg) continue;
      const date = year ? dateIn(seg, year) : null;
      const tm = new RegExp(TIME, 'i').exec(seg);
      if (date) out[dateKey] = date;
      if (tm) out[timeKey] = minutesOf(tm[1]!);
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
  const cutoff = term.minutes + (term.minutes < 720 && timing.start >= 720 ? 1440 : 0);
  return days * 1440 + timing.arrival! >= cutoff ? 'entry before midnight does not allow your arrival at or after the cutoff'.replace('midnight', term.minutes === 0 ? 'midnight' : `the stated time`) : null;
}

/** A deliberate shift to taste-based discovery clears the obsolete exact-artist target. */
export function similarMusicGoal(text: string): boolean {
  const t = flat(text);
  return /\b(?:music|pop|artist|concert|shows?)\b/i.test(t) && /\b(?:don't|do not|no longer) need\b[^.!?]{0,70}\bspecifically\b|\b(?:other|similar|different) (?:big )?(?:pop )?shows? instead\b/i.test(t);
}

export type CopiedAdmissionPolicy = {
  minimumAge: number | null;
  guardianRequired: boolean | null;
  acceptedId: string | null;
  sourceUrl: string | null;
  provenance: 'customer_supplied';
};

/** A quoted policy is usable conditional evidence, never proof we fetched or verified an event page. */
export function copiedAdmissionPolicy(text: string): CopiedAdmissionPolicy | null {
  const t = flat(text);
  if (!/\b(?:policy|terms|event page|organizer)\b[^.!?]{0,25}(?:says|states|reads|:)\s|\bvenue says\b/i.test(t)) return null;
  const noGuardian = /\bno (?:adult|guardian|parent) (?:is )?required\b|\b(?:minors?|1[0-7][- ]year[- ]olds?) (?:may|can|are allowed to) enter (?:unaccompanied|without (?:an? )?(?:adult|guardian|parent))\b/i.test(t);
  const guardian = /\b(?:must|have to) be accompanied by (?:an? )?(?:adult|guardian|parent)\b|\b(?:adult|guardian|parent) (?:is )?required\b/i.test(t);
  const minimum = /\b(?:ages? |aged? )?(1[0-9]|2[01])\s*\+|\bminimum age (?:is )?(\d{1,2})\b/i.exec(t);
  if (!noGuardian && !guardian && !minimum) return null;
  return { minimumAge: minimum ? Number(minimum[1] ?? minimum[2]) : null, guardianRequired: noGuardian ? false : guardian ? true : null, acceptedId: /\b((?:government[- ]issued|photo|student) ID)\b/i.exec(t)?.[1] ?? null, sourceUrl: /https:\/\/[^\s<>"']+/i.exec(t)?.[0] ?? null, provenance: 'customer_supplied' };
}

export function concertQuestion(messages: string[]): { lead: string; items: string[] } | null {
  const latest = flat(messages.at(-1) ?? '');
  const all = flat(messages.join(' '));
  const updatedAppearance = /\b(?:original artist|actual artist|artist (?:herself|himself)|(?:herself|himself)) (?:will|does) (?:appear|perform|attend)\b/i.test(latest);
  const absent = /\b(?:artist|[A-Z][a-z]+(?: [A-Z][a-z]+)*) (?:will not|won't|does not|doesn't) (?:appear|perform|attend)\b|\bnot (?:appearing|performing)\b/i.test(all);
  const party = /\b(?:DJ|tribute|listening|dance)\b[^.!?]{0,40}\b(?:party|show|recordings|tracks)\b|\btribute\b/i.test(all);
  if (party && !similarMusicGoal(latest) && /\b(?:DJ|tribute|listening|party|recordings|this|it|that)\b/i.test(latest) && /\b(?:buy|skip|see|perform)\b/i.test(latest)) {
    const wantsParty = /\b(?:only|just|now) want\b[^.!?]{0,50}\b(?:dance|party|recordings|tribute)\b/i.test(latest);
    if (wantsParty) return { lead: 'For your new goal, the party could fit: it is the DJ or tribute experience described, not an appearance by the original artist.', items: ['Based on the description you sent; I haven’t verified admission terms or availability.'] };
    if (updatedAppearance) return { lead: 'Based on the updated description you sent, the original artist will perform. That meets your artist-appearance goal, subject to those terms being accurate.', items: ['I haven’t independently verified the appearance, ticket entitlement or availability.'] };
    if (absent && /\b(?:herself|himself|themselves|actual artist|original artist|see .{1,40} live)\b/i.test(all)) return { lead: 'Skip it if you want to see the original artist perform. The description you sent says the artist will not appear.', items: ['This ticket buys the DJ, tribute or listening-party experience described, not a performance by that artist. I haven’t independently verified the listing.'] };
    if (/\b(?:herself|himself|original artist|actual artist)\b/i.test(latest)) return { lead: 'A tribute or listening party does not establish that the original artist will perform. Don’t buy it for that goal without an explicit artist appearance in the event terms.', items: ['Artist appearance is unverified from the description you sent.'] };
  }
  const minor = /\b(?:1[0-7][- ]year[- ]olds?|minors?|both 1[0-7]|aged? 1[0-7])\b/i.test(all);
  const alone = /\bunaccompanied\b|\bwithout (?:an? )?(?:adult|guardian|parent)\b/i.test(all);
  if (minor && alone && /\b(?:enter|admi\w*|policy|policies|guardian|adult|unaccompanied)\b/i.test(latest)) {
    const policy = copiedAdmissionPolicy(latest);
    const age = /\b(1[0-7])[- ]year[- ]old|\bboth (1[0-7])\b/i.exec(all);
    const youngest = age ? Number(age[1] ?? age[2]) : null;
    if (policy) {
      const ageFails = youngest !== null && policy.minimumAge !== null && youngest < policy.minimumAge;
      const lead = policy.guardianRequired === true || ageFails
        ? 'Based on the policy you pasted, they cannot attend unaccompanied under those terms.'
        : policy.guardianRequired === false && youngest !== null && policy.minimumAge !== null && youngest >= policy.minimumAge
          ? 'Based on the policy you pasted, their ages meet the minimum and no guardian is required.'
          : 'The policy you pasted does not establish all the age and guardian conditions needed to confirm unaccompanied admission.';
      return { lead, items: [policy.acceptedId ? `The supplied policy names ${policy.acceptedId}; confirm they each have an accepted form.` : 'Accepted ID is not established by the supplied policy.', 'I haven’t independently verified that this policy is current or applies to the exact event.'] };
    }

    return { lead: 'I haven’t verified any event-specific policy admitting them without an adult, so I can’t confirm that either can enter unaccompanied.', items: ['An age label such as “16+” or “all ages” alone does not verify the guardian or ID requirements. This does not mean the venue refuses minors.', 'Before buying, get the event organizer’s confirmation of unaccompanied admission for their ages, any guardian requirement and accepted ID. A policy you paste can be assessed as supplied terms; it is not an independently verified policy.'] };
  }
  return null;
}

/** Only a customer's explicitly named budget, never the first offer's price. */
export function concertBudget(text: string): { cents: number; basis: 'whole_party' | 'per_ticket' | null } | null {
  const t = flat(text);
  const m = /\b(?:budget|cap|up to|max(?:imum)?|no more than)\s*(?:is|of|to|stayed)?\s*\$([\d,]+(?:\.\d{2})?)([^.!?;]{0,35})/i.exec(t)
    ?? /\$([\d,]+(?:\.\d{2})?)\s*((?:(?:TOTAL|all-in|each|per ticket)\s+)?budget)\b/i.exec(t);
  if (!m) return null;
  const basis = /each|per ticket/i.test(m[2]!) ? 'per_ticket' : /total|pair|both|all-in/i.test(m[2]!) ? 'whole_party' : null;
  return { cents: Math.round(Number(m[1]!.replace(/,/g, '')) * 100), basis };
}
