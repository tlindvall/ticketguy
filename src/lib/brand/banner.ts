import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Sport } from './teams';

/**
 * The ticket brief's banner for a game (design of Oct 6), drawn once per matchup and served as one JPEG: both teams'
 * colours split on a diagonal, each logo on a white badge, and a faint drawing of the sport's playing surface. One
 * image, not layered HTML, because Gmail drops SVG and background images and Outlook breaks overlapping tables; the
 * facts stay as text under it, so the email reads the same with images off.
 *
 * 1200×400 (3:1), shown at 600×200. No text in the image: names are on the card, and a server font is not ours to pick.
 */
export type BannerSide = { primaryColor: string; secondaryColor?: string | null; logoPath: string | null };
export type BannerTemplate = Sport | 'theater';

const W = 1200;
const H = 400;
const INK = '#142438';
const LIME = '#D7F36B';
const LINE = 'stroke="#FFFFFF" stroke-opacity="0.17" fill="none" stroke-width="5"';
const HEX = /^#[0-9A-F]{6}$/i;

/** The playing surface, as faint white lines over the colours. */
const SURFACES: Record<BannerTemplate, string> = {
  hockey: [
    `<rect x="24" y="24" width="1152" height="352" rx="150" ${LINE}/>`,
    `<line x1="410" y1="24" x2="410" y2="376" stroke="#FFFFFF" stroke-opacity="0.14" stroke-width="14"/>`,
    `<line x1="790" y1="24" x2="790" y2="376" stroke="#FFFFFF" stroke-opacity="0.14" stroke-width="14"/>`,
    `<circle cx="600" cy="200" r="70" ${LINE}/>`,
    ...[[190, 110], [190, 290], [1010, 110], [1010, 290]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="52" ${LINE}/><circle cx="${x}" cy="${y}" r="7" fill="#FFFFFF" fill-opacity="0.2"/>`),
    `<line x1="96" y1="40" x2="96" y2="360" ${LINE}/><line x1="1104" y1="40" x2="1104" y2="360" ${LINE}/>`,
  ].join(''),
  basketball: [
    `<rect x="24" y="24" width="1152" height="352" ${LINE}/>`,
    `<line x1="600" y1="24" x2="600" y2="376" ${LINE}/>`,
    `<circle cx="600" cy="200" r="72" ${LINE}/>`,
    `<rect x="24" y="128" width="200" height="144" ${LINE}/><rect x="976" y="128" width="200" height="144" ${LINE}/>`,
    `<circle cx="224" cy="200" r="72" ${LINE}/><circle cx="976" cy="200" r="72" ${LINE}/>`,
    `<path d="M24 46 H150 A190 190 0 0 1 150 354 H24" ${LINE}/><path d="M1176 46 H1050 A190 190 0 0 0 1050 354 H1176" ${LINE}/>`,
  ].join(''),
  baseball: [
    `<path d="M600 384 L190 -26 M600 384 L1010 -26" ${LINE}/>`,
    `<path d="M300 -20 A430 430 0 0 1 900 -20" ${LINE}/>`,
    `<polygon points="600,150 716,266 600,382 484,266" ${LINE}/>`,
    ...[[600, 150], [716, 266], [484, 266]].map(([x, y]) => `<rect x="${x! - 11}" y="${y! - 11}" width="22" height="22" transform="rotate(45 ${x} ${y})" fill="#FFFFFF" fill-opacity="0.22"/>`),
    `<circle cx="600" cy="276" r="26" ${LINE}/>`,
  ].join(''),
  football: [
    `<rect x="0" y="0" width="110" height="400" fill="#FFFFFF" fill-opacity="0.06"/><rect x="1090" y="0" width="110" height="400" fill="#FFFFFF" fill-opacity="0.06"/>`,
    ...Array.from({ length: 11 }, (_, i) => 110 + i * 98).map((x) => `<line x1="${x}" y1="0" x2="${x}" y2="400" stroke="#FFFFFF" stroke-opacity="${x === 600 ? 0.26 : 0.15}" stroke-width="5"/>`),
    ...Array.from({ length: 40 }, (_, i) => 130 + i * 24.5).flatMap((x) => [`<line x1="${x}" y1="140" x2="${x}" y2="156" stroke="#FFFFFF" stroke-opacity="0.15" stroke-width="3"/>`, `<line x1="${x}" y1="244" x2="${x}" y2="260" stroke="#FFFFFF" stroke-opacity="0.15" stroke-width="3"/>`]),
  ].join(''),
  soccer: [
    `<rect x="24" y="24" width="1152" height="352" ${LINE}/>`,
    `<line x1="600" y1="24" x2="600" y2="376" ${LINE}/>`,
    `<circle cx="600" cy="200" r="78" ${LINE}/><circle cx="600" cy="200" r="7" fill="#FFFFFF" fill-opacity="0.22"/>`,
    `<rect x="24" y="92" width="168" height="216" ${LINE}/><rect x="1008" y="92" width="168" height="216" ${LINE}/>`,
    `<rect x="24" y="152" width="60" height="96" ${LINE}/><rect x="1116" y="152" width="60" height="96" ${LINE}/>`,
    `<path d="M192 152 A72 72 0 0 1 192 248" ${LINE}/><path d="M1008 152 A72 72 0 0 0 1008 248" ${LINE}/>`,
  ].join(''),
  // A stage: curtain folds either side, a spotlight, the boards.
  theater: [
    `<radialGradient id="spot" cx="50%" cy="10%" r="70%"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.32"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>`,
    `<rect width="${W}" height="${H}" fill="url(#spot)"/>`,
    ...Array.from({ length: 8 }, (_, i) => i * 34).flatMap((x) => [`<rect x="${x}" y="0" width="17" height="400" fill="#000000" fill-opacity="0.16"/>`, `<rect x="${W - 17 - x}" y="0" width="17" height="400" fill="#000000" fill-opacity="0.16"/>`]),
    `<path d="M0 0 H1200 V46 Q900 86 600 46 Q300 86 0 46 Z" fill="#000000" fill-opacity="0.22"/>`,
    `<rect x="0" y="352" width="${W}" height="48" fill="#000000" fill-opacity="0.22"/>`,
    ...Array.from({ length: 23 }, (_, i) => 60 + i * 47.7).map((x) => `<circle cx="${x}" cy="376" r="6" fill="${LIME}" fill-opacity="0.75"/>`),
  ].join(''),
};

async function logoData(logoPath: string | null): Promise<string | null> {
  if (!logoPath || !/^\/brand\/logos\/[a-z0-9-]+\/[a-z0-9-]+\.png$/.test(logoPath)) return null;
  try {
    const bytes = await readFile(path.join(process.cwd(), 'public', logoPath));
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

function badge(cx: number, logo: string | null): string {
  if (!logo) return '';
  return `<circle cx="${cx + 5}" cy="207" r="126" fill="${INK}" fill-opacity="0.28"/><circle cx="${cx}" cy="200" r="126" fill="#FFFFFF"/><image href="${logo}" x="${cx - 92}" y="108" width="184" height="184" preserveAspectRatio="xMidYMid meet"/>`;
}

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** How far apart two colours look (redmean approximation). */
export function colourDistance(x: string, y: string): number {
  const [r1, g1, b1] = rgb(x) as [number, number, number];
  const [r2, g2, b2] = rgb(y) as [number, number, number];
  const rm = (r1 + r2) / 2;
  return Math.sqrt((2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2);
}
const tooLight = (h: string) => { const [r, g, b] = rgb(h) as [number, number, number]; return 0.2126 * r + 0.7152 * g + 0.0722 * b > 225; };
function hue(h: string): number {
  const [r, g, b] = (rgb(h) as [number, number, number]).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!d) return 0;
  const x = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (x * 60 + 360) % 360;
}
/** Two halves that read as one: nearly the same colour, or the same hue at a similar depth (Yankees and Mets navy). */
export function clash(x: string, y: string): boolean {
  const d = colourDistance(x, y);
  const dh = Math.abs(hue(x) - hue(y));
  return d < 60 || (Math.min(dh, 360 - dh) < 20 && d < 130);
}

/** The opponent's colour: its own, unless it looks like ours (Rangers and Islanders blue), then its second colour. */
function opponentColour(a: string, right: BannerSide): string | null {
  const own = HEX.test(right.primaryColor) ? right.primaryColor : null;
  const alt = right.secondaryColor && HEX.test(right.secondaryColor) && !tooLight(right.secondaryColor) ? right.secondaryColor : null;
  if (own && alt && clash(a, own) && !clash(a, alt)) return alt;
  return own ?? alt;
}

export async function renderBanner(template: BannerTemplate, left: BannerSide, right: BannerSide | null): Promise<Buffer> {
  const a = HEX.test(left.primaryColor) ? left.primaryColor : INK;
  const b = right ? opponentColour(a, right) : null;
  const [la, lb] = await Promise.all([logoData(left.logoPath), right ? logoData(right.logoPath) : Promise.resolve(null)]);
  const fields = b
    ? `<polygon points="0,0 650,0 550,400 0,400" fill="${a}"/><polygon points="650,0 1200,0 1200,400 550,400" fill="${b}"/>`
    : `<rect width="${W}" height="${H}" fill="${a}"/>`;
  const shade = `<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.18"/></linearGradient>`;
  const divider = b ? `<polygon points="636,0 664,0 564,400 536,400" fill="${INK}"/><line x1="650" y1="0" x2="550" y2="400" stroke="${LIME}" stroke-width="4"/>` : '';
  const logos = template === 'theater' ? '' : b ? `${badge(300, la)}${badge(900, lb)}` : badge(600, la);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${shade}</defs>${fields}${SURFACES[template]}<rect width="${W}" height="${H}" fill="url(#shade)"/>${divider}${logos}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
}
