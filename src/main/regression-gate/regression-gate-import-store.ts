/**
 * Persistência em disco do cache de imports do portão. A chave de validade é
 * (arquivo, size, mtime); quando size/mtime mudam (checkout novo, touch), o
 * hash do conteúdo ainda evita reanalisar o arquivo. Um acerto nunca certifica
 * nada sozinho: o veredito continua saindo dos testes executados.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PersistedImportEntry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly hash: string;
  readonly specifiers: readonly string[];
}

const STORE_VERSION = 1;
let configuredDir: string | null | undefined;

/** `null` desliga a persistência; `undefined` volta ao padrão. */
export function configureImportStoreDir(dir: string | null | undefined): void {
  configuredDir = dir;
}

function storeDir(): string | null {
  if (configuredDir !== undefined) return configuredDir;
  const fromEnv = process.env.NEXUS_REGRESSION_IMPORT_CACHE_DIR;
  if (fromEnv) return fromEnv;
  // Testes sem diretório explícito não gravam em tmpdir compartilhado.
  if (process.env.VITEST) return null;
  return path.join(os.tmpdir(), 'nexus-regression-gate-imports');
}

export function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

function fileFor(dir: string, root: string): string {
  return path.join(dir, `${createHash('sha1').update(root).digest('hex').slice(0, 24)}.json`);
}

export function loadImportStore(root: string): Map<string, PersistedImportEntry> {
  const out = new Map<string, PersistedImportEntry>();
  const dir = storeDir();
  if (!dir) return out;
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(dir, root), 'utf8')) as {
      v?: number;
      root?: string;
      files?: Record<string, { s: number; m: number; h: string; i: string[] }>;
    };
    if (raw.v !== STORE_VERSION || raw.root !== root || !raw.files) return out;
    for (const [rel, e] of Object.entries(raw.files)) {
      if (typeof e?.s === 'number' && typeof e.m === 'number' && typeof e.h === 'string' && Array.isArray(e.i)) {
        out.set(rel, { size: e.s, mtimeMs: e.m, hash: e.h, specifiers: e.i.filter((x) => typeof x === 'string') });
      }
    }
  } catch {
    // sem cache ou ilegível: começa do zero
  }
  return out;
}

export async function saveImportStore(root: string, entries: ReadonlyMap<string, PersistedImportEntry>): Promise<void> {
  const dir = storeDir();
  if (!dir) return;
  try {
    const files: Record<string, { s: number; m: number; h: string; i: readonly string[] }> = {};
    for (const [rel, e] of entries) files[rel] = { s: e.size, m: e.mtimeMs, h: e.hash, i: e.specifiers };
    await fs.promises.mkdir(dir, { recursive: true });
    const target = fileFor(dir, root);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify({ v: STORE_VERSION, root, files }));
    await fs.promises.rename(tmp, target);
  } catch {
    // best effort: o cache em memória continua valendo
  }
}
