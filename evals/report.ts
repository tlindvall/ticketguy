/**
 * What a run's summary says, from eval-results.json alone: per-check pass rates, the change against the previous
 * run on the threads both scored, which threads newly fail or newly pass, and one history row for trend charts.
 * Pure functions; evals/report-failures.ts does the file and GitHub work.
 */
import { scoredThreads, threadPassed, type EvalResults, type ThreadResult } from './results';

export type Rate = { passed: number; judged: number };
export const pct = (r: Rate | undefined) => (r && r.judged ? (100 * r.passed) / r.judged : null);
const fmt = (v: number | null) => (v == null ? '–' : `${v.toFixed(1)}%`);

/** Pass rate of every check over the given threads (a check counts only where it applied). */
export function passRates(threads: ThreadResult[]): Map<string, Rate> {
  const out = new Map<string, Rate>();
  for (const t of threads) {
    for (const [name, c] of Object.entries(t.checks)) {
      if (c.pass == null) continue;
      const r = out.get(name) ?? out.set(name, { passed: 0, judged: 0 }).get(name)!;
      r.judged++;
      if (c.pass) r.passed++;
    }
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

export type Comparison = {
  common: number;
  rows: Array<{ check: string; now: number | null; before: number | null }>;
  newlyFailing: Array<{ id: string; checks: string[] }>;
  newlyPassing: Array<{ id: string; checks: string[] }>;
};

/** This run against the previous one, on the threads both scored, so a different suite or a new scenario doesn't move the numbers. */
export function compare(current: EvalResults, previous: EvalResults): Comparison {
  const prev = new Map(scoredThreads(previous).map((t) => [t.id, t]));
  const both = scoredThreads(current).filter((t) => prev.has(t.id));
  const now = passRates(both);
  const before = passRates(both.map((t) => prev.get(t.id)!));
  const checks = [...new Set([...now.keys(), ...before.keys()])].sort();
  const failing = (t: ThreadResult) => Object.entries(t.checks).filter(([, c]) => c.pass === false).map(([n]) => n);
  const newlyFailing: Comparison['newlyFailing'] = [];
  const newlyPassing: Comparison['newlyPassing'] = [];
  for (const t of both) {
    const p = prev.get(t.id)!;
    const a = threadPassed(p);
    const b = threadPassed(t);
    if (a === true && b === false) newlyFailing.push({ id: t.id, checks: failing(t) });
    if (a === false && b === true) newlyPassing.push({ id: t.id, checks: failing(p) });
  }
  return { common: both.length, rows: checks.map((check) => ({ check, now: pct(now.get(check)), before: pct(before.get(check)) })), newlyFailing, newlyPassing };
}

const delta = (now: number | null, before: number | null) => {
  if (now == null || before == null) return '';
  const d = now - before;
  return Math.abs(d) < 0.05 ? '0' : `${d > 0 ? '+' : ''}${d.toFixed(1)}`;
};

export function summaryMarkdown(r: EvalResults, opts: { previous?: EvalResults | null; previousUrl?: string | null; refusal?: string | null } = {}): string {
  const scored = scoredThreads(r);
  const rates = passRates(scored);
  const cmp = opts.previous ? compare(r, opts.previous) : null;
  const before = new Map(cmp?.rows.map((x) => [x.check, x]) ?? []);
  const passingThreads = scored.filter((t) => threadPassed(t) === true).length;
  const lines = [
    `### Conversation evals (${r.suite}) · \`${r.commit}\``,
    '',
    `${scored.length} of ${r.expected} threads scored · ${passingThreads} passed every check · ${r.provider.llmErrors} failed model call(s) · ${r.sentToBraintrust ? 'sent to Braintrust (one score per thread)' : 'nothing sent to Braintrust'}`,
    '',
  ];
  if (opts.refusal) lines.push(`> [!WARNING]`, `> ${opts.refusal}`, '');
  if (rates.size) lines.push(cmp ? '| check | pass rate | previous | change |' : '| check | pass rate |', cmp ? '|---|---:|---:|---:|' : '|---|---:|');
  for (const [check, rate] of rates) {
    const cell = `${fmt(pct(rate))} (${rate.passed}/${rate.judged})`;
    const b = before.get(check);
    lines.push(cmp ? `| ${check} | ${cell} | ${fmt(b?.before ?? null)} | ${delta(b?.now ?? null, b?.before ?? null)} |` : `| ${check} | ${cell} |`);
  }
  if (cmp && opts.previous) {
    const prevRef = opts.previousUrl ? `[the previous run](${opts.previousUrl})` : 'the previous run';
    lines.push('', `"previous" and "change" compare with ${prevRef} (\`${opts.previous.commit}\`, ${opts.previous.suite}) on the ${cmp.common} threads both scored; "pass rate" is over every thread in this run.`);
    const list = (xs: Comparison['newlyFailing'], label: string) => {
      lines.push('', `**${label} (${xs.length})**${xs.length ? '' : ': none'}`);
      for (const x of xs) lines.push(`- \`${x.id}\`${x.checks.length ? `: ${x.checks.join(', ')}` : ''}`);
    };
    list(cmp.newlyFailing, 'Newly failing');
    list(cmp.newlyPassing, 'Newly passing');
  } else {
    lines.push('', '_No previous run to compare with._');
  }
  const errored = r.threads.filter((t) => t.error);
  if (errored.length) {
    lines.push('', `**Threads that did not run (${errored.length})**`);
    for (const t of errored) lines.push(`- \`${t.id}\`: ${t.error!.replace(/\n/g, ' ').slice(0, 200)}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------- history.csv ----------
const FIXED = ['date', 'commit', 'suite', 'threads'];
const parseRow = (line: string) => line.split(',');

/** history.csv with one more row for this run. A check new to this run adds a column; older rows leave it empty. */
export function appendHistory(existing: string | null, r: EvalResults): string {
  const rows = (existing ?? '').split('\n').filter((l) => l.trim());
  const header = rows.length ? parseRow(rows[0]!) : FIXED;
  const old = rows.slice(1).map((l) => Object.fromEntries(parseRow(l).map((v, i) => [header[i]!, v])));
  const rates = passRates(scoredThreads(r));
  const checks = [...new Set([...header.filter((h) => !FIXED.includes(h)), ...rates.keys()])].sort();
  const cols = [...FIXED, ...checks];
  const row: Record<string, string> = { date: r.createdAt, commit: r.commit, suite: r.suite, threads: String(scoredThreads(r).length) };
  for (const [c, rate] of rates) row[c] = pct(rate)!.toFixed(1);
  const clean = (v: string | undefined) => (v ?? '').replace(/[,\n]/g, ' ');
  return `${[cols.join(','), ...[...old, row].map((o) => cols.map((c) => clean(o[c])).join(','))].join('\n')}\n`;
}
