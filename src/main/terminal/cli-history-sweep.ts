/**
 * Inspired by pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62 (no code copied).
 * Upstream reference: apps/server/src/claudeHistoryWorker.ts.
 * Nexus changes: Nexus bounded filesystem traversal/parser composition, no SDK worker copying and no production boot caller/persistence wiring.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  importCliHistoryBlocks,
  type ImportedCommandBlock,
} from './cli-history-import';

/**
 * Varredura de histórico de CLI (item T3 "importação de histórico de CLI").
 * Caminha `provider-state/<cli>/<checkout>/…/*.jsonl` e devolve os blocos de
 * comando importados. O caller decide onde gravar (`command-block-store`).
 */

export interface CliHistorySweepOptions {
  /** Raiz do userData (onde mora `provider-state`). */
  readonly userDataPath: string;
  readonly sessionId: string;
  readonly paneId?: string;
  readonly workspaceId?: string;
  readonly missionId?: string;
  readonly cwd?: string;
  readonly projectRoot?: string;
  readonly shell?: string;
  /** Teto de arquivos por varredura (defesa contra diretório gigante). */
  readonly maxFiles?: number;
  readonly maxBytesPerFile?: number;
}

export interface CliHistorySweepResult {
  readonly blocks: readonly ImportedCommandBlock[];
  readonly filesScanned: number;
  readonly filesSkipped: number;
}

const MAX_FILES_DEFAULT = 200;
const MAX_BYTES_DEFAULT = 8 * 1024 * 1024;

function walkJsonlFiles(root: string, maxFiles: number): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // provider-state/<cli>/<checkout>/…: só desce em árvores conhecidas.
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Varre o `provider-state` e importa os blocos de shell. Ignora arquivos
 * ilegíveis/gigantes sem abortar a varredura.
 */
export function sweepCliHistory(
  options: CliHistorySweepOptions,
): CliHistorySweepResult {
  const root = path.join(options.userDataPath, 'provider-state');
  const maxFiles = options.maxFiles ?? MAX_FILES_DEFAULT;
  const maxBytes = options.maxBytesPerFile ?? MAX_BYTES_DEFAULT;
  const blocks: ImportedCommandBlock[] = [];
  let filesScanned = 0;
  let filesSkipped = 0;
  if (!fs.existsSync(root)) {
    return { blocks, filesScanned, filesSkipped };
  }
  for (const file of walkJsonlFiles(root, maxFiles)) {
    try {
      const stat = fs.statSync(file);
      if (stat.size > maxBytes) {
        filesSkipped += 1;
        continue;
      }
      const jsonl = fs.readFileSync(file, 'utf8');
      blocks.push(
        ...importCliHistoryBlocks(jsonl, {
          sessionId: options.sessionId,
          ...(options.paneId ? { paneId: options.paneId } : {}),
          ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
          ...(options.missionId ? { missionId: options.missionId } : {}),
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
          ...(options.shell ? { shell: options.shell } : {}),
        }),
      );
      filesScanned += 1;
    } catch {
      filesSkipped += 1;
    }
  }
  return { blocks, filesScanned, filesSkipped };
}
