import Link from 'next/link';

/**
 * The public home while the concierge is not yet answering strangers. It is also the page partner
 * programmes are shown, so it says plainly what the service is and is not: a comparison and referral
 * service that sends buyers to the seller, never a marketplace. Nothing here collects data, and no
 * seller, league or venue is named as a partner.
 */
export function ComingSoon({ address, categories, markets }: { address: string; categories: string[]; markets: string[] }) {
  const year = new Date().getUTCFullYear();
  const market = markets.join(' & ') || 'the US';
  return (
    <main className="min-h-screen bg-gray-950 text-gray-100">
      <div className="relative overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-48 h-[560px] bg-[radial-gradient(ellipse_at_top,rgba(45,212,191,0.20),transparent_65%)]" />
        <header className="relative mx-auto flex max-w-6xl items-center justify-between px-4 py-6 sm:px-6">
          <span className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <TicketMark />
            Ticket Guy
          </span>
          <span className="rounded-full border border-teal-400/40 bg-teal-400/10 px-3 py-1 text-xs font-medium text-teal-300">Coming soon</span>
        </header>

        <section className="relative mx-auto grid max-w-6xl gap-12 px-4 pb-20 pt-8 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:pb-28 lg:pt-16">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-teal-300">Launching first in {market}</p>
            <h1 className="mt-4 text-4xl font-bold leading-[1.05] tracking-tight text-white sm:text-6xl">
              A ticket guy
              <br />
              you can trust.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-gray-300">
              Tell us the game, the show or the concert. We check the sellers, compare what you&rsquo;d really pay, fees included, and point you straight to the best ticket. You buy direct from the seller.
            </p>
            {categories.length ? (
              <ul className="mt-8 flex flex-wrap gap-2" aria-label="Launching with">
                {categories.map((c) => (
                  <li key={c} className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-sm text-gray-200">
                    {c}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="mt-8 text-sm text-gray-400">We&rsquo;re putting the finishing touches on it. Opening to everyone soon.</p>
          </div>
          <ExampleThread />
        </section>
      </div>

      <section className="border-t border-white/5 bg-gray-900/60">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">How it will work</h2>
          <ol className="mt-10 grid gap-6 sm:grid-cols-3">
            <Step n={1} title="Send one email">
              A link, a screenshot or a sentence: &ldquo;Four together for the Knicks on Saturday, around $600.&rdquo; No app, no account.
            </Step>
            <Step n={2} title="We check the sellers">
              The official seller first, then the marketplaces we&rsquo;re permitted to check. Every price is compared on the total you&rsquo;d pay.
            </Step>
            <Step n={3} title="You buy direct">
              We send you the best option with a link to that exact listing. You buy from the seller, on the seller&rsquo;s site.
            </Step>
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">What you can count on</h2>
        <div className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2">
          <Pledge title="The real price, not the teaser">Totals include the fees the seller shows. If a fee or tax isn&rsquo;t known, we say so instead of guessing.</Pledge>
          <Pledge title="We send you to the seller">We never buy, hold, mark up or resell tickets. We&rsquo;re a second opinion, not a middleman.</Pledge>
          <Pledge title="A person checks every answer">Recommendations are reviewed by a human before they&rsquo;re sent to you.</Pledge>
          <Pledge title="No spam">Asking about tickets never signs you up for anything. Offers only if you ask for them.</Pledge>
        </div>
      </section>

      <section className="border-t border-white/5 bg-gray-900/60">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-20 sm:px-6 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-teal-300">For partners</p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight text-white sm:text-3xl">We send buyers to you.</h2>
          </div>
          <div className="space-y-4 text-gray-300">
            <p>
              Ticket Guy is a comparison and referral service for US live events, not a marketplace. Buyers tell us what they want to see; we match it to the exact event and send them to the official seller or a licensed resale marketplace, linked to that listing.
            </p>
            <p>
              We never buy, hold or resell inventory. We show a price only as the seller presents it, and every purchase happens on the seller&rsquo;s own site.
            </p>
            <p>
              Partnership enquiries:{' '}
              <a className="font-medium text-teal-300 underline decoration-teal-300/40 underline-offset-4 hover:decoration-teal-300" href={`mailto:${address}?subject=${encodeURIComponent('Partnership enquiry')}`}>
                {address}
              </a>
            </p>
          </div>
        </div>
      </section>

      <footer className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-10 text-sm text-gray-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <span>&copy; {year} Ticket Guy</span>
        <nav className="flex gap-6">
          <Link className="hover:text-gray-300" href="/how-it-works">How it works</Link>
          <Link className="hover:text-gray-300" href="/privacy">Privacy</Link>
          <Link className="hover:text-gray-300" href="/terms">Terms</Link>
        </nav>
      </footer>
    </main>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="rounded-2xl border border-white/10 bg-gray-950/60 p-6">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-teal-400/15 text-sm font-semibold text-teal-300">{n}</span>
      <h3 className="mt-4 text-lg font-semibold text-white">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-gray-400">{children}</p>
    </li>
  );
}

function Pledge({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <span aria-hidden className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-teal-400/15">
        <svg viewBox="0 0 20 20" className="h-3 w-3 fill-none stroke-teal-300" strokeWidth="3"><path d="M4 10.5l4 4 8-9" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
      <div>
        <h3 className="font-semibold text-white">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-gray-400">{children}</p>
      </div>
    </div>
  );
}

/** An illustrative exchange, labelled as such: the figures are an example, not a quote. */
function ExampleThread() {
  return (
    <figure className="relative rounded-2xl border border-white/10 bg-gray-900/80 p-5 shadow-2xl shadow-teal-950/40 backdrop-blur sm:p-6">
      <figcaption className="absolute right-4 top-4 rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-gray-400">Example</figcaption>
      <div className="space-y-4">
        <div className="max-w-[85%]">
          <p className="text-xs text-gray-500">You</p>
          <p className="mt-1 rounded-2xl rounded-tl-sm bg-white/10 px-4 py-3 text-sm text-gray-100">Two seats together for the Rangers on Friday. Around $300 all-in?</p>
        </div>
        <div className="ml-auto max-w-[90%]">
          <p className="text-right text-xs text-teal-300/80">Ticket Guy</p>
          <div className="mt-1 rounded-2xl rounded-tr-sm bg-teal-400/10 px-4 py-3 text-sm text-gray-100 ring-1 ring-teal-400/20">
            <p>Found it: Rangers vs. Devils, Friday 7:00&nbsp;PM at Madison Square Garden.</p>
            <p className="mt-2">Best pair that fits: Section 212, Row 8, <strong className="text-white">$284 total</strong> with fees.</p>
            <span className="mt-3 inline-flex items-center gap-1 rounded-md bg-teal-400 px-3 py-1.5 text-xs font-semibold text-gray-950">Open the seller&rsquo;s listing &rarr;</span>
          </div>
        </div>
      </div>
    </figure>
  );
}

function TicketMark() {
  return (
    <svg aria-hidden viewBox="0 0 32 32" className="h-7 w-7">
      <path d="M5 9a2 2 0 0 1 2-2h18a2 2 0 0 1 2 2v3a3 3 0 0 0 0 6v3a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-3a3 3 0 0 0 0-6z" className="fill-teal-400" />
      <path d="M19 9.5v13" className="stroke-gray-950" strokeWidth="1.5" strokeDasharray="2 2" />
    </svg>
  );
}
