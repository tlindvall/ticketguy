import { flat } from './text-offers';

/**
 * Decision questions that need no event match (Research 1, R1-A02): what a cover and a per-person minimum come
 * to, whether a lottery can be the plan, and whether a small child needs their own admission. Each is answered
 * from the customer's own facts and any rule they supplied, before any catalog search or event intake.
 *
 * Three kinds of question, not three venues: a rule is read from what they sent (its summary and its link)
 * and said back as theirs, with its status ("you supplied it; I haven't checked it here"). Without one, the
 * answer says what the decision depends on and asks only for the detail that settles it. Nothing here is
 * verified stock, a live policy check, a purchase or a reservation.
 *
 * Returns null unless one kind is clearly being asked, so ordinary requests keep their own paths.
 */

export type DecisionAnswer = { lead: string; items: string[]; nextStep: string | null; kind: 'minimum_spend' | 'lottery' | 'child_admission'; facts: { quantity: number | null; showName: string | null } };

const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const WORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const N = '(one|two|three|four|five|six|seven|eight|nine|ten|\\d{1,2})';
const toN = (w: string) => NUM[w.toLowerCase()] ?? Number(w);
const word = (n: number) => WORD[n] ?? String(n);
const cents = (s: string) => Math.round(Number(s.replace(/,/g, '')) * 100);
const usd = (c: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: c % 100 ? 2 : 0, minimumFractionDigits: c % 100 ? 2 : 0 }).format(c / 100);
const sentencesOf = (t: string) => t.split(/(?<=[.!?])\s+(?=[A-Z"(])/).map((x) => x.trim()).filter(Boolean);
const URL_RE = /\bhttps?:\/\/[^\s)<>"']+[^\s)<>"'.,;:!?]/i;

/** A rule they supplied: the sentence that cites a source ("The FAQ (https://…) says …"), and its link. */
type SuppliedRule = { text: string; url: string | null };
function suppliedRules(messages: string[]): SuppliedRule[] {
  const out: SuppliedRule[] = [];
  for (const m of messages) for (const s of sentencesOf(flat(m))) {
    const url = URL_RE.exec(s)?.[0] ?? null;
    if (url || /\b(?:policy|rules?|terms|FAQ|website|site)\b[^.]{0,40}\b(?:says?|states?|lists?)\b/i.test(s)) out.push({ text: s, url });
  }
  return out;
}
const ruleWith = (rules: SuppliedRule[], re: RegExp) => rules.find((r) => re.test(r.text)) ?? null;
const source = (r: SuppliedRule | null, noun: string) => {
  if (!r) return null;
  const many = /s$/.test(noun);
  return r.url ? `Here ${many ? 'are' : 'is'} the ${noun} you sent: ${r.url}. I haven’t checked ${many ? 'them' : 'it'} myself in this reply.` : `That’s from the ${noun} you described; I haven’t checked ${many ? 'them' : 'it'} myself in this reply.`;
};

/** Whole-party cap, latest wins: "our cap is $240", "$100 total cap", "total budget is $100". */
function capCents(messages: string[]): number | null {
  let cap: number | null = null;
  for (const m of messages) {
    const t = flat(m);
    const all = [...t.matchAll(/\b(?:cap|budget|limit|max(?:imum)?)\b(?:\s+(?:is|of|stays|now|still|at))*\s*\$\s?(\d[\d,]*(?:\.\d{2})?)|\$\s?(\d[\d,]*(?:\.\d{2})?)\s+(?:(?:total|all[- ]in|whole[- ]night|overall)\s+)?(?:cap|budget|limit)\b/gi)];
    if (all.length) cap = cents((all.at(-1)![1] ?? all.at(-1)![2])!);
  }
  return cap;
}

function partySize(messages: string[]): number | null {
  let n: number | null = null;
  for (const m of messages) {
    const t = flat(m);
    const x = new RegExp(`\\b${N}\\s+of\\s+us\\b|\\b(?:we are|we're)\\s+${N}\\b|\\b${N}\\s+(?:people|adults|guests)\\b`, 'i').exec(t);
    if (x) n = toN((x[1] ?? x[2] ?? x[3])!);
    else if (/\b(?:both of us|the two of us|my (?:wife|husband|partner|girlfriend|boyfriend) and I)\b/i.test(t)) n = 2;
  }
  return n;
}

// ── 1. A cover and a per-person minimum ────────────────────────────────────────────────────────────────

function minimumSpend(messages: string[]): DecisionAnswer | null {
  const all = flat(messages.join(' '));
  // "The cover is $24 each", "keep the $24 cover", never their question "does $48 cover the night?".
  const coverM = [...all.matchAll(/\bcover(?:\s+charge)?(?:\s+(?:is|of|was))?\s*\$\s?(\d[\d,]*(?:\.\d{2})?)(\s*(?:each|per person|a head|pp|total|for both))?|\$\s?(\d[\d,]*(?:\.\d{2})?)\s+cover(?:\s+charge)?\b(?!\s+(?:the|our|us|it|everything|both)\b)(\s*(?:each|per person|total|for both))?/gi)].at(-1);
  if (!coverM) return null;
  const latest = flat(messages.at(-1) ?? '');
  const items = [...all.matchAll(new RegExp(`\\b${N}\\s+\\$\\s?(\\d[\\d,]*(?:\\.\\d{2})?)\\s+(?:qualifying\\s+|menu\\s+)?items?\\s+(?:each|per person|apiece)\\b|\\b${N}\\s+(?:qualifying\\s+)?items?\\s+(?:each|per person)\\s+(?:at|for)\\s+\\$\\s?(\\d[\\d,]*(?:\\.\\d{2})?)`, 'gi'))].at(-1);
  const asks = /\b(?:cover the night|whole night|alcohol|have to drink|must (?:we )?drink|minimum|items?|total|fit|enough)\b/i.test(latest);
  if (!asks && !items) return null;
  const party = partySize(messages) ?? 1;
  const cover = cents((coverM[1] ?? coverM[3])!);
  const perPersonCover = !/\btotal\b|\bfor both\b/i.test(coverM[2] ?? coverM[4] ?? '');
  const coverTotal = perPersonCover ? cover * party : cover;
  const cap = capCents(messages);
  const rules = suppliedRules(messages);
  const minRule = ruleWith(rules, new RegExp(`\\b${N}[- ](?:item|drink)\\s+minimum\\b|\\b${N}\\s+(?:qualifying\\s+)?(?:items?|drinks?)\\s+(?:per person|each|minimum)\\b`, 'i'));
  const minN = minRule ? toN(new RegExp(`\\b${N}[- ]?(?:\\s+qualifying)?\\s*(?:item|drink)`, 'i').exec(minRule.text)?.[1] ?? '0') : null;
  const softOk = minRule ? /\b(?:food|non-alcoholic|soft drinks?|mocktails?)\b[^.]{0,50}\b(?:counts?|allowed|qualif\w*|okay|ok|fine)\b|\b(?:counts?|allowed)\b[^.]{0,30}\b(?:food|non-alcoholic)\b/i.test(minRule.text) : false;
  const who = party === 2 ? 'the two of you' : party === 1 ? 'you' : `the ${word(party)} of you`;

  if (items) {
    const count = toN((items[1] ?? items[3])!);
    const price = cents((items[2] ?? items[4])!);
    const itemsTotal = count * price * party;
    const total = coverTotal + itemsTotal;
    const allCharges = /\b(?:charges?|tips?|gratuity)\b[^.]{0,30}\bincluded\b|\bincluding (?:all )?(?:item )?(?:charges|tax(?:es)?) and tips?\b|\bwith (?:all )?(?:item )?charges and tips? included\b/i.test(all);
    const room = cap === null ? '' : total < cap ? `, ${usd(cap - total)} under your cap` : total === cap ? ', exactly your cap' : `, ${usd(total - cap)} over your ${usd(cap)} cap`;
    return {
      kind: 'minimum_spend',
      lead: `With your supplied prices, that’s ${usd(total)} total${room}.`,
      items: [
        `${usd(coverTotal)} cover + ${word(count * party)} ${usd(price)} items = ${usd(total)}.`,
        allCharges ? 'That assumes the item prices include every charge and tip, as you said; they aren’t verified menu prices.' : 'Any tax, charges or tip on the items would come on top; these aren’t verified menu prices.',
      ],
      nextStep: null,
      facts: { quantity: party, showName: null },
    };
  }
  const ruleLine = minRule && minN
    ? `The rule you supplied says ${word(minN)} qualifying ${minN === 1 ? 'item' : 'items'} per person${softOk ? ', and food or non-alcoholic drinks count, so it isn’t a requirement to drink alcohol' : ''}.`
    : 'Food and drink are extra, and clubs like this often have a per-person minimum. Whether there is one, and whether it has to be alcohol, is the venue’s rule, usually on its reservation or policy page.';
  return {
    kind: 'minimum_spend',
    lead: `${usd(coverTotal)} covers entry for ${who}, not the whole night.`,
    items: [ruleLine, ...(minRule ? [source(minRule, 'policy')!] : [])],
    nextStep: `Send me the prices of what you’d order, with any charges and tip, and I’ll check the night against your ${cap !== null ? `${usd(cap)} cap` : 'budget'}.`,
    facts: { quantity: party, showName: null },
  };
}

// ── 2. A lottery as the plan ───────────────────────────────────────────────────────────────────────────

function lottery(messages: string[]): DecisionAnswer | null {
  const all = flat(messages.join(' '));
  if (!/\blotter(?:y|ies)\b/i.test(all)) return null;
  const latest = flat(messages.at(-1) ?? '');
  // The lottery has to be an option they're weighing, not one they ruled out ("no lottery-only offers").
  const weighed = messages.some((m) => sentencesOf(flat(m)).some((x) => /\blotter(?:y|ies)\b/i.test(x) && !/\b(?:no|not|without|never|avoid)\b[^.]{0,30}\blotter|\blottery[- ]only\b/i.test(x) && (/\?/.test(x) || /\b(?:could|can|might|should|plan to|want to)\s+(?:enter|try|do)\b|\bguarantee\w*|count (?:it )?(?:on|as)\b/i.test(x))));
  if (!weighed) return null;
  if (!/\?|\b(?:guarantee\w*|count on|rely|plan|safer|change|won|selected)\b/i.test(latest)) return null;
  let won: boolean | null = null;
  for (const m of messages) {
    const t = flat(m);
    if (/\b(?:we|I)\s+(?:didn'?t|did not|have not|haven'?t)\s+(?:win|won|been selected)\b|\b(?:we|I)\s+lost\b/i.test(t)) won = false;
    else if (/\b(?:we|I)\s+(?:won|were selected|was selected|got (?:picked|selected))\b/i.test(t)) won = true;
  }
  const together = /\b(?:must|need to|have to)\s+sit\s+together\b|\bseats?\s+together\b[^.]{0,20}\b(?:must|required|need)\b|\bmust be (?:together|adjacent)\b/i.test(all);
  const cap = capCents(messages);
  const lotteryPrice = /\blottery\b[^.$]{0,30}\$\s?(\d[\d,]*(?:\.\d{2})?)/i.exec(all);
  // The options they named beside the lottery, each with its own words: a pair "adjacent", "for $220 total".
  const options = [...all.matchAll(/\b((?:a|an|the)\s+(?:guaranteed\s+)?(?:[a-z-]+\s+){0,3}?(?:pair|seats|tickets|alternative|option|block))\b[^.,;$]{0,30}?\$\s?(\d[\d,]*(?:\.\d{2})?)(\s*(?:total|for both|for the pair|each|per (?:ticket|seat)))?/gi)]
    .filter((x) => !/\blottery\b/i.test(x[1]!))
    .map((x) => ({ name: x[1]!.replace(/^(?:a|an|the)\s+/i, ''), cents: cents(x[2]!), each: /each|per/i.test(x[3] ?? ''), adjacent: /\b(?:adjacent|together|pair)\b/i.test(x[1]!) }));
  const rules = suppliedRules(messages);
  const terms = ruleWith(rules, /\blotter(?:y|ies)\b|\bterms\b/i);
  const notTogether = !!terms && /\b(?:adjacent|together|side[- ]by[- ]side)\b[^.]{0,30}\bnot guaranteed\b|\bnot guaranteed\b[^.]{0,30}\b(?:adjacent|together)\b/i.test(terms.text);
  const fitting = options.filter((o) => (!together || o.adjacent) && (cap === null || (o.each ? o.cents * 2 : o.cents) <= cap)).sort((a, b) => a.cents - b.cents)[0] ?? null;
  const unfit = options.filter((o) => o !== fitting && together && !o.adjacent);
  const fitLine = fitting
    ? `The ${fitting.name} you quoted ${together ? 'meets your sit-together requirement' : 'is a sure way in'} at ${usd(fitting.each ? fitting.cents * 2 : fitting.cents)} total${cap !== null ? `, leaving ${usd(cap - (fitting.each ? fitting.cents * 2 : fitting.cents))} of your ${usd(cap)}` : ''}.`
    : null;
  const unfitLine = unfit.length ? `The ${unfit.map((o) => o.name).join(' and the ')} ${unfit.length === 1 ? 'isn’t' : 'aren’t'} described as seats together, so ${unfit.length === 1 ? 'it doesn’t' : 'they don’t'} meet your must-sit-together requirement.` : null;
  const basis = 'Based only on the facts you supplied; I haven’t checked availability.';
  if (won) {
    return {
      kind: 'lottery',
      lead: notTogether ? 'Winning lets you buy, but the terms you supplied still don’t guarantee seats together.' : 'Winning lets you buy, but I can’t tell from what you’ve sent whether those seats would be together.',
      items: [
        ...(terms ? [source(terms, 'lottery terms')!] : []),
        together ? `Since sitting together is a must, ${lotteryPrice ? `the lottery seats (${usd(cents(lotteryPrice[1]!))} each) are only the plan if the seller confirms they’re together.` : 'the lottery seats are only the plan if the seller confirms they’re together.'}${fitLine ? ` Otherwise: ${fitLine.charAt(0).toLowerCase()}${fitLine.slice(1)}` : ''}` : fitLine ?? 'Check the seats offered before you pay.',
        basis,
      ],
      nextStep: null,
      facts: { quantity: together ? 2 : null, showName: null },
    };
  }
  return {
    kind: 'lottery',
    lead: 'I wouldn’t count the lottery as your guaranteed plan.',
    items: [
      `Before the draw, a lottery is a chance to buy, not a ticket.${notTogether ? ' The terms you supplied also say adjacent seats aren’t guaranteed even if you win.' : ''}`,
      ...(terms ? [source(terms, 'lottery terms')!] : []),
      ...(fitLine ? [`${fitLine}${won === null ? ' For a one-night visit, that’s the safer plan.' : ''}`] : []),
      ...(unfitLine ? [unfitLine] : []),
      basis,
    ],
    nextStep: null,
    facts: { quantity: together ? 2 : null, showName: null },
  };
}

// ── 3. A small child's admission ───────────────────────────────────────────────────────────────────────

function childAdmission(messages: string[]): DecisionAnswer | null {
  let months: number | null = null;
  for (const m of messages) {
    const t = flat(m);
    const mo = /\b(\d{1,2})[- ]?months?[- ]?old\b|\b(\d{1,2})\s+months\b/i.exec(t);
    const yr = /\b(\d|one|two|three|four)[- ]?(?:years?|yrs?)[- ]?old\b/i.exec(t);
    if (mo) months = Number(mo[1] ?? mo[2]);
    else if (yr && /\b(?:toddler|baby|child|kid|daughter|son)\b/i.test(t)) months = toN(yr[1]!) * 12;
  }
  if (months === null || months > 60) return null;
  const all = flat(messages.join(' '));
  const latest = flat(messages.at(-1) ?? '');
  const asks = /\b(?:tickets?|admissions?|lap|seat)\b[^.]{0,40}\?|\bor\s+(?:two|three|four|\d)\b[^.]{0,10}\?|\b(?:correction|update|actually|will be)\b/i.test(latest);
  if (!asks) return null;
  const adultsM = new RegExp(`\\b${N}\\s+adults?\\b`, 'i').exec(all);
  const adults = adultsM ? toN(adultsM[1]!) : 2;
  const rules = suppliedRules(messages);
  const rule = ruleWith(rules, /\b(?:under|age|ages|older|lap|children|kids)\b/i);
  const thresholdYears = rule ? toN(/\b(?:children|kids|guests)\s+(\d|one|two|three)\s*(?:years?\s*)?(?:and (?:older|over|up)|\+|or older)\b|\bunder\s+(\d|one|two|three)\b/i.exec(rule.text)?.slice(1).find(Boolean) ?? '2') : 2;
  const arenaException = rule ? /\b(?:some |certain )?(?:arenas?|venues?|buildings?)\b[^.]{0,40}\b(?:require|need)s?\b[^.]{0,30}\b(?:every|all|any)\s+ages?\b/i.test(rule.text) : false;
  const showName = /\b(?:want|see|going to|tickets? (?:to|for))\s+((?:[A-Z][\w'’&-]*|On|on|of|the)(?:\s+(?:[A-Z][\w'’&-]*|On|on|of|the))*?)\s+in\s+[A-Z]/.exec(all)?.[1] ?? null;
  const age = `${months} months`;
  const src = rule ? source(rule, 'FAQ') : null;
  const under = months < thresholdYears * 12;
  if (under) {
    return {
      kind: 'child_admission',
      lead: rule
        ? `At ${age}, the general rule you supplied may allow a lap child${arenaException ? ', but the arena can require a ticket at every age' : ''}.`
        : `At ${age}, many family shows let a child sit on a lap without a ticket, but the arena’s rule decides.`,
      items: [
        ...(src ? [src] : []),
        `If a lap is allowed, ${word(adults)} tickets cover your family; if the arena requires one at every age, you need ${word(adults + 1)}.`,
      ],
      nextStep: 'Which arena and performance are you looking at? That settles it.',
      facts: { quantity: null, showName },
    };
  }
  return {
    kind: 'child_admission',
    lead: rule
      ? `At ${age}, the general rule you supplied calls for a separate child ticket: ${word(adults + 1)} admissions for your family.`
      : `At ${age}, most family shows require a child’s own ticket: ${word(adults + 1)} admissions for your family.`,
    items: [...(src ? [src] : []), 'The exact performance’s seating and pricing still need checking, and it doesn’t mean a child discount.'],
    nextStep: null,
    facts: { quantity: adults + 1, showName },
  };
}

/** The answer to their decision question, or null when this isn't one. */
export function decisionAnswer(messages: string[]): DecisionAnswer | null {
  if (!messages.length) return null;
  if (/\b(?:offer|option|listing)\s+(?:[A-E]|[1-5])\b/i.test(messages.map(flat).join(' '))) return null;
  return lottery(messages) ?? childAdmission(messages) ?? minimumSpend(messages);
}
