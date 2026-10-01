/**
 * Which market snapshots a group-basket trend may be derived from and shown with (Research 2,
 * R2-TREND-RIGHTS-01). The same rights the benchmark asks of its history, applied to the trend:
 *
 * - derive: the dataset is approved, inside its retention, and approved for advice (a trend steers buy or wait);
 * - display: additionally approved for customer display;
 * - a real snapshot with no dataset record has no rights;
 * - fixture snapshots count only in the fixture world, and a fixture dataset they name must still be approved.
 *
 * Revoked, quarantined and expired datasets are excluded whatever their uses say, so a rights change takes
 * effect on the next computation rather than when someone remembers to clean up.
 */

export type TrendSnapshotRights = { id: string; datasetId: string | null; isFixture: boolean };
export type TrendDatasetRights = { id: string; status: string; approvedUses: string[]; rawRetentionUntil: Date | null; derivedRetentionUntil: Date | null; isFixture: boolean };

export type TrendRightsVerdict = {
  admitted: Set<string>;
  excluded: Array<{ id: string; reason: string }>;
  /** Every admitted snapshot may be shown to customers. False when nothing was admitted. */
  displayAllowed: boolean;
};

export const TREND_DERIVE_USE = 'advice';
const FIXTURE_DERIVE_USE = 'derived_aggregates';

export function trendRights(snapshots: TrendSnapshotRights[], datasets: Map<string, TrendDatasetRights>, opts: { now: Date; fixtureWorld: boolean }): TrendRightsVerdict {
  const admitted = new Set<string>();
  const excluded: TrendRightsVerdict['excluded'] = [];
  let displayAllowed = true;
  for (const s of snapshots) {
    const ds = s.datasetId ? datasets.get(s.datasetId) : undefined;
    const reason = (() => {
      if (s.isFixture) {
        if (!opts.fixtureWorld) return 'fixture_data_not_admissible';
        if (!s.datasetId) return null;
        if (!ds) return 'no_dataset_rights';
        if (!ds.isFixture) return 'fixture_row_in_real_dataset';
      } else if (!ds) return 'no_dataset_rights';
      if (ds.status !== 'approved') return `dataset_${ds.status}`;
      const until = ds.derivedRetentionUntil ?? ds.rawRetentionUntil;
      if (until && until <= opts.now) return 'dataset_retention_expired';
      const use = ds.isFixture ? FIXTURE_DERIVE_USE : TREND_DERIVE_USE;
      if (!ds.approvedUses.includes(use) && !ds.approvedUses.includes(TREND_DERIVE_USE)) return 'dataset_use_not_approved';
      return null;
    })();
    if (reason) {
      excluded.push({ id: s.id, reason });
      continue;
    }
    admitted.add(s.id);
    if (ds && !ds.approvedUses.includes('customer_display')) displayAllowed = false;
  }
  return { admitted, excluded, displayAllowed: displayAllowed && admitted.size > 0 };
}
