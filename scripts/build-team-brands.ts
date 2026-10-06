/**
 * Builds the team brand data the ticket brief draws on (`pnpm brand:build`): every team in the leagues below with its
 * colours, short name, the names a ticket provider may use for it, and its logo, resized and hosted by us
 * (public/brand/logos). Owner's decision 2026-10-06: logos are self-hosted and used to name the teams in a game.
 *
 * Source: ESPN's public team lists, read once here; nothing reads ESPN at run time. Writes
 * src/lib/brand/teams/<league>.json and public/brand/logos/<league>/<slug>.png. Re-run to refresh; review the diff.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { slugify } from '../src/lib/catalog/sync';
import type { TeamBrand } from '../src/lib/brand/teams';

const ROOT = path.resolve(import.meta.dirname, '..');
const API = 'https://site.api.espn.com/apis';

type EspnTeam = { id: string; displayName: string; shortDisplayName?: string; abbreviation?: string; location?: string; name?: string; nickname?: string; color?: string; alternateColor?: string; logos?: Array<{ href: string; rel?: string[] }>; isActive?: boolean };

const PRO: Array<{ league: TeamBrand['league']; sport: TeamBrand['sport']; path: string }> = [
  { league: 'NFL', sport: 'football', path: 'football/nfl' },
  { league: 'NBA', sport: 'basketball', path: 'basketball/nba' },
  { league: 'WNBA', sport: 'basketball', path: 'basketball/wnba' },
  { league: 'NHL', sport: 'hockey', path: 'hockey/nhl' },
  { league: 'MLB', sport: 'baseball', path: 'baseball/mlb' },
  { league: 'MLS', sport: 'soccer', path: 'soccer/usa.1' },
  { league: 'NWSL', sport: 'soccer', path: 'soccer/usa.nwsl' },
];
/** Power-conference football (ACC, Big 12, Big Ten, SEC, FBS independents for Notre Dame) and Big East basketball. */
const NCAA_GROUPS = [
  { sportPath: 'football/college-football', group: 1 },
  { sportPath: 'football/college-football', group: 4 },
  { sportPath: 'football/college-football', group: 5 },
  { sportPath: 'football/college-football', group: 8 },
  { sportPath: 'basketball/mens-college-basketball', group: 4 },
];
const NCAA_INDEPENDENTS = ['Notre Dame Fighting Irish'];
/** Names a ticket provider uses that differ from ESPN's, by our slug. Add to this when a team isn't matched. */
const KNOWN_AS: Record<string, string[]> = {
  'la-clippers': ['Los Angeles Clippers'],
  'la-galaxy': ['Los Angeles Galaxy'],
  'lafc': ['Los Angeles Football Club', 'Los Angeles FC'],
  'new-york-city-fc': ['NYCFC'],
  'red-bull-new-york': ['New York Red Bulls', 'NY Red Bulls'],
  'athletics': ['Oakland Athletics', 'Sacramento Athletics', 'Las Vegas Athletics'],
  'utah-mammoth': ['Utah Hockey Club'],
  'washington-commanders': ['Washington Football Team'],
  'inter-miami-cf': ['Inter Miami'],
  'gotham-fc': ['NJ/NY Gotham FC', 'NJNY Gotham FC'],
};

