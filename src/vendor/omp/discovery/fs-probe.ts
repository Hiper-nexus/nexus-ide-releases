/**
 * Derivado de oh-my-pi (omp) — packages/coding-agent/src/capability/fs.ts
 * https://github.com/can1357/oh-my-pi @ 03c48d073bd4849726cc14750b5aecfa310bdf26 (MIT)
 * Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük — ver NOTICE.
 *
 * Adaptação NexusIDE: o cache de conteúdo global do omp vira um FsProbe por
 * varredura que grava o mtime de cada caminho tocado (arquivo, diretório ou
 * ausência). O consumidor usa esse fingerprint para invalidação barata:
 * re-stat de um conjunto pequeno de caminhos em vez de reler tudo.
 * O walker recursivo substitui o glob nativo do omp, com limite de
 * profundidade e skip de node_modules/.git.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Mesmo teto do mcp-hub (leituras de config nunca passam disso). */
const MAX_FILE_BYTES = 2_000_000;

/** Limite de profundidade da varredura recursiva (a partir do dir base). */
const MAX_WALK_DEPTH = 6;

/** Diretórios nunca visitados pela varredura recursiva. */
const SKIPPED_DIR_NAMES = new Set(['node_modules', '.git']);

export type FsFingerprint = ReadonlyMap<string, number | null>;

export interface WalkOptions {
  /** Extensões aceitas, sem ponto (ex.: ['md', 'mdc']). */
  extensions: readonly string[];
  /** Recursão em subdiretórios (limitada por MAX_WALK_DEPTH). */
  recursive: boolean;
}

export class FsProbe {
  /** mtimeMs por caminho absoluto; null = caminho inexistente/ilegível. */
  private readonly stamps = new Map<string, number | null>();

  /**
   * stat + registro no fingerprint. `stat` segue symlinks de propósito
   * (paridade omp: CLAUDE.md -> AGENTS.md via symlink continua resolvendo;
   * FIFOs/sockets são rejeitados pelo isFile() dos chamadores).
   */
  private recordStat(absPath: string): fs.Stats | null {
    try {
      const st = fs.statSync(absPath);
      this.stamps.set(absPath, st.mtimeMs);
      return st;
    } catch {
      this.stamps.set(absPath, null);
      return null;
    }
  }

  /** Existe como arquivo regular? (registra no fingerprint) */
  fileExists(filePath: string): boolean {
    const st = this.recordStat(path.resolve(filePath));
    return st?.isFile() ?? false;
  }

  /** 'file' | 'dir' | null, registrando no fingerprint. */
  statKind(filePath: string): 'file' | 'dir' | null {
    const st = this.recordStat(path.resolve(filePath));
    if (!st) return null;
    if (st.isFile()) return 'file';
    if (st.isDirectory()) return 'dir';
    return null;
  }

  /** Conteúdo do arquivo, ou null (ausente, não-regular ou grande demais). */
  readTextFile(filePath: string): string | null {
    const abs = path.resolve(filePath);
    const st = this.recordStat(abs);
    if (!st?.isFile() || st.size > MAX_FILE_BYTES) return null;
    try {
      return fs.readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
  }

  /** Entradas do diretório (vazio quando ausente), registrando o mtime dele. */
  readDirEntries(dirPath: string): fs.Dirent[] {
    const abs = path.resolve(dirPath);
    const st = this.recordStat(abs);
    if (!st?.isDirectory()) return [];
    try {
      return fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  /**
   * Lista arquivos por extensão sob `dir` (caminhos absolutos, ordenados).
   * Divergência do omp: nunca segue symlinks (padrão do skills-catalog do
   * Nexus) e pula entradas ocultas, node_modules e .git. Cada subdiretório
   * visitado entra no fingerprint — arquivo criado/removido muda o mtime do
   * pai e invalida o cache do consumidor.
   */
  walkFiles(dir: string, options: WalkOptions): string[] {
    const out: string[] = [];
    const suffixes = options.extensions.map((ext) => `.${ext}`);
    const walk = (current: string, depth: number): void => {
      if (depth > MAX_WALK_DEPTH) return;
      for (const entry of this.readDirEntries(current)) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isSymbolicLink()) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!options.recursive || SKIPPED_DIR_NAMES.has(entry.name)) continue;
          walk(full, depth + 1);
        } else if (
          entry.isFile() &&
          suffixes.some((suffix) => entry.name.endsWith(suffix))
        ) {
          out.push(full);
        }
      }
    };
    walk(path.resolve(dir), 0);
    return out.sort();
  }

  /** Snapshot de mtimes de tudo que a varredura tocou. */
  fingerprint(): FsFingerprint {
    return new Map(this.stamps);
  }
}

/**
 * Invalidação barata: o fingerprint continua válido se cada caminho tocado
 * ainda tem o mesmo mtime (ou continua ausente). Arquivo novo em caminho
 * antes ausente vira mtime ≠ null; arquivo novo dentro de diretório visitado
 * muda o mtime do diretório.
 */
export function fingerprintStillValid(fingerprint: FsFingerprint): boolean {
  for (const [absPath, mtimeMs] of fingerprint) {
    let current: number | null = null;
    try {
      current = fs.statSync(absPath).mtimeMs;
    } catch {
      current = null;
    }
    if (current !== mtimeMs) return false;
  }
  return true;
}
