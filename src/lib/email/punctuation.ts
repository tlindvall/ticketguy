/**
 * No em or en dashes in anything a customer reads (owner's house style). Templates are written without them;
 * this is the backstop for text we don't write ourselves: event and venue names from Ticketmaster, staff-edited
 * templates and signatures, and model-drafted prose.
 *
 * A range ("$80–$120", "9am–9pm", "Oct 1–3") reads "to"; an en dash joining two words ("Wilkes–Barre") is a hyphen; a sign-off dash at the start of a line is dropped;
 * any other dash is a clause break and becomes a comma. Safe on HTML: dashes never appear in markup.
 */
export function noDashes(s: string): string {
  return s
    .replace(/&mdash;|&#8212;|&#x2014;/gi, '—')
    .replace(/&ndash;|&#8211;|&#x2013;/gi, '–')
    .replace(/([0-9](?:\s?[ap]\.?m\.?)?)\s*–\s*(?=[$0-9])/gi, '$1 to ')
    .replace(/([A-Za-z])–(?=[A-Za-z])/g, '$1-')
    .replace(/(^|\n|<(?:p|div|li|td|span)\b[^>]*>)[ \t]*[—–][ \t]*/g, '$1')
    .replace(/[ \t]*[—–][ \t]*/g, ', ')
    .replace(/, ([.,;:!?)])/g, '$1');
}
