import { z } from 'zod';

/**
 * Reading the listing a customer shows us (a screenshot, or listing text they pasted) into what it actually
 * displays. A screenshot is evidence of what the page showed when they captured it: not proof that the seats
 * are still for sale, that the price is current, or that the listing is genuine. Anything the page didn't
 * show stays null; nothing is inferred or filled in.
 */

const LISTING_TYPE = z.enum(['resale', 'primary', 'unknown']);
const ADMISSION = z.enum(['standing', 'seated', 'unknown']);
/** One priced row on a results page: its own name, price and labels, as shown. */
const SHOWN_OFFER = z
  .object({
    /** The row's own name as shown: "GA Ticket Price Tier 2: While Supplies Last", "Balcony: Standing Room Only". */
    label: z.string().max(120),
    priceDollars: z.number().positive().max(100000).nullable(),
    priceBasis: z.enum(['per_ticket', 'whole_party', 'unknown']),
    feeBasis: z.enum(['all_in', 'before_fees', 'unknown']),
    listingType: LISTING_TYPE,
    admission: ADMISSION,
  })
  .strict();

/** What the model returns. Prices are the page's own numbers in dollars, converted to cents on our side. */
export const LISTING_SCHEMA = z
  .object({
    kind: z.enum(['ticket_listing', 'checkout', 'purchased_ticket', 'payment_or_id', 'unrelated']),
    /** A scannable barcode or QR code, a payment card number, an ID or a membership card is visible. */
    sensitiveContent: z.boolean(),
    seller: z.string().nullable(),
    eventName: z.string().nullable(),
    /** The event's date as YYYY-MM-DD, only when the page shows the date itself. */
    eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    /** The start time as the page shows it, 24-hour local HH:MM ("7:00 PM EDT" → 19:00). Which performance it is. */
    eventTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().default(null),
    venue: z.string().nullable(),
    city: z.string().nullable(),
    quantity: z.number().int().positive().max(40).nullable(),
    /** The price as the page shows it, e.g. "$245 ea incl. fees". */
    priceText: z.string().nullable(),
    priceDollars: z.number().positive().max(100000).nullable(),
    priceBasis: z.enum(['per_ticket', 'whole_party', 'unknown']),
    feeBasis: z.enum(['all_in', 'before_fees', 'unknown']),
    /** A total the page shows for the whole order, when it shows one. */
    totalDollars: z.number().positive().max(400000).nullable(),
    section: z.string().nullable(),
    row: z.string().nullable(),
    seatNumbers: z.array(z.string()).max(40).nullable(),
    /** True only when the page says the seats are together; false when it says they aren't; null otherwise. */
    seatsTogether: z.boolean().nullable(),
    /** Restrictions or notes the page shows, in its words: "limited view", "wheelchair accessible", "21+". */
    restrictions: z.array(z.string().max(120)).max(12),
    /** Delivery as the page describes it, e.g. "Mobile transfer, delivered by Oct 3". */
    deliveryText: z.string().nullable(),
    /** The date tickets will be delivered by, as YYYY-MM-DD, only when the page states one. */
    deliveryBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    /** Extras the listing claims come with the tickets: parking, lounge access, merchandise. */
    includedBenefits: z.array(z.string().max(120)).max(12),
    confidence: z.enum(['high', 'medium', 'low']),
    /** What couldn't be read, briefly: "price cut off", "row blurred". */
    unreadable: z.array(z.string().max(120)).max(8),
    /** "Verified Resale Ticket" is resale and "Standard Ticket" is the seller's own (primary) stock, as the page labels it. */
    listingType: LISTING_TYPE.nullable().default(null),
    /** Standing room or general admission (no assigned seat), or assigned seats, as the page says. */
    admission: ADMISSION.nullable().default(null),
    /** True when the page says its prices are before taxes ("Prices include fees (before taxes)"). */
    beforeTaxes: z.boolean().nullable().default(null),
    /** Doors and show times when the page states them separately ("Doors: 8PM Show: 9PM"), 24-hour HH:MM. */
    doorsTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().default(null),
    showTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().default(null),
    /** Every priced row a results page shows, one entry each and never merged (live Oct 2: three rows became "Balcony; General Admission Floor"). Empty for a single listing. */
    offers: z.array(SHOWN_OFFER).max(12).default([]),
  })
  .strict();
