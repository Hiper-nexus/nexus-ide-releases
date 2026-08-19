import { normalizeWavePackFile } from '../../shared/mission-wave-pack';

/**
 * Fan-out same_checkout: serializa só quando dois escritores disputam o
 * MESMO arquivo. Arquivos disjuntos (public/index.html vs server.js) podem
 * nascer no mesmo turno — o Overclock gap era serializar a missão inteira.
 */

export interface SameCheckoutWriterClaim {
  readonly paneId: string;
  readonly state: string;
  readonly files: readonly string[];
}

export function normalizeOwnershipFiles(
  files: readonly string[] | undefined | null,
): string[] {
  if (!files || files.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of files) {
    const file = normalizeWavePackFile(String(raw).trim());
    if (!file || seen.has(file)) continue;
    seen.add(file);
    out.push(file);
  }
  return out;
}

/** True when two ownership footprints share a file (or either is empty). */
export function ownershipFilesOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length === 0 || right.length === 0) return true;
  const rightSet = new Set(right.map(normalizeWavePackFile));
  return left.some((file) => rightSet.has(normalizeWavePackFile(file)));
}

/**
 * Extrai caminhos de arquivo mencionados no prompt (heurística leve para
 * Maestro que descreve o escopo sem passar `files` no spawn).
 */
export function extractOwnershipFilesFromPrompt(prompt: string): string[] {
  const text = prompt.trim();
  if (!text) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  const pattern =
    /(?:^|[\s`"'(])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,12}|[\w.-]+\.(?:html?|css|js|jsx|ts|tsx|mjs|cjs|json|md|py|go|rs|toml|yml|yaml))\b/g;
  for (const match of text.matchAll(pattern)) {
    const file = normalizeWavePackFile(match[1] ?? '');
    if (!file || seen.has(file)) continue;
    seen.add(file);
    found.push(file);
    if (found.length >= 16) break;
  }
  return found;
}

export function decideSameCheckoutFanout(input: {
  readonly spawnReadOnly: boolean;
  readonly requestedFiles: readonly string[];
  readonly activeWriters: readonly SameCheckoutWriterClaim[];
}): { readonly allowed: true } | { readonly allowed: false; readonly reason: string } {
  if (input.spawnReadOnly) return { allowed: true };
  const active = input.activeWriters;
  if (active.length === 0) return { allowed: true };

  const requested = normalizeOwnershipFiles(input.requestedFiles);
  // Sem footprint declarado: fail-closed — serializa contra qualquer escritor
  // ativo (comportamento histórico "1 escritor por checkout").
  if (requested.length === 0) {
    const blocker = active[0]!;
    return {
      allowed: false,
      reason:
        `same-checkout delegation is serialized; worker ${blocker.paneId} ` +
        `is still ${blocker.state} (declare files= para fan-out disjunto)`,
    };
  }

  for (const writer of active) {
    const claimed = normalizeOwnershipFiles(writer.files);
    if (claimed.length === 0 || ownershipFilesOverlap(requested, claimed)) {
      return {
        allowed: false,
        reason:
          `same-checkout file collision with worker ${writer.paneId} ` +
          `(${writer.state}); writers may fan out only on disjoint files`,
      };
    }
  }
  return { allowed: true };
}

/** In-memory claims for active same_checkout writers (paneId → files). */
const claimsByPaneId = new Map<string, readonly string[]>();

export function registerSameCheckoutClaim(
  paneId: string,
  files: readonly string[],
): void {
  const normalized = normalizeOwnershipFiles(files);
  if (normalized.length === 0) {
    claimsByPaneId.delete(paneId);
    return;
  }
  claimsByPaneId.set(paneId, Object.freeze([...normalized]));
}

export function clearSameCheckoutClaim(paneId: string): void {
  claimsByPaneId.delete(paneId);
}

export function sameCheckoutClaimOf(paneId: string): readonly string[] {
  return claimsByPaneId.get(paneId) ?? [];
}

/** Test helper. */
export function resetSameCheckoutClaimsForTests(): void {
  claimsByPaneId.clear();
}
