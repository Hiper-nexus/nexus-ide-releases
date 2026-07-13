/**
 * Policy for catalog InstalledList empty CTAs.
 * Marketplace only when the empty reason is "nothing installed to install".
 */

export type CatalogEmptyKind =
  | 'installable' // agents/skills with no files at all
  | 'tier-filter' // has install base but filter empty
  | 'plugins'
  | 'hooks'
  | 'other';

export type CatalogEmptyCta = 'marketplace' | 'none' | 'diagnostics' | 'squads';

/** Pure policy — unit-tested; UI maps result to ActionCard. */
export function catalogEmptyCta(kind: CatalogEmptyKind): CatalogEmptyCta {
  switch (kind) {
    case 'installable':
      return 'marketplace';
    case 'tier-filter':
      return 'none';
    case 'plugins':
      return 'none';
    case 'hooks':
      return 'none';
    case 'other':
    default:
      return 'none';
  }
}

/** Infer kind from the empty message string (stable contract with CatalogSections). */
export function catalogEmptyKindFromMessage(empty: string): CatalogEmptyKind {
  const t = empty.toLowerCase();
  if (t.includes('tier') || t.includes('enriquecer') || t.includes('classificar')) {
    return 'tier-filter';
  }
  if (t.includes('plugin')) return 'plugins';
  if (t.includes('hook')) return 'hooks';
  if (
    t.includes('nenhum agent instalado') ||
    t.includes('nenhuma skill instalada') ||
    t.includes('use o marketplace')
  ) {
    return 'installable';
  }
  return 'other';
}

/**
 * Empty copy for Agents/Skills lists.
 * Use **base** installed count (not filtered length / not tier alone):
 * - baseCount === 0 → installable (Marketplace), even if UI tier ≠ todos
 * - baseCount > 0 and filtered empty → tier-filter (Enriquecer)
 */
export function catalogInstallableEmptyMessage(
  kind: 'agent' | 'skill',
  baseCount: number,
  tier: string,
): string {
  if (baseCount === 0) {
    return kind === 'agent'
      ? 'Nenhum agent instalado — use o Marketplace para instalar.'
      : 'Nenhuma skill instalada — use o Marketplace para instalar.';
  }
  return kind === 'agent'
    ? `Nenhum agent no tier ${tier} — rode "Enriquecer" para classificar.`
    : `Nenhuma skill no tier ${tier} — rode "Enriquecer" para classificar.`;
}
