import fs from 'node:fs';
import path from 'node:path';
import type { CliHistoryImportCounts } from '../../shared/cli-history';
import type { CreateCommandBlockInput } from '../../shared/command-block';
import {
  adaptImportedCommandBlock,
  cliHistorySessionId,
  type CliHistoryAdaptTarget,
} from './cli-history-adapter';
import { importCliHistoryBlocks } from './cli-history-import';

/**
 * Serviço de importação do histórico das CLIs (F-1171): varre
 * `<userData>/provider-state/<adapter>/<checkoutId>/**.jsonl` do escopo do
 * pane, adapta e grava no `command_blocks` do projeto.
 *
 * - Só o checkout do escopo: transcripts de outro projeto nunca entram.
 * - Assíncrono e fatiado: I/O em `fs.promises` e cessão do event loop entre
 *   arquivos e a cada lote de inserts — o main nunca fica preso na varredura.
 * - Tetos de arquivos, bytes por arquivo e comandos por importação.
 * - Linha ruim, arquivo ilegível ou insert recusado contam e seguem.
 */

export interface CliHistoryImportServiceDeps {
  readonly userDataPath: string;
  readonly checkoutId: string;
  readonly target: CliHistoryAdaptTarget;
  /** cwd usado quando o transcript não traz o diretório da chamada. */
  readonly fallbackCwd: string;
  /** Grava um bloco; `true` = novo, `false` = chave já existia. Pode lançar. */
  readonly insert: (input: CreateCommandBlockInput) => boolean;
  readonly maxFiles?: number;
  readonly maxBytesPerFile?: number;
  readonly maxBlocks?: number;
  readonly readFile?: (file: string) => Promise<string>;
  readonly yieldToLoop?: () => Promise<void>;
}

const MAX_FILES_DEFAULT = 200;
const MAX_BYTES_DEFAULT = 8 * 1024 * 1024;
/** Abaixo da retenção (5 000): import não empurra o gravado para fora. */
const MAX_BLOCKS_DEFAULT = 2_000;
const MAX_DEPTH = 12;
const INSERTS_PER_SLICE = 200;
const CHECKOUT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

const defaultYield = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

interface TranscriptFile {
  readonly adapterId: string;
  readonly base: string;
  readonly file: string;
}

async function readDirSorted(dir: string): Promise<fs.Dirent[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Lista até `limit` transcripts; symlinks nunca são seguidos. */
async function listTranscripts(
  root: string,
  checkoutId: string,
  limit: number,
): Promise<TranscriptFile[]> {
  const out: TranscriptFile[] = [];
  for (const adapter of await readDirSorted(root)) {
    if (out.length >= limit) break;
    if (!adapter.isDirectory()) continue;
    const base = path.join(root, adapter.name, checkoutId);
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) return;
      for (const entry of await readDirSorted(dir)) {
        if (out.length >= limit) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          out.push({ adapterId: adapter.name, base, file: full });
        }
      }
    };
    await walk(base, 0);
  }
  return out;
}

export async function importCliHistoryForScope(
  deps: CliHistoryImportServiceDeps,
): Promise<CliHistoryImportCounts> {
  const maxFiles = Math.max(1, deps.maxFiles ?? MAX_FILES_DEFAULT);
  const maxBytes = Math.max(1, deps.maxBytesPerFile ?? MAX_BYTES_DEFAULT);
  const maxBlocks = Math.max(1, deps.maxBlocks ?? MAX_BLOCKS_DEFAULT);
  const readFile = deps.readFile ?? ((file: string) => fs.promises.readFile(file, 'utf8'));
  const yieldToLoop = deps.yieldToLoop ?? defaultYield;

  let files = 0;
  let filesSkipped = 0;
  let found = 0;
  let imported = 0;
  let duplicates = 0;
  let skipped = 0;
  let capped = false;
  const counts = (): CliHistoryImportCounts => ({
    files,
    filesSkipped,
    found,
    imported,
    duplicates,
    skipped,
    capped,
  });

  if (!CHECKOUT_ID.test(deps.checkoutId)) return counts();
  const root = path.join(deps.userDataPath, 'provider-state');
  // +1 só para saber se o teto cortou a lista.
  const transcripts = await listTranscripts(root, deps.checkoutId, maxFiles + 1);
  if (transcripts.length > maxFiles) {
    capped = true;
    transcripts.length = maxFiles;
  }

  let sinceYield = 0;
  for (const transcript of transcripts) {
    await yieldToLoop();
    if (imported + duplicates >= maxBlocks) {
      capped = true;
      break;
    }
    let jsonl: string;
    try {
      const stat = await fs.promises.stat(transcript.file);
      if (stat.size > maxBytes) {
        filesSkipped += 1;
        continue;
      }
      jsonl = await readFile(transcript.file);
    } catch {
      filesSkipped += 1;
      continue;
    }
    files += 1;
    const sessionId = cliHistorySessionId(
      transcript.adapterId,
      path.relative(transcript.base, transcript.file),
    );
    const blocks = importCliHistoryBlocks(jsonl, {
      sessionId,
      cwd: deps.fallbackCwd,
    });
    found += blocks.length;
    for (const block of blocks) {
      if (imported + duplicates >= maxBlocks) {
        capped = true;
        skipped += 1;
        continue;
      }
      const input = adaptImportedCommandBlock(block, deps.target);
      if (!input) {
        skipped += 1;
        continue;
      }
      try {
        if (deps.insert(input)) imported += 1;
        else duplicates += 1;
      } catch {
        skipped += 1;
      }
      sinceYield += 1;
      if (sinceYield >= INSERTS_PER_SLICE) {
        sinceYield = 0;
        await yieldToLoop();
      }
    }
  }
  return counts();
}
