import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { appendHistory, summaryMarkdown } from './report';
import { readResults, scoredThreads } from './results';
import { providerCountsRefusal } from './run-health';

/**
 * Reports one eval run from eval-results.json (written by evals/ticketguy.eval.ts); nothing is read from Braintrust.
 * Run after `pnpm eval` in CI:
 *
 *   tsx evals/report-failures.ts
 *
 * Always: a markdown summary (pass rate per check, the change against the previous run, newly failing and newly
 * passing threads) to $GITHUB_STEP_SUMMARY and summary.md (posted on PRs).
 * When the run can be trusted: one row appended to evals/history.csv.
 * With EVAL_FILE_ISSUES=1 and a trusted run: GitHub issues grouped by check, one open issue per failing check,
 * labelled eval-failure, listing every failing thread with its reason and one transcript. Re-runs update the same
 * issue (found by its <!-- eval-key --> marker); a check that passes everywhere closes its issue.
 *
 * Env: EVAL_RESULTS_FILE (eval-results.json), EVAL_PREVIOUS_RESULTS (prev/eval-results.json),
 * EVAL_PREVIOUS_RUN_URL, EVAL_HISTORY_FILE (evals/history.csv), EVAL_SUMMARY_FILE (summary.md); GITHUB_TOKEN and
 * GITHUB_REPOSITORY for issues. Writes healthy=true|false to $GITHUB_OUTPUT. Nothing here changes code.
 */
const repo = process.env.GITHUB_REPOSITORY;
const gh = process.env.GITHUB_TOKEN;
const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
const resultsFile = process.env.EVAL_RESULTS_FILE ?? 'eval-results.json';
const historyFile = process.env.EVAL_HISTORY_FILE ?? 'evals/history.csv';
const summaryFile = process.env.EVAL_SUMMARY_FILE ?? 'summary.md';
const fileIssues = process.env.EVAL_FILE_ISSUES === '1';

/** Checks worth an issue. */
const TRACKED: Record<string, string> = {
  event_correct: 'Wrong or no event resolved',
  party_size_kept: 'Party size not kept',
  budget_kept: 'Budget not kept',
  memory_across_thread: 'Forgets what the customer established',
  no_repeated_reply: 'Repeats the previous reply',
  no_reasked_question: 'Re-asks something already answered',
  together_claims_true: '"Seats together" claimed for a split listing',
  prices_grounded: 'States a price not in the data',
  links_grounded: 'Links somewhere not in the data',
  one_email_per_message: 'More than one email per customer message',
  at_most_one_question: 'Asks more than one question',
  asks_one_question: 'Ambiguous request not answered with one question',
  no_new_recommendation: 'Closing message re-sends a recommendation',
  not_parked_for_staff: 'Parked for staff ("couldn\'t finish automatically")',
  got_a_reply: 'No email produced',
  mentions_required: 'Leaves out what the answer needed',
  forbidden_absent: 'Says something it must not',
  email_design: 'Email design missing',
  no_coverage_talk: 'Says "haven’t been able to check" or "Nothing I can check automatically"',
  price_alert_set: 'Price alert not set up',
  price_alert_raised: 'Price alert not raised when the price drops',
  answered_the_question: 'Answers a different question',
  only_what_was_asked: "Says things the customer didn't ask for",
  thread_coherence: 'Long thread loses coherence',
  sim_customer_satisfied: 'Simulated customer gives up',
};

