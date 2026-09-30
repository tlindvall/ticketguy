import { z } from 'zod';

/**
 * Reading the listing a customer shows us (a screenshot, or listing text they pasted) into what it actually
 * displays. A screenshot is evidence of what the page showed when they captured it: not proof that the seats
 * are still for sale, that the price is current, or that the listing is genuine. Anything the page didn't
 * show stays null; nothing is inferred or filled in.
 */

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
  })
  .strict();
export type ListingRead = z.infer<typeof LISTING_SCHEMA>;

/** What we store and use: the read, in cents, with the per-ticket price worked out only when the page makes it certain. */
export type ListingFields = {
  seller: string | null;
  eventName: string | null;
  eventDate: string | null;
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
};

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
    venue: r.venue,
    city: r.city,
    quantity: q,
    priceText: r.priceText,
    perTicketCents: perTicket,
    wholePartyCents: whole,
    priceBasis: r.priceBasis,
    feeBasis: r.feeBasis,
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
  };
}

/** Whether the read is a listing we can use: a listing or checkout page, nothing sensitive, and a price or seats on it. */
export function usableListing(r: ListingRead): boolean {
  if (r.sensitiveContent || r.kind === 'payment_or_id' || r.kind === 'purchased_ticket' || r.kind === 'unrelated') return false;
  return r.priceDollars !== null || r.totalDollars !== null || r.section !== null;
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
