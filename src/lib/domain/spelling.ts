import { spellWeekdays } from './dates';

/**
 * The words the request readers key on, spelled right before any of them reads the text (live Oct 19: "when is the nest
 * home game for the giants?" missed "next", so two games were offered back as "which game?"). People type fast on
 * phones; a rule that only matches the dictionary spelling fails them one word at a time, so the fix is here, once,
 * for every reader: weekdays, "next" before a game word, and the request words below.
 */

/** "next" mistyped, fixed only before a word that says what comes next, so "a bird's nest" and "nest egg" stay. */
const NEXT_TYPO = /\b(?:nest|nxt|nex|enxt|nexy|nedt|mext|bext|netx|nwxt|necy|nesxt|ntext|nezt)\b(?=\s+(?:home|away|game|games|match|show|one|week|weekend|month|time|concert|fixture|gig|event|date|season|few)\b)/gi;
/** "home" mistyped before a game word ("hoem game", "hme games"). */
const HOME_TYPO = /\b(?:hoem|hom|hme|homw|hoe)\b(?=\s+(?:game|games|match|opener|stand)\b)/gi;
/** Slang and misspellings more than one keystroke off, as the word they mean. */
const KNOWN: Record<string, string> = { tix: 'tickets', tkts: 'tickets', tickts: 'tickets', tonite: 'tonight', tmrw: 'tomorrow', tmr: 'tomorrow', tomorow: 'tomorrow', tommorow: 'tomorrow', tommorrow: 'tomorrow', togther: 'together', wkend: 'weekend', cheapist: 'cheapest' };
/** Words six letters or longer that the readers rely on; anything one keystroke off, with the same first letter, is read as the word. */
const VOCABULARY = ['tickets', 'ticket', 'tonight', 'tomorrow', 'weekend', 'together', 'cheapest', 'cheaper', 'upcoming', 'against', 'section', 'available', 'schedule', 'playing'];
/** Real words one keystroke from a vocabulary word, never "corrected" ("paying" is not "playing"). */
const REAL = new Set(['paying', 'praying', 'player', 'players', 'section', 'sections', 'tickle', 'tickled', 'tonight', 'cheaters', 'cheater', 'agains', 'schedules']);

function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

const keepCase = (word: string, fix: string) => (word[0] === word[0]!.toUpperCase() ? fix[0]!.toUpperCase() + fix.slice(1) : fix);

/** The text with those words spelled right; everything else, including links, untouched by the caller. */
export function spellCommon(text: string): string {
  return spellWeekdays(text)
    .replace(NEXT_TYPO, (w) => keepCase(w, 'next'))
    .replace(HOME_TYPO, (w) => keepCase(w, 'home'))
    .replace(/\b[a-z]{3,12}\b/gi, (word) => {
      const w = word.toLowerCase();
      if (KNOWN[w]) return keepCase(word, KNOWN[w]);
      if (w.length < 6 || REAL.has(w) || VOCABULARY.includes(w)) return word;
      const fix = VOCABULARY.find((v) => v[0] === w[0] && oneEditApart(w, v));
      return fix ? keepCase(word, fix) : word;
    });
}