const setOutput = (k: string, v: string) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
const publish = (md: string) => {
  writeFileSync(summaryFile, md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(md);
};
/** A run we can't trust files and closes nothing, and adds no history row: a GitHub error annotation, and the job fails. */
function refuse(title: string, msg: string): never {
  setOutput('healthy', 'false');
  console.log(`::error title=${title}::${msg}`);
  console.error(msg);
  process.exit(1);
}

const results = readResults(resultsFile);
if (!results) {
  publish(`### Conversation evals\n\n> [!WARNING]\n> No results: ${resultsFile} is missing or unreadable (the eval run failed before writing it).\n`);
  refuse('Eval results missing', `${resultsFile} is missing or unreadable, so no issues were filed or closed. Re-run the workflow.`);
}
const label = `${results.suite} run at ${results.commit}`;
const scored = scoredThreads(results).length;
const notRun = results.threads.filter((t) => t.error).length;
// A missing thread would read as a passing one and close its issue; a partial run decides nothing.
const partial = scored === 0 || scored < results.expected ? `${label} scored ${scored} of ${results.expected} threads (${notRun} did not run). The results are partial, so no issues were filed or closed and no history row was added.` : null;
// A run whose model calls failed scores the outage: unanswered threads and unscored judges would file issues that
// aren't real and close ones that are.
const providerRefusal = providerCountsRefusal(results.provider, label);
const refusal = providerRefusal ?? partial;

const previous = process.env.EVAL_PREVIOUS_RESULTS ? readResults(process.env.EVAL_PREVIOUS_RESULTS) : null;
publish(summaryMarkdown(results, { previous, previousUrl: process.env.EVAL_PREVIOUS_RUN_URL || null, refusal }));

if (providerRefusal) refuse('Provider errors', providerRefusal);
if (partial) refuse('Eval results missing', partial);
setOutput('healthy', 'true');

writeFileSync(historyFile, appendHistory(existsSync(historyFile) ? readFileSync(historyFile, 'utf8') : null, results));
console.log(`${scored}/${results.expected} threads scored; history row added to ${historyFile}`);

if (!fileIssues) process.exit(0);
if (!repo || !gh) throw new Error('filing issues needs GITHUB_REPOSITORY and GITHUB_TOKEN');

async function github<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, { method: init.method ?? 'GET', headers: { Authorization: `Bearer ${gh}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: init.body ? JSON.stringify(init.body) : undefined });
  if (!res.ok) throw new Error(`github ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

type Fail = { scenario: string; why: string };
const fails = new Map<string, Fail[]>();
const evaluated = new Set<string>();
for (const t of scoredThreads(results)) {
  for (const [name, c] of Object.entries(t.checks)) {
    if (!(name in TRACKED) || c.pass == null) continue;
    evaluated.add(name);
    // Real customer threads (prod/…) arrive redacted (evals/results.ts): their id and failing steps, never their words.
    if (!c.pass) (fails.get(name) ?? fails.set(name, []).get(name)!).push({ scenario: t.id, why: (c.reason ?? 'failed').slice(0, 400) });
  }
}

/** Six steps of the thread, ending at the first step the failure names ("step 8: …"), so a late failure is shown. */
const transcript = (scenario: string, why = '') => {
  const steps = results.threads.find((t) => t.id === scenario)?.transcript ?? [];
  const failing = Number(/\bstep (\d+)/.exec(why)?.[1] ?? 0);
  const end = Math.max(6, steps.findIndex((s) => s.step === failing) + 1);
  return steps
    .slice(end - 6, end)
    .map((s) => `**Customer (${s.step}):** ${s.customer}\n\n**Ticket Guy (${s.step}):**\n\`\`\`\n${(s.reply || '(no email)').replace(/\n+Ticket Guy\n[\s\S]*?AI-assisted[^\n]*/g, '').slice(0, 1200)}\n\`\`\``)
    .join('\n\n');
};

type Issue = { number: number; state: string; body: string | null; title: string };
const existing: Issue[] = [];
for (let page = 1; page < 10; page++) {
  const batch = await github<Issue[]>(`/issues?labels=eval-failure&state=all&per_page=100&page=${page}`);
  existing.push(...batch);
  if (batch.length < 100) break;
}
const keyOf = (name: string) => `<!-- eval-key: ${name} -->`;
const stamp = `${label}${runUrl ? ` ([run](${runUrl}))` : ''}`;

for (const name of evaluated) {
  const list = fails.get(name) ?? [];
  const issue = existing.find((i) => i.body?.includes(keyOf(name)));
  if (!list.length) {
    if (issue && issue.state === 'open') {
      await github(`/issues/${issue.number}/comments`, { method: 'POST', body: { body: `Passing in every thread as of ${stamp}. Closing; it reopens automatically if it fails again.` } });
      await github(`/issues/${issue.number}`, { method: 'PATCH', body: { state: 'closed' } });
      console.log(`closed #${issue.number} (${name})`);
    }
    continue;
  }
  const example = list.find((f) => !f.scenario.startsWith('prod/'));
  const body = `${keyOf(name)}
**Check:** \`${name}\` — ${TRACKED[name]}
**Failing in ${list.length} thread(s)** as of ${stamp}. This issue is updated by every scheduled eval run.

| Scenario | Why |
|---|---|
${list.map((f) => `| \`${f.scenario}\` | ${f.why.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`).join('\n')}

${example ? `### Example: \`${example.scenario}\`\n${transcript(example.scenario, example.why)}` : '_All failures are in real customer threads; replay them locally with the production-threads file and EVAL_THREADS_KEY._'}

**Reproduce:** \`EVAL_SUITE=nightly EVAL_ONLY=${[...new Set(list.map((f) => f.scenario))].slice(0, 6).join(',')} pnpm eval\`
**Passes when:** \`${name}\` passes in every thread (this issue closes itself on the first run where it does).

---
Filed by \`evals/report-failures.ts\`. Per AGENTS.md: fix the product, never the check; show the before/after eval table in the PR.`;
  const title = `[eval] ${TRACKED[name]} (${list.length} thread${list.length === 1 ? '' : 's'})`;
  if (issue) {
    await github(`/issues/${issue.number}`, { method: 'PATCH', body: { title, body, state: 'open' } });
    console.log(`updated #${issue.number} (${name}, ${list.length})`);
  } else {
    const created = await github<{ number: number }>(`/issues`, { method: 'POST', body: { title, body, labels: ['eval-failure'] } });
    console.log(`opened #${created.number} (${name}, ${list.length})`);
  }
}