async function json<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (res.ok) return (await res.json()) as T;
    if (attempt >= 2) throw new Error(`${url}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
}

const hex = (c: string | undefined) => (c && /^[0-9a-f]{6}$/i.test(c) ? `#${c.toUpperCase()}` : null);
const light = (h: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 225;
};

function brandFrom(t: EspnTeam, league: TeamBrand['league'], sport: TeamBrand['sport'] | null): Omit<TeamBrand, 'logo'> & { logoSrc: string | null } {
  let primary = hex(t.color) ?? '#142438';
  let secondary = hex(t.alternateColor) ?? '#FFFFFF';
  // A white or near-white primary makes a banner half that disappears on a white email: the other colour leads.
  if (light(primary) && !light(secondary)) [primary, secondary] = [secondary, primary];
  const slug = slugify(t.displayName);
  // "Location Name" only when it says something the display name doesn't ("LA" → "Los Angeles" comes from KNOWN_AS).
  const full = t.location && t.name && !t.location.includes(t.name) ? `${t.location} ${t.name}` : null;
  const aliases = [...new Set([full, ...(KNOWN_AS[slug] ?? [])].filter((x): x is string => !!x).map(slugify).filter((s) => s && s !== slug))];
  const logoSrc = (t.logos ?? []).find((l) => l.rel?.includes('default'))?.href ?? t.logos?.[0]?.href ?? null;
  return { slug, name: t.displayName, shortName: (t.abbreviation ?? '').toUpperCase() || null, league, sport, aliases, primaryColor: primary, secondaryColor: secondary, logoSrc };
}

async function saveLogo(src: string, league: string, slug: string): Promise<string> {
  const res = await fetch(src, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`);
  const png = await sharp(Buffer.from(await res.arrayBuffer())).resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png({ compressionLevel: 9, palette: true }).toBuffer();
  const rel = `brand/logos/${league.toLowerCase()}/${slug}.png`;
  await mkdir(path.join(ROOT, 'public', path.dirname(rel)), { recursive: true });
  await writeFile(path.join(ROOT, 'public', rel), png);
  return `/${rel}`;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]!);
    }
  }));
  return out;
}

async function finish(league: TeamBrand['league'], rows: Array<ReturnType<typeof brandFrom>>): Promise<void> {
  const teams = await pool(rows, 6, async ({ logoSrc, ...b }) => ({ ...b, logo: logoSrc ? await saveLogo(logoSrc, league, b.slug) : null }));
  teams.sort((a, b) => a.name.localeCompare(b.name));
  const file = path.join(ROOT, 'src/lib/brand/teams', `${league.toLowerCase()}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(teams, null, 2)}\n`);
  console.log(`[brand] ${league}: ${teams.length} teams, ${teams.filter((t) => t.logo).length} logos`);
}

for (const l of PRO) {
  const d = await json<{ sports: Array<{ leagues: Array<{ teams: Array<{ team: EspnTeam }> }> }> }>(`${API}/site/v2/sports/${l.path}/teams?limit=200`);
  const teams = d.sports[0]!.leagues[0]!.teams.map((x) => x.team).filter((t) => t.isActive !== false);
  await finish(l.league, teams.map((t) => brandFrom(t, l.league, l.sport)));
}

// NCAA: conference members by standings (the team list has every division), then each school for its colours.
type Standing = { standings?: { entries?: Array<{ team: EspnTeam }> }; children?: Standing[] };
const members = (s: Standing): EspnTeam[] => [...(s.standings?.entries ?? []).map((e) => e.team), ...(s.children ?? []).flatMap(members)];
// Each school is looked up under the sport it was found in: a Big East school may have no football team.
const schools = new Map<string, string>();
for (const g of NCAA_GROUPS) for (const t of members(await json<Standing>(`${API}/v2/sports/${g.sportPath}/standings?group=${g.group}`))) if (!schools.has(t.id)) schools.set(t.id, g.sportPath);
const indep = members(await json<Standing>(`${API}/v2/sports/football/college-football/standings?group=18`)).filter((t) => NCAA_INDEPENDENTS.includes(t.displayName));
for (const t of indep) schools.set(t.id, 'football/college-football');
const detailed = await pool([...schools], 6, async ([id, sportPath]) => (await json<{ team: EspnTeam }>(`${API}/site/v2/sports/${sportPath}/teams/${id}`)).team);
// A school plays every sport, so its sport comes from the event, not the row.
await finish('NCAA', detailed.map((t) => brandFrom(t, 'NCAA', null)));