/** The read as given: `eventTime` may be absent in reads made before it existed. */
export type ListingRead = z.input<typeof LISTING_SCHEMA>;

/** What we store and use: the read, in cents, with the per-ticket price worked out only when the page makes it certain. */
export type ListingFields = {
  seller: string | null;
  eventName: string | null;
  eventDate: string | null;
  /** 24-hour local start time the page shows ("19:00"): the performance, when a day has more than one. */
  eventTime?: string | null;
  venue: string | null;
  city: string | null;
  quantity: number | null;
  priceText: string | null;
  /** Per ticket, in cents: the page's per-ticket price, or its total divided by the quantity it shows. */
  perTicketCents: number | null;
  /** Whole order, in cents: the page's total, or the per-ticket price times the quantity it shows. */
  wholePartyCents: number | null;
  /** How the price was worded: per_ticket, whole_party, or unknown (read as per ticket, and said so). */
  priceBasis: 'per_ticket' | 'whole_party' | 'unknown';
  feeBasis: 'all_in' | 'before_fees' | 'unknown';
  section: string | null;
  row: string | null;
  seatNumbers: string[] | null;
  seatsTogether: boolean | null;
  restrictions: string[];
  /** Restriction codes the comparison engine understands, from the page's own words. */
  restrictionCodes: string[];
  deliveryText: string | null;
  deliveryBy: string | null;
  includedBenefits: string[];
  unreadable: string[];
  /** Resale or the seller's own stock, as the page labels it; null when it doesn't say (reads made before this existed). */
  listingType?: 'resale' | 'primary' | 'unknown' | null;
  admission?: 'standing' | 'seated' | 'unknown' | null;
  beforeTaxes?: boolean | null;
  doorsTime?: string | null;
  showTime?: string | null;
  /** Each priced row a results page showed, in cents; the fields above describe one of them once a row is chosen. */
  offers?: ShownOffer[];
  /** Why that row: the area they asked for ("floor"), or null when it is just the cheapest shown. */
  chosenFor?: string | null;
};

export type ShownOffer = { label: string; perTicketCents: number | null; priceBasis: 'per_ticket' | 'whole_party' | 'unknown'; feeBasis: 'all_in' | 'before_fees' | 'unknown'; listingType: 'resale' | 'primary' | 'unknown'; admission: 'standing' | 'seated' | 'unknown' };

const cents = (d: number | null) => (d == null ? null : Math.round(d * 100));

/** The page's words mapped onto the codes the comparison understands; anything else stays as text only. */
export function restrictionCodesFrom(restrictions: string[]): string[] {
  const codes = new Set<string>();
  for (const r of restrictions) {
    // "not wheelchair accessible", "no companion seats": a negation is not the restriction (post-#54 QA, R3-B08).
    const m = /\b(wheelchair|accessible|accessibility|ada|companion)\b/i.exec(r);
    if (m && !/\b(?:no|not|non|neither|nor|isn't|aren't|without)\b[\s\w-]{0,20}$/i.test(r.slice(0, m.index).replace(/[’‘]/g, "'"))) codes.add('accessible_seating');
    if (/\b(obstructed|limited|partial|restricted)\s+view\b|\bside view\b|\bview (is )?(obstructed|limited)\b/i.test(r)) codes.add('obstructed_view');
    if (/\bparking\b/i.test(r) && /\bonly\b/i.test(r)) codes.add('parking_only');
    if (/\b(vip|hospitality|package)\b/i.test(r)) codes.add('vip_package');
  }
  return [...codes];
}

