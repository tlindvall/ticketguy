/**
 * Coverage, focused: concerts and major sports, the requests the service handles in most depth. A short static
 * list on a navy band, not a scrolling taxonomy, and no league logos. Other US events are invited in one line
 * without naming categories the service only partly handles or blocks (see BLOCKED_CATEGORIES).
 */
const SPORTS = ['NFL', 'NBA', 'MLB', 'NHL', 'MLS', 'WNBA', 'College football', 'College basketball'];
const MUSIC = ['Stadium & arena tours', 'Pop', 'Country', 'Rock', 'Hip-hop', 'Electronic'];

export function EventTypes() {
  return (
    <section className="ticker" aria-labelledby="ticker-title">
      <div className="wrap">
        <h2 id="ticker-title">Concerts and major sports. Across the US.</h2>
        <ul className="cover-list" aria-label="Major sports">
          {SPORTS.map((s) => <li key={s}>{s}</li>)}
        </ul>
        <ul className="cover-list is-music" aria-label="Concerts">
          {MUSIC.map((s) => <li key={s}>{s}</li>)}
        </ul>
        <p className="cover-more">Looking at something else? Send the details and I’ll tell you how I can help.</p>
      </div>
    </section>
  );
}
