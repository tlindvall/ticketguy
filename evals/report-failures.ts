export {};

/**
 * Turns one eval run into GitHub issues, grouped by check (scorer): one open issue per failing check, labelled
 * eval-failure, listing every failing thread with its reason and one transcript. Re-runs update the same issue
 * (found by its <!-- eval-key --> marker) instead of opening duplicates; a check that passes everywhere closes its
 * issue with a comment. Run after `pnpm eval` in CI:
 *
 *   EVAL_EXPERIMENT_NAME=... tsx evals/report-failures.ts
 *
 * Needs BRAINTRUST_API_KEY, GITHUB_TOKEN (issues: write) and GITHUB_REPOSITORY. Nothing here changes code.
 */
const BT = 'https://api.braintrust.dev/v1';
const PROJECT = process.env.BRAINTRUST_PROJECT ?? 'My Project';
const experimentName = process.env.EVAL_EXPERIMENT_NAME;
const repo = process.env.GITHUB_REPOSITORY;
const gh = process.env.GITHUB_TOKEN;
const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
if (!experimentName || !repo || !gh || !process.env.BRAINTRUST_API_KEY) throw new Error('needs EVAL_EXPERIMENT_NAME, GITHUB_REPOSITORY, GITHUB_TOKEN, BRAINTRUST_API_KEY');

/** Checks worth an issue. answered_the_question only counts outright "no" verdicts; the rest any failure. */
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
  price_alert_set: 'Price alert not set up',
  price_alert_raised: 'Price alert not raised when the price drops',
  answered_the_question: 'Answers a different question',
  only_what_was_asked: "Says things the customer didn't ask for",
  thread_coherence: 'Long thread loses coherence',
  sim_customer_satisfied: 'Simulated customer gives up',
};

async function bt<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BT}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${process.env.BRAINTRUST_API_KEY}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  // Large results come back as a 303 to a presigned URL that must be fetched without our auth header.
  if (res.status >= 300 && res.status < 400) return (await fetch(res.headers.get('location')!)).json() as Promise<T>;
  if (!res.ok) throw new Error(`braintrust ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}
async function github<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, { method: init.method ?? 'GET', headers: { Authorization: `Bearer ${gh}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: init.body ? JSON.stringify(init.body) : undefined });
  if (!res.ok) throw new Error(`github ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

type Ev = { span_id: string; root_span_id: string; is_root?: boolean; metadata?: Record<string, unknown>; scores?: Record<string, number | null> | null; span_attributes?: { type?: string; name?: string }; output?: unknown };
type Fail = { scenario: string; why: string };

const projects = await bt<{ objects: Array<{ id: string; name: string }> }>(`/project?project_name=${encodeURIComponent(PROJECT)}`);
const projectId = projects.objects[0]?.id;
const exps = await bt<{ objects: Array<{ id: string }> }>(`/experiment?project_id=${projectId}&experiment_name=${encodeURIComponent(experimentName)}`);
const expId = exps.objects[0]?.id;
if (!expId) throw new Error(`experiment ${experimentName} not found`);
const events: Ev[] = [];
let cursor: string | undefined;
do {
  const page = await bt<{ events: Ev[]; cursor?: string }>(`/experiment/${expId}/fetch`, { limit: 200, ...(cursor ? { cursor } : {}) });
  events.push(...page.events);
  cursor = page.events.length ? page.cursor : undefined;
} while (cursor);

const roots = new Map(events.filter((e) => e.is_root).map((e) => [e.root_span_id, e]));
const fails = new Map<string, Fail[]>();
const evaluated = new Set<string>();
for (const e of events) {
  if (e.span_attributes?.type !== 'score' || !e.scores) continue;
  const scenario = String(roots.get(e.root_span_id)?.metadata?.id ?? '?');
  for (const [name, score] of Object.entries(e.scores)) {
    if (!(name in TRACKED) || score == null) continue;
    evaluated.add(name);
    const m = (e.metadata ?? {}) as { failures?: Array<{ step?: number; why?: string }>; reasons?: Array<{ step: number; verdict: string; reason: string }>; summary?: string; broke_at_step?: number; reason?: string };
    let why: string | null = null;
    if (name === 'answered_the_question') {
      const no = (m.reasons ?? []).filter((r) => r.verdict === 'no');
      if (no.length) why = no.map((r) => `step ${r.step}: ${r.reason}`).join(' · ');
    } else if (score < 1) {
      why = m.failures?.length ? m.failures.map((f) => `step ${f.step}: ${f.why}`).join(' · ') : m.summary ? `broke at step ${m.broke_at_step}: ${m.summary}` : (m.reason ?? `score ${score}`);
    }
    if (why) (fails.get(name) ?? fails.set(name, []).get(name)!).push({ scenario, why: why.slice(0, 400) });
  }
}

/** Six steps of the thread, ending at the first step the failure names ("step 8: …"), so a late failure is shown. */
const transcript = (scenario: string, why = '') => {
  const root = [...roots.values()].find((r) => r.metadata?.id === scenario);
  const steps = (root?.output as Array<{ step: number; customer: string; reply: string }> | undefined) ?? [];
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
const stamp = `${experimentName}${runUrl ? ` ([run](${runUrl}))` : ''}`;

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
  const body = `${keyOf(name)}
**Check:** \`${name}\` — ${TRACKED[name]}
**Failing in ${list.length} thread(s)** as of ${stamp}. This issue is updated by every scheduled eval run.

| Scenario | Why |
|---|---|
${list.map((f) => `| \`${f.scenario}\` | ${f.why.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`).join('\n')}

### Example: \`${list[0]!.scenario}\`
${transcript(list[0]!.scenario, list[0]!.why)}

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
