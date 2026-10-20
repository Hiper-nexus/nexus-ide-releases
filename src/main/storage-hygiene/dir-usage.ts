import fs from 'node:fs';
import path from 'node:path';

export interface DirUsage {
  /** Bytes alocados (st_blocks × 512; tamanho lógico onde o SO não informa blocos). */
  readonly bytes: number;
  readonly entries: number;
  /** Orçamento esgotado: `bytes` é um piso. */
  readonly truncated: boolean;
}

export interface DirUsageBudget {
  readonly deadlineAt?: number;
  readonly maxEntries?: number;
}

const YIELD_EVERY = 512;

function allocated(stat: fs.Stats): number {
  // Windows não preenche `blocks`; arquivo esparso/clonado no APFS conta o alocado.
  return typeof stat.blocks === 'number' && stat.blocks > 0 ? stat.blocks * 512 : stat.size;
}

const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Tamanho de uma árvore SEM seguir link (symlink/junction contam 0 e não são
 * percorridos). Assíncrono e cooperativo: cede o turno a cada lote e para no
 * orçamento, marcando `truncated`. Nunca lança.
 */
export async function measureDirUsage(root: string, budget: DirUsageBudget = {}): Promise<DirUsage> {
  const maxEntries = budget.maxEntries ?? Number.POSITIVE_INFINITY;
  let bytes = 0;
  let entries = 0;
  const stack = [root];
  while (stack.length > 0) {
    if (entries >= maxEntries || (budget.deadlineAt !== undefined && Date.now() >= budget.deadlineAt)) {
      return { bytes, entries, truncated: true };
    }
    const current = stack.pop()!;
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(current);
    } catch {
      continue;
    }
    entries += 1;
    if (entries % YIELD_EVERY === 0) await yieldTurn();
    if (stat.isSymbolicLink()) continue;
    bytes += allocated(stat);
    if (!stat.isDirectory()) continue;
    let children: string[];
    try {
      children = await fs.promises.readdir(current);
    } catch {
      continue;
    }
    for (const child of children) stack.push(path.join(current, child));
  }
  return { bytes, entries, truncated: false };
}

/**
 * Atividade mais recente de um item: o maior mtime entre ele e seus filhos
 * até `depth` níveis (0 = só o próprio item). Link não é seguido. Pasta
 * grande demais para o orçamento conta como ativa AGORA (nunca apaga por
 * falta de prova de inatividade).
 */
export async function newestActivityMs(
  target: string,
  options: { readonly depth?: number; readonly maxEntries?: number; readonly now?: number } = {},
): Promise<number> {
  const depth = options.depth ?? 1;
  const maxEntries = options.maxEntries ?? 4_000;
  const now = options.now ?? Date.now();
  let newest = 0;
  let seen = 0;
  const stack: Array<{ readonly file: string; readonly level: number }> = [{ file: target, level: 0 }];
  while (stack.length > 0) {
    const { file, level } = stack.pop()!;
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(file);
    } catch {
      continue;
    }
    seen += 1;
    if (seen > maxEntries) return now;
    if (seen % YIELD_EVERY === 0) await yieldTurn();
    newest = Math.max(newest, stat.mtimeMs, stat.ctimeMs);
    if (!stat.isDirectory() || stat.isSymbolicLink() || level >= depth) continue;
    let children: string[];
    try {
      children = await fs.promises.readdir(file);
    } catch {
      continue;
    }
    for (const child of children) stack.push({ file: path.join(file, child), level: level + 1 });
  }
  return newest;
}
