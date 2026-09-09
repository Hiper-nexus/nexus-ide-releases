import type {
  EnrichedCatalogInfo,
  HarnessTier,
  InstalledItemInfo,
} from '../../../shared/types';

export type HarnessKindFilter = 'todos' | 'agent' | 'skill';
export type HarnessTierFilter = 'todos' | HarnessTier | 'pendente';

export interface HarnessInventoryRow {
  item: InstalledItemInfo;
  origin: string;
  tier?: HarnessTier;
  blurb?: string;
  whenToUse?: string;
}

/** The CLI home is more useful provenance than a generic first/third-party badge. */
export function harnessOrigin(file: string): string {
  const normalized = file.replaceAll('\\', '/').toLowerCase();
  if (normalized.includes('/.claude/')) return 'Claude';
  if (normalized.includes('/.codex/')) return 'Codex';
  if (normalized.includes('/.agents/')) return 'Agents';
  if (normalized.includes('/.gemini/')) return 'Antigravity';
  if (normalized.includes('/.kimi-code/')) return 'Kimi';
  if (normalized.includes('/.grok/')) return 'Grok';
  if (normalized.includes('/.nexus/')) return 'Nexus';
  return 'Local';
}

export function buildHarnessInventory(
  items: InstalledItemInfo[],
  enriched: EnrichedCatalogInfo | null,
): HarnessInventoryRow[] {
  const annotations = new Map(
    (enriched?.items ?? []).map((item) => [`${item.kind}:${item.name}`, item]),
  );
  return items
    .filter((item) => item.kind === 'agent' || item.kind === 'skill')
    .map((item) => {
      const note = annotations.get(`${item.kind}:${item.name}`);
      return {
        item,
        origin: harnessOrigin(item.file),
        tier: note?.tier,
        blurb: note?.blurb,
        whenToUse: note?.whenToUse,
      };
    })
    .sort((a, b) => a.item.name.localeCompare(b.item.name));
}

function searchable(row: HarnessInventoryRow): string {
  return [
    row.item.name,
    row.item.kind,
    row.origin,
    row.tier,
    row.blurb,
    row.whenToUse,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

export function filterHarnessInventory(
  rows: HarnessInventoryRow[],
  filters: {
    query: string;
    kind: HarnessKindFilter;
    tier: HarnessTierFilter;
    origin: string;
  },
): HarnessInventoryRow[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (filters.kind !== 'todos' && row.item.kind !== filters.kind) return false;
    if (filters.tier === 'pendente' && row.tier) return false;
    if (
      filters.tier !== 'todos' &&
      filters.tier !== 'pendente' &&
      row.tier !== filters.tier
    ) {
      return false;
    }
    if (filters.origin !== 'todas' && row.origin !== filters.origin) return false;
    return !query || searchable(row).includes(query);
  });
}