export function fieldsFromRead(r: ListingRead): ListingFields {
  const price = cents(r.priceDollars);
  const total = cents(r.totalDollars);
  const q = r.quantity;
  let perTicket: number | null = null;
  let whole: number | null = total;
  if (price !== null && r.priceBasis === 'per_ticket') perTicket = price;
  else if (price !== null && r.priceBasis === 'whole_party') {
    whole ??= price;
    perTicket = q ? Math.round(price / q) : null;
  } else if (price !== null) perTicket = price; // unknown wording: read as per ticket, and the reply says so
  if (perTicket === null && total !== null && q) perTicket = Math.round(total / q);
  if (whole === null && perTicket !== null && q && r.priceBasis === 'per_ticket') whole = perTicket * q;
  return {
    seller: r.seller,
    eventName: r.eventName,
    eventDate: r.eventDate,
    eventTime: r.eventTime ?? null,
    venue: r.venue,
    city: r.city,
    quantity: q,
    priceText: r.priceText,
    perTicketCents: perTicket,
    wholePartyCents: whole,
    priceBasis: r.priceBasis,
    // "$72 each + $48 per order = $264": a per-ticket price below the total's share can't itself include the fees,
    // whatever the read said (live A11: the $72 base was called all-in beside a $264 total for three).
    feeBasis: r.feeBasis === 'all_in' && perTicket !== null && whole !== null && q && whole > perTicket * q + 50 ? 'before_fees' : r.feeBasis,
    section: r.section,
    row: r.row,
    seatNumbers: r.seatNumbers?.length ? r.seatNumbers : null,
    seatsTogether: r.seatsTogether,
    restrictions: r.restrictions,
    restrictionCodes: restrictionCodesFrom(r.restrictions),
    deliveryText: r.deliveryText,
    deliveryBy: r.deliveryBy,
    includedBenefits: r.includedBenefits,
    unreadable: r.unreadable,
    listingType: r.listingType ?? null,
    admission: r.admission ?? (standingWords([r.section, ...r.restrictions]) ? 'standing' : null),
    beforeTaxes: r.beforeTaxes ?? null,
    doorsTime: r.doorsTime ?? null,
    showTime: r.showTime ?? null,
    offers: (r.offers ?? []).map((o) => ({ label: o.label, perTicketCents: o.priceBasis === 'whole_party' && q ? Math.round(o.priceDollars! * 100 / q) : cents(o.priceDollars), priceBasis: o.priceBasis, feeBasis: o.feeBasis, listingType: o.listingType, admission: o.admission === 'unknown' && standingWords([o.label]) ? 'standing' : o.admission })),
  };
}

/** "Standing Room Only", "General Admission", "GA Floor": no assigned seat to number or sit together in. */
export function standingWords(xs: Array<string | null | undefined>): boolean {
  return xs.some((x) => !!x && /\b(?:standing(?: room)?(?: only)?|general admission|GA(?: floor| pit| ticket)?|SRO)\b/i.test(x) && !/\breserved\b/i.test(x));
}

/** The area words a buyer and a page share. "GA" and "general admission" are the floor unless the row names another area. */
// Not "lower", "upper" or "box": "a lower price" and "box office" aren't areas.
const AREAS = ['floor', 'pit', 'balcony', 'mezzanine', 'orchestra', 'loge', 'lawn', 'terrace'] as const;
export function areaOf(label: string): string | null {
  const l = label.toLowerCase();
  const named = AREAS.find((w) => new RegExp(`\\b${w}\\b`).test(l));
  if (named) return named === 'pit' ? 'floor' : named;
  return /\b(?:ga|general admission)\b/.test(l) ? 'floor' : null;
}

/**
 * One row of a results page, chosen for the buyer: the cheapest in the area they asked for ("we'd rather be on the
 * floor"), or the cheapest shown when they named none, or the row whose price they quote. The read's fields then
 * describe that row, and the other rows stay listed. A screenshot is what the page showed, not stock held.
 */
