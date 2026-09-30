/**
 * "Every kind of ticket": the event types Ticket Guy routes, grouped the way people think about going out.
 * Taken from the category routes (src/lib/sources/routing.ts), leaving out the two marked optional
 * expansion (theme parks, cinema). Each chip starts an email about that kind of event. Beside it, what a
 * reply checks, limited to checks the pipeline actually runs.
 */
type Group = { title: string; tone: 'cream' | 'navy' | 'lime' | 'gray'; items: string[] };

const GROUPS: Group[] = [
  { title: 'Sports', tone: 'navy', items: ['NFL', 'NBA', 'MLB', 'NHL', 'WNBA', 'MLS & NWSL', 'College sports', 'Bowl games & March Madness', 'Minor league', 'UFC, boxing & WWE', 'NASCAR, IndyCar & F1', 'Tennis & golf', 'Rodeo & PBR', 'High school'] },
  { title: 'Music', tone: 'lime', items: ['Arena & stadium tours', 'Club shows', 'Festivals', 'Electronic & nightlife'] },
  { title: 'Stage & comedy', tone: 'cream', items: ['Broadway', 'Touring & regional theater', 'Orchestra, opera & ballet', 'Comedy'] },
  { title: 'Days out', tone: 'gray', items: ['Family shows & circus', 'Fairs & local festivals', 'Conventions & fan expos', 'Las Vegas shows', 'Museums & attractions'] },
];

const CHECKS = ['The total for your whole group, fees included', 'Seats together, when you need them', 'Where the price is heading', 'Cheaper listings elsewhere', 'Delivery timing and restrictions'];

export function EventTypes({ address }: { address: string }) {
  const mailto = (what: string) => `mailto:${address}?subject=${encodeURIComponent(`${what} tickets`)}&body=${encodeURIComponent('Event, date or link:\nHow many tickets:\nBudget:\n')}`;
  return (
    <section className="events wrap" aria-labelledby="events-title">
      <div className="section-head">
        <h2 id="events-title">Every kind of ticket.</h2>
        <p>Sports, music, stage and days out, anywhere in the US. Tap one to ask.</p>
      </div>
      <div className="events-grid">
        {GROUPS.map((g) => (
          <div key={g.title} className={`events-win events-${g.tone}`}>
            <div className="events-bar">{g.title}</div>
            <ul>
              {g.items.map((i) => (
                <li key={i}><a href={mailto(i)}>{i}</a></li>
              ))}
            </ul>
          </div>
        ))}
        <div className="events-win events-checks">
          <div className="events-bar">What we check</div>
          <ul>
            {CHECKS.map((c) => (
              <li key={c}><span className="check" aria-hidden="true">✓</span>{c}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
