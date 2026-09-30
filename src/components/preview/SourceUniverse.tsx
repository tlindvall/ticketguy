/**
 * "The whole ticket market": Ticket Guy at the centre, the ticket sources it knows in orbit. Every name here
 * is in the source registry (research/ticket-guy-us-source-registry.json) or, for SeatData, the licensed
 * market-data feed (src/lib/market/seatdata.ts). Names are shown as plain text, not logos: they describe the
 * sellers we compare and link to, and imply no partnership (the note below says so).
 *
 * Pure CSS: each orbit turns slowly and its labels counter-turn to stay upright. Reduced motion holds it still.
 */
type Orbit = { r: number; seconds: number; reverse?: boolean; offset: number; names: string[]; tier: 'core' | 'mid' | 'outer' };

const ORBITS: Orbit[] = [
  { r: 20, seconds: 140, offset: 10, tier: 'core', names: ['SeatData', 'Ticketmaster', 'StubHub', 'SeatGeek', 'Vivid Seats', 'AXS', 'TickPick', 'Gametime'] },
  { r: 30, seconds: 200, reverse: true, offset: 4, tier: 'mid', names: ['Ticket Evolution', 'TicketNetwork', 'TicketIQ', 'viagogo', 'SeatPick', 'TicketSmarter', 'Live Nation', 'Eventbrite', 'DICE', 'Etix', 'See Tickets', 'Tixr'] },
  { r: 40, seconds: 260, offset: 0, tier: 'outer', names: ['Resident Advisor', 'Fever', 'Telecharge', 'TodayTix', 'Broadway.com', 'Shotgun', 'TicketSwap', 'Tixel', 'NBA Tickets', 'NFL Tickets', 'MLB Tickets', 'NHL Tickets', 'GoFan', 'Posh'] },
];

export function SourceUniverse() {
  return (
    <section className="universe-section wrap" aria-labelledby="universe-title">
      <div className="universe-copy">
        <h2 id="universe-title">One guy. The whole ticket market.</h2>
        <p>Ticket Guy knows the US ticket market, from the big resale marketplaces to the box office. It reads the listing you send from any of them, checks prices against live resale market data, and points you to the right seller.</p>
        <dl className="universe-stats">
          <div><dt>Ticket sources mapped</dt><dd>135</dd></div>
          <div><dt>Event categories</dt><dd>29</dd></div>
          <div><dt>Coverage</dt><dd>All 50 states</dd></div>
        </dl>
      </div>
      <div className="universe" role="img" aria-label={`Ticket Guy at the centre of the ticket sources it knows, including ${ORBITS.flatMap((o) => o.names).join(', ')}, and more.`}>
        {ORBITS.map((o, oi) => (
          <div key={oi} className={`orbit orbit-${o.tier}${o.reverse ? ' orbit-rev' : ''}`} style={{ '--r': `${o.r}cqw`, '--d': `${o.seconds}s` } as React.CSSProperties} aria-hidden="true">
            <span className="orbit-ring" />
            {o.names.map((n, i) => {
              const a = o.offset + (360 / o.names.length) * i;
              return (
                <span key={n} className="planet" style={{ '--a': `${a}deg` } as React.CSSProperties}>
                  <span className="planet-up">
                    <span className={`planet-pill${o.tier === 'core' ? ' is-core' : ''}`}>{n}</span>
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
        {ORBITS.flatMap((o) => o.names.map((n) => <li key={n} className={o.tier === 'core' ? 'is-core' : undefined}>{n}</li>))}
        <li className="is-more">+ 100 more</li>
      </ul>
      <p className="universe-note">Seller names are trademarks of their owners, shown to describe the sources we compare and link to. No partnership or endorsement is implied.</p>
    </section>
  );
}
