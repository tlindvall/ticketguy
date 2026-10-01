/**
 * The /sources page: what each kind of information is (market data, the listing you send, mapped sellers and
 * official routes), and Ticket Guy at the centre of the ticket sources it knows, in orbit. Lime marks the sources behind live price data; the rest are mapped (routing and
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
    <section className="universe-section sources-page wrap" aria-labelledby="universe-title">
      <div className="universe-copy">
        <h1 id="universe-title">Where our information comes from.</h1>
        <dl className="sources-kinds">
          <div><dt><span className="lg lg-live" aria-hidden="true" />Market data</dt><dd>Asking prices and their history from StubHub and Vivid Seats, through SeatData. Market context: not verified listings, and not a partnership.</dd></div>
          <div><dt><span className="lg lg-sent" aria-hidden="true" />The listing you send</dt><dd>What your link or screenshot says: section, row, price, fees shown and delivery. We tell you it comes from the listing.</dd></div>
          <div><dt><span className="lg" aria-hidden="true" />Sellers and official booking pages</dt><dd>135 US ticket sellers and official routes, mapped so we know where an event sells and can point you there. Not integrated listings; some links may earn us a commission.</dd></div>
        </dl>
      </div>
      <div className="universe" role="img" aria-label={`Ticket Guy at the centre of the ticket sources it knows. Market data: SeatData, covering StubHub and Vivid Seats asking prices. Mapped: ${ORBITS.flatMap((o) => o.names).filter((n) => !LIVE.has(n)).join(', ')}, and more.`}>
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
      <p className="universe-legend"><span className="lg lg-live" aria-hidden="true" />Market data <span className="lg" aria-hidden="true" />Mapped seller or booking route</p>
      <p className="universe-note">Seller names are trademarks of their owners, shown to describe the sources we compare and link to. No partnership or endorsement is implied.</p>
    </section>
  );
}
