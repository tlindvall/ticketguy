/**
 * "Every kind of event": a full-width navy band with the event types Ticket Guy routes running past like a
 * stadium ticker, three rows in alternating directions. Taken from the category routes
 * (src/lib/sources/routing.ts), leaving out the two marked optional expansion (theme parks, cinema). Every
 * name starts an email about that kind of event. Rows pause on hover; reduced motion shows them still and
 * wrapped.
 */
const ROWS: string[][] = [
  ['NFL', 'NBA', 'MLB', 'NHL', 'WNBA', 'MLS & NWSL', 'College football', 'March Madness', 'Bowl games', 'Minor league', 'High school'],
  ['Stadium tours', 'Arena shows', 'Club nights', 'Festivals', 'Electronic & nightlife', 'Broadway', 'Touring musicals', 'Orchestra & opera', 'Ballet & dance', 'Comedy'],
  ['UFC & boxing', 'WWE & AEW', 'NASCAR', 'IndyCar', 'Formula 1', 'Tennis', 'Golf', 'Rodeo & PBR', 'Family shows', 'Fairs', 'Fan expos', 'Las Vegas shows', 'Museums & attractions'],
];

export function EventTypes({ address }: { address: string }) {
  const mailto = (what: string) => `mailto:${address}?subject=${encodeURIComponent(`${what} tickets`)}&body=${encodeURIComponent('Event, date or link:\nHow many tickets:\nBudget:\n')}`;
  return (
    <section className="ticker" aria-labelledby="ticker-title">
      <div className="wrap ticker-head">
        <h2 id="ticker-title">Every kind of event.</h2>
        <p className="mono">Anywhere in the US.</p>
      </div>
      <div className="ticker-rows">
        {ROWS.map((row, i) => (
          <div key={i} className={`ticker-row${i % 2 ? ' is-rev' : ''}`}>
            {/* The row is listed twice so the loop is seamless; the copy is hidden from assistive tech. */}
            {[0, 1].map((copy) => (
              <ul key={copy} className="ticker-track" aria-hidden={copy === 1 ? true : undefined}>
                {row.map((item) => (
                  <li key={item}>
                    <a href={mailto(item)} tabIndex={copy === 1 ? -1 : undefined}>{item}</a>
                  </li>
                ))}
              </ul>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
