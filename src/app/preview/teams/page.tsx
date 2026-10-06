import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { brandAssets } from '@/lib/db/schema';
import { sendable } from '@/lib/brand/assets';
import '@/components/preview/inbox.css';

const LEAGUES = ['NFL', 'NBA', 'WNBA', 'NHL', 'MLB', 'MLS', 'NWSL', 'NCAA'];

/**
 * Every team the ticket brief can draw, by league, as the database holds it: logo, colours, short name, the other
 * names it is matched by, and whether its logo may go into a sent email. Edit src/lib/brand/teams/*.json (or re-run
 * pnpm brand:build) and deploy to change one.
 */
export default async function TeamsPreview() {
  const { db } = await getDb();
  const rows = await db.select().from(brandAssets).where(eq(brandAssets.kind, 'team')).orderBy(asc(brandAssets.name));
  return (
    <div className="tgx">
      <p className="preview-flag">Team brands: {rows.length} teams in the database.</p>
      <main className="wrap sig-page">
        <p className="sig-back"><Link className="link" href="/preview/ticket-brief">Ticket brief samples</Link></p>
        {LEAGUES.map((league) => {
          const teams = rows.filter((r) => r.league === league);
          if (!teams.length) return null;
          return (
            <section key={league} className="sig-section">
              <h2 className="sig-heading">{league} <span>· {teams.length} teams</span></h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
                {teams.map((t) => (
                  <div key={t.key} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 10, border: '1px solid #e0e4e4', borderRadius: 10, background: '#fff' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {t.imageUrl ? <img src={t.imageUrl} alt="" width={44} height={44} style={{ flex: 'none' }} /> : <div style={{ width: 44, height: 44 }} />}
                    <div style={{ minWidth: 0, fontSize: 13, lineHeight: '18px' }}>
                      <div style={{ fontWeight: 700 }}>{t.name}</div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#536174' }}>
                        <span>{t.shortName ?? '—'}</span>
                        {[t.primaryColor, t.secondaryColor].filter(Boolean).map((c) => <span key={c} title={c!} style={{ width: 14, height: 14, borderRadius: 3, background: c!, border: '1px solid #cbd2d3' }} />)}
                        <span>{sendable(t) ? 'in email' : 'preview only'}</span>
                      </div>
                      {t.aliases.length > 0 && <div style={{ color: '#536174', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.aliases.join(', ')}>also {t.aliases.join(', ')}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </main>
    </div>
  );
}
