/**
 * "Your side of the ticket market": the principles behind a reply, and Ticket Guy at the centre of the ticket
 * sources it knows, in orbit. Lime marks the sources behind live price data; the rest are mapped (routing and
 * referral), which the legend says in words, so the diagram never reads as live comparison across all of them. Every name here
 * is in the source registry (research/ticket-guy-us-source-registry.json) or, for SeatData, the licensed
 * market-data feed (src/lib/market/seatdata.ts). Names are shown as plain text, not logos: they describe the
 * sellers we compare and link to, and imply no partnership (the note below says so).
 *
 * Pure CSS: each orbit turns slowly and its labels counter-turn to stay upright. Reduced motion holds it still.
 */
type Orbit = { r: number; seconds: number; reverse?: boolean; offset: number; names: string[]; tier: 'core' | 'mid' | 'outer' };

/** The sources behind live price data (SeatData's feed covers StubHub and Vivid Seats). Everything else is mapped. */
const LIVE = new Set(['SeatData', 'StubHub', 'Vivid Seats']);

const ORBITS: Orbit[] = [
  { r: 20, seconds: 140, offset: 10, tier: 'core', names: ['SeatData', 'Ticketmaster', 'StubHub', 'SeatGeek', 'Vivid Seats', 'AXS', 'TickPick', 'Gametime'] },
  { r: 30, seconds: 200, reverse: true, offset: 4, tier: 'mid', names: ['Ticket Evolution', 'TicketNetwork', 'TicketIQ', 'viagogo', 'SeatPick', 'TicketSmarter', 'Live Nation', 'Eventbrite', 'DICE', 'Etix', 'See Tickets', 'Tixr'] },
  { r: 40, seconds: 260, offset: 0, tier: 'outer', names: ['Resident Advisor', 'Fever', 'Telecharge', 'TodayTix', 'Broadway.com', 'Shotgun', 'TicketSwap', 'Tixel', 'NBA Tickets', 'NFL Tickets', 'MLB Tickets', 'NHL Tickets', 'GoFan', 'Posh'] },
];

export function SourceUniverse() {
  return (
    <section className="universe-section wrap" aria-labelledby="universe-title">
      <div className="universe-copy">
        <h2 id="universe-title">Your side of the ticket market.</h2>
        <ul className="principles">
          <li><strong>Your budget and plans drive the call.</strong> Not the seller, not the listing.</li>
          <li><strong>Commission never does.</strong> Some links pay us; they don’t change what we recommend.</li>
          <li><strong>If we’re not sure, we say so.</strong> Every reply says what we checked and what we couldn’t.</li>
        </ul>
        <p className="universe-how"><span className="how-label">How we know:</span> the listing you send, live resale price data from StubHub and Vivid Seats, and a map of 135 US ticket sellers, so we know where an event sells and can send you there.</p>
      </div>
      <div className="universe" role="img" aria-label={`Ticket Guy at the centre of the ticket sources it knows. Live price data: SeatData, covering StubHub and Vivid Seats. Mapped: ${ORBITS.flatMap((o) => o.names).filter((n) => !LIVE.has(n)).join(', ')}, and more.`}>
        {ORBITS.map((o, oi) => (
          <div key={oi} className={`orbit orbit-${o.tier}${o.reverse ? ' orbit-rev' : ''}`} style={{ '--r': `${o.r}cqw`, '--d': `${o.seconds}s` } as React.CSSProperties} aria-hidden="true">
            <span className="orbit-ring" />
            {o.names.map((n, i) => {
              const a = o.offset + (360 / o.names.length) * i;
              return (
                <span key={n} className="planet" style={{ '--a': `${a}deg` } as React.CSSProperties}>
                  <span className="planet-up">
                    <span className={`planet-pill${LIVE.has(n) ? ' is-core' : ''}`}>{n}</span>
                  </span>
                </span>
              );
            })}
          </div>
        ))}
        <span className="universe-dust" aria-hidden="true" />
        <div className="universe-core" aria-hidden="true">
          <svg className="universe-mark"><use href="#ticket-mark" /></svg>
          <span>ticket guy</span>
        </div>
      </div>
      {/* Phones: the orbits shrink to dots, so the names are listed here instead. */}
      <ul className="universe-list" aria-hidden="true">
        {ORBITS.flatMap((o) => o.names.map((n) => <li key={n} className={LIVE.has(n) ? 'is-core' : undefined}>{n}</li>))}
        <li className="is-more">+ 100 more</li>
      </ul>
      <p className="universe-legend"><span className="lg lg-live" aria-hidden="true" />Live price data <span className="lg" aria-hidden="true" />Mapped: we know where they sell and link you there</p>
      <p className="universe-note">Seller names are trademarks of their owners, shown to describe the sources we compare and link to. No partnership or endorsement is implied.</p>
    </section>
  );
}
