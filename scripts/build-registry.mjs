// Expands scripts/registry-source.tsv into the canonical research registry JSON.
// The TSV is a compact transcription of the handoff's registry; constant fields come from the handoff.
import { readFileSync, writeFileSync } from 'node:fs';
const EVIDENCE = {
  A: 'official web page or official indexed result; not transaction tested',
  S: 'Official URL/title or public shell observed; substantive event inventory not inspected',
  B: 'Official indexed result or page identity observed; direct fetch challenged/blocked; event access unvalidated',
  D: 'Official US-event waiting-list result observed; homepage blocked; current event use must be verified',
  E: 'Candidate retained; homepage rate limited; no event-level inspection completed',
  L: 'Corroborated by Playbill ticket-buying guide; official site fetch blocked; current event use must be verified',
};
const rows = readFileSync(new URL('./registry-source.tsv', import.meta.url), 'utf8').trim().split('\n');
const sources = rows.map((line) => {
  const [id, name, url, group, source_type, categories, routing_tier, routing_note, evidence_url, ev] = line.split('\t');
  return {
    id, name, url, group, source_type,
    categories: categories.split('|'),
    routing_tier, routing_note,
    evidence_url: evidence_url || url,
    research_date: '2026-09-22',
    evidence_level: EVIDENCE[ev],
    integration_status: 'not_integrated',
    access_rights: 'not_validated',
    us_event_only: true,
    recommendation_vetting_status: 'event_specific_terms_delivery_and_total_price_review_required',
  };
});
const out = {
  version: '1.0',
  research_date: '2026-09-22',
  scope: 'US customers; events physically in 50 states and DC. Territories require explicit expansion. International providers included only for US events.',
  status: 'Research registry, not an operational claim of integration, vetting, or complete worldwide enumeration.',
  sources,
  maintenance_policy: {
    verify_event_primary: 'on every new event; invalidate mapping after redirect or provider change',
    recheck_offers: 'before recommendation and notification',
    review_source_health: 'weekly suggested cadence',
    review_registry_and_aliases: 'monthly suggested cadence',
    new_unknown_checkout: 'manual review; do not auto-trust URL supplied in email',
  },
};
writeFileSync(new URL('../research/ticket-guy-us-source-registry.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${sources.length} sources`);
