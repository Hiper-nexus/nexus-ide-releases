import fs from 'node:fs';
import path from 'node:path';
import { removeTree } from '../util/remove-tree';
import { writeFileAtomicAsync } from '../util/atomic-write';
import { measureDirUsage, newestActivityMs } from './dir-usage';

export interface SweepOutcome {
  readonly removed: number;
  readonly freedBytes: number;
  readonly kept: number;
  readonly errors: number;
  /** Itens não examinados (prazo da rodada). */
  readonly deferred: number;
}

export const EMPTY_SWEEP: SweepOutcome = Object.freeze({ removed: 0, freedBytes: 0, kept: 0, errors: 0, deferred: 0 });

export function addSweeps(...outcomes: readonly SweepOutcome[]): SweepOutcome {
  return outcomes.reduce((sum, item) => ({
    removed: sum.removed + item.removed,
    freedBytes: sum.freedBytes + item.freedBytes,
    kept: sum.kept + item.kept,
    errors: sum.errors + item.errors,
    deferred: sum.deferred + item.deferred,
  }), EMPTY_SWEEP);
}

export interface StaleSweepInput {
  /** Diretório cujos FILHOS diretos são candidatos. */
  readonly root: string;
  readonly maxIdleMs: number;
  readonly now: number;
  /** Só nomes que casam são candidatos (nunca o resto do diretório). */
  readonly match: (name: string) => boolean;
  /** Proteção por identidade (sessão viva, partição carregada…). */
  readonly isProtected?: (name: string, fullPath: string) => boolean;
  /** Profundidade da prova de inatividade (mtime mais novo até N níveis). */
  readonly activityDepth?: number;
  readonly deadlineAt?: number;
  /** Teto de remoções por rodada (o resto fica para a próxima). */
  readonly maxRemovals?: number;
  /** Último passo antes de apagar (resgate); `false` mantém o item. */
  readonly beforeRemove?: (name: string, fullPath: string) => boolean | Promise<boolean>;
}

/**
 * Remove filhos de `root` que casam `match`, não estão protegidos e não têm
 * atividade (mtime/ctime) há pelo menos `maxIdleMs`. Link nunca é seguido nem
 * removido (pode apontar para fora). Falha de um item conta e segue; nunca lança.
 */
export async function sweepStaleChildren(input: StaleSweepInput): Promise<SweepOutcome> {
  let names: string[];
  try {
    names = await fs.promises.readdir(input.root);
  } catch {
    return EMPTY_SWEEP;
  }
  let removed = 0;
  let freedBytes = 0;
  let kept = 0;
  let errors = 0;
  let deferred = 0;
  const maxRemovals = input.maxRemovals ?? Number.POSITIVE_INFINITY;
  for (const [index, name] of names.entries()) {
    if (!input.match(name)) continue;
    if (removed >= maxRemovals || (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt)) {
      deferred = names.slice(index).filter((rest) => input.match(rest)).length;
      break;
    }
    const full = path.join(input.root, name);
    try {
      const stat = await fs.promises.lstat(full);
      if (stat.isSymbolicLink()) continue;
      if (input.isProtected?.(name, full)) {
        kept += 1;
        continue;
      }
      const newest = await newestActivityMs(full, { depth: input.activityDepth ?? 1, now: input.now });
      if (input.now - newest < input.maxIdleMs) {
        kept += 1;
        continue;
      }
      if (input.beforeRemove && !await input.beforeRemove(name, full)) {
        kept += 1;
        continue;
      }
      const usage = stat.isDirectory()
        ? await measureDirUsage(full, { deadlineAt: Date.now() + 5_000 })
        : { bytes: stat.size };
      await removeTree(full, { force: true });
      removed += 1;
      freedBytes += usage.bytes;
    } catch {
      errors += 1;
    }
  }
  return { removed, freedBytes, kept, errors, deferred };
}

/**
 * Mantém só os `keep` arquivos mais novos (mtime) de `dir` que casam `match`.
 * Para cópias de segurança rotativas; nunca toca diretórios nem links.
 */
export async function keepNewestFiles(
  dir: string,
  match: (name: string) => boolean,
  keep: number,
): Promise<SweepOutcome> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return EMPTY_SWEEP;
  }
  const files: Array<{ full: string; mtimeMs: number; size: number }> = [];
  for (const name of names) {
    if (!match(name)) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fs.promises.lstat(full);
      if (stat.isFile()) files.push({ full, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // sumiu entre o readdir e o lstat
    }
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  let removed = 0;
  let freedBytes = 0;
  let errors = 0;
  for (const file of files.slice(Math.max(0, keep))) {
    try {
      await fs.promises.unlink(file.full);
      removed += 1;
      freedBytes += file.size;
    } catch {
      errors += 1;
    }
  }
  return { removed, freedBytes, kept: Math.min(files.length, Math.max(0, keep)), errors, deferred: 0 };
}

/**
 * Teto de arquivo append-only (log/jsonl sem rotação): passou de `maxBytes`,
 * fica só a cauda de `keepBytes` a partir de uma quebra de linha inteira.
 * Escrita atômica (temp imprevisível + rename); ausente ou dentro do teto: nada.
 */
export async function capAppendOnlyFile(file: string, maxBytes: number, keepBytes: number): Promise<SweepOutcome> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(file);
  } catch {
    return EMPTY_SWEEP;
  }
  if (!stat.isFile() || stat.size <= maxBytes) return { ...EMPTY_SWEEP, kept: 1 };
  const keep = Math.max(0, Math.min(keepBytes, stat.size));
  const handle = await fs.promises.open(file, 'r');
  let tail: Buffer;
  try {
    tail = Buffer.alloc(keep);
    await handle.read(tail, 0, keep, stat.size - keep);
  } finally {
    await handle.close();
  }
  const newline = tail.indexOf(0x0a);
  let kept = newline >= 0 ? tail.subarray(newline + 1) : Buffer.alloc(0);
  // O que o dono do log anexou durante a leitura vai junto (janela residual:
  // entre esta leitura e o rename).
  const grown = await fs.promises.lstat(file).then((current) => current.size, () => stat.size);
  if (grown > stat.size) {
    const extra = Buffer.alloc(grown - stat.size);
    const again = await fs.promises.open(file, 'r');
    try {
      await again.read(extra, 0, extra.length, stat.size);
    } finally {
      await again.close();
    }
    kept = Buffer.concat([kept, extra]);
  }
  await writeFileAtomicAsync(file, kept, stat.mode & 0o777, { createDirectory: false });
  return { removed: 0, freedBytes: Math.max(0, grown - kept.length), kept: 1, errors: 0, deferred: 0 };
}

/** Remove diretórios vazios sob `root` (exclusive), de baixo para cima. */
export async function pruneEmptyDirs(root: string, depth: number): Promise<void> {
  if (depth <= 0) return;
  let names: string[];
  try {
    names = await fs.promises.readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    const full = path.join(root, name);
    try {
      const stat = await fs.promises.lstat(full);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      await pruneEmptyDirs(full, depth - 1);
      if ((await fs.promises.readdir(full)).length === 0) await fs.promises.rmdir(full);
    } catch {
      // corrida com quem escreve ali: fica para a próxima rodada
    }
  }
}