export function chooseShownOffer<T extends ListingFields>(f: T, wanted: string, quotedCents: number | null = null): T {
  const rows = (f.offers ?? []).filter((o) => o.perTicketCents !== null);
  const said = wanted.toLowerCase();
  const area = AREAS.find((w) => new RegExp(`\\b${w}\\b`).test(said)) ?? (/\b(?:ga|general admission)\b/.test(said) ? 'floor' : null);
  const want = area === 'pit' ? 'floor' : area;
  if (!rows.length) {
    // An older read that ran rows together ("Balcony; General Admission Floor"): the part in their area, when one is.
    const parts = (f.section ?? '').split(/\s*;\s*/).filter(Boolean);
    const mine = want && parts.length > 1 ? parts.find((x) => areaOf(x) === want) : undefined;
    return mine ? { ...f, section: mine } : f;
  }
  const byQuote = quotedCents !== null ? rows.find((o) => o.perTicketCents === quotedCents) : undefined;
  const inArea = want ? rows.filter((o) => areaOf(o.label) === want) : [];
  const pick = byQuote ?? (inArea.length ? inArea : rows).slice().sort((x, y) => x.perTicketCents! - y.perTicketCents!)[0]!;
  const q = f.quantity;
  return {
    ...f,
    section: pick.label,
    row: null,
    seatNumbers: null,
    priceText: null,
    perTicketCents: pick.perTicketCents,
    wholePartyCents: q ? pick.perTicketCents! * q : null,
    priceBasis: pick.priceBasis === 'whole_party' ? 'per_ticket' : pick.priceBasis,
    feeBasis: pick.feeBasis === 'unknown' ? f.feeBasis : pick.feeBasis,
    listingType: pick.listingType,
    admission: pick.admission,
    seatsTogether: pick.admission === 'standing' ? null : f.seatsTogether,
    offers: f.offers,
    chosenFor: want && areaOf(pick.label) === want ? want : null,
  };
}

/** Whether the read is a listing we can use: a listing or checkout page, nothing sensitive, and a price or seats on it. */
export function usableListing(r: ListingRead): boolean {
  if (r.sensitiveContent || r.kind === 'payment_or_id' || r.kind === 'purchased_ticket' || r.kind === 'unrelated') return false;
  return r.priceDollars !== null || r.totalDollars !== null || r.section !== null || (r.offers ?? []).some((o) => o.priceDollars !== null);
}

/**
 * Pasted text that reads like a listing: a price next to a section, row or seat, and something that says it's a
 * listing they found (a marketplace, "found", "listing", "this one"). "Row 1 preferred, budget $300" is a request.
 */
export function looksLikeListingText(text: string): boolean {
  if (!/\$\s?\d/.test(text) || !/\b(sec(tion)?|row|seats?)\s*[:#]?\s*[a-z0-9]/i.test(text)) return false;
  if (!/\b(stubhub|ticketmaster|seatgeek|vivid|gametime|tickpick|axs|listing|listed|found|seeing|this one|these|checkout|ea\b|each)\b/i.test(text)) return false;
  return !/\b(budget|up to|no more than|max(imum)?|under)\s*\$/i.test(text) || /\b(listing|listed|found|seeing|stubhub|vivid|seatgeek|ticketmaster)\b/i.test(text);
}

export type ListingImage = { mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; base64: string };

export interface ListingReader {
  readonly name: string;
  /** Reads one screenshot, or listing text when no image is given. Throws ModelOutputError like the extractor. */
  read(input: { image?: ListingImage | null; text?: string | null; receivedAt: Date }): Promise<ListingRead>;
}

/** Fixture mode reads nothing: a screenshot is stored and acknowledged, never guessed at. */
export class NullListingReader implements ListingReader {
  readonly name = 'none';
  async read(): Promise<ListingRead> {
    return { kind: 'unrelated', sensitiveContent: false, seller: null, eventName: null, eventDate: null, venue: null, city: null, quantity: null, priceText: null, priceDollars: null, priceBasis: 'unknown', feeBasis: 'unknown', totalDollars: null, section: null, row: null, seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'low', unreadable: [] };
  }
}
