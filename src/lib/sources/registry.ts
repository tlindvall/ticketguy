import { z } from 'zod';
import registryJson from '../../../research/ticket-guy-us-source-registry.json';

export const RegistrySourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  url: z.string().url(),
  group: z.string(),
  source_type: z.string(),
  categories: z.array(z.string()),
  routing_tier: z.enum(['core', 'extended', 'conditional', 'context_only', 'integration_candidate']),
  routing_note: z.string(),
  evidence_url: z.string().url(),
  research_date: z.string(),
  evidence_level: z.string(),
  integration_status: z.literal('not_integrated'),
  access_rights: z.literal('not_validated'),
  us_event_only: z.boolean(),
  recommendation_vetting_status: z.string(),
});
export type RegistrySource = z.infer<typeof RegistrySourceSchema>;

export const RegistrySchema = z.object({
  version: z.string(),
  research_date: z.string(),
  scope: z.string(),
  status: z.string(),
  sources: z.array(RegistrySourceSchema).min(1),
  maintenance_policy: z.record(z.string(), z.string()),
});
export type Registry = z.infer<typeof RegistrySchema>;

let cached: Registry | undefined;
export function loadRegistry(): Registry {
  if (!cached) {
    cached = RegistrySchema.parse(registryJson);
    const ids = new Set<string>();
    for (const s of cached.sources) {
      if (ids.has(s.id)) throw new Error(`duplicate registry id ${s.id}`);
      ids.add(s.id);
    }
  }
  return cached;
}

export function registryIds(): Set<string> {
  return new Set(loadRegistry().sources.map((s) => s.id));
}

/** Known alias domains → registry IDs (research master "Aliases" table). Redirect targets must still be validated live. */
export const DOMAIN_ALIASES: Record<string, string> = {
  'seetickets.us': 'eventim-us-see-tickets-us',
  'eventim.seetickets.us': 'eventim-us-see-tickets-us',
  'goldstar.com': 'todaytix',
  'brownpapertickets.com': 'events-com',
  'ovationtix.com': 'audienceview-ovationtix',
  'showclix.com': 'showclix-leap-events',
  'evenue.net': 'paciolan-evenue',
  'ticketsource.us': 'ticketsource',
};

export function sourceIdForHost(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  if (DOMAIN_ALIASES[host]) return DOMAIN_ALIASES[host]!;
  for (const s of loadRegistry().sources) {
    let h: string;
    try {
      h = new URL(s.url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      continue;
    }
    if (host === h || host.endsWith('.' + h)) return s.id;
  }
  return null;
}
