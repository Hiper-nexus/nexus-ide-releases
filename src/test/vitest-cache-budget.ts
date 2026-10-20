import fs from 'node:fs';
import path from 'node:path';

/**
 * Teto do fsModuleCache do Vitest (`.nexus-cache/vitest`, um por worktree).
 * O Vitest nunca poda esse cache: cada transform novo vira um arquivo e nada
 * sai, e cada worktree de writer chegava a 1,7 GB. Antes de cada rodada, os
 * arquivos mais antigos saem até o cache voltar a 3/4 do teto (histerese:
 * não poda a cada rodada). Entrada apagada é só um transform refeito.
 */
export const VITEST_CACHE_BUDGET_BYTES = 512 * 1024 * 1024;

export interface CachePruneResult {
  readonly removed: number;
  readonly freedBytes: number;
  readonly totalBytes: number;
}

export function pruneVitestModuleCache(
  directory: string,
  budgetBytes: number = VITEST_CACHE_BUDGET_BYTES,
): CachePruneResult {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return { removed: 0, freedBytes: 0, totalBytes: 0 };
  }
  const files: Array<{ file: string; bytes: number; mtimeMs: number }> = [];
  let totalBytes = 0;
  for (const name of names) {
    const file = path.join(directory, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) continue;
      const bytes = stat.blocks > 0 ? stat.blocks * 512 : stat.size;
      files.push({ file, bytes, mtimeMs: stat.mtimeMs });
      totalBytes += bytes;
    } catch {
      // Outro processo do Vitest trocou a entrada no meio: ignora.
    }
  }
  if (totalBytes <= budgetBytes) return { removed: 0, freedBytes: 0, totalBytes };
  files.sort((left, right) => left.mtimeMs - right.mtimeMs);
  const target = Math.floor(budgetBytes * 0.75);
  let removed = 0;
  let freedBytes = 0;
  for (const entry of files) {
    if (totalBytes - freedBytes <= target) break;
    try {
      fs.unlinkSync(entry.file);
      removed += 1;
      freedBytes += entry.bytes;
    } catch {
      // Já saiu (rodada paralela) ou sem permissão: segue para o próximo.
    }
  }
  return { removed, freedBytes, totalBytes: totalBytes - freedBytes };
}

/** globalSetup do Vitest: roda uma vez por processo de teste, antes das suítes. */
export default function setup(): void {
  try {
    pruneVitestModuleCache(path.resolve('.nexus-cache', 'vitest'));
  } catch {
    // Higiene nunca derruba a rodada de testes.
  }
}
