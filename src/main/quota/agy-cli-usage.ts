import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { QuotaWindow } from '../../shared/quota-types';
import { claudeCliDeclaresMarker } from '../adapters/managed-claude-auth';
import { parseAgyQuotaSummary } from './agy-bridge';

const CLI_TIMEOUT_MS = 20_000;
const CLI_MAX_OUTPUT_BYTES = 1024 * 1024;
// Embedded changelog capability: older print mode must never turn /quota into a model prompt.
const READ_ONLY_PRINT_MARKER = 'non-interactive answers for the read-only slash commands';
const CLI_ARGS = ['--print', '/quota', '--output-format', 'json', '--print-timeout', '15s'];
const quotaOutput = z.object({
  status: z.literal('SUCCESS'),
  num_turns: z.literal(0),
  command: z.object({
    name: z.enum(['usage', 'quota']),
    data: z.object({ groups: z.array(z.object({
      name: z.string(),
      buckets: z.array(z.object({
        id: z.string(), name: z.string(), window: z.enum(['weekly', '5h']),
        remaining_fraction: z.number().min(0).max(1),
        reset_time: z.string().optional(),
      })),
    })) }),
  }),
});

/** Read-only slash command envelope; no rounded TSV or generated prose as evidence. */
export function parseAgyCliUsage(output: string, now = Date.now()): QuotaWindow[] {
  try {
    const parsed = quotaOutput.safeParse(JSON.parse(output));
    if (!parsed.success) return [];
    return parseAgyQuotaSummary({ groups: parsed.data.command.data.groups.map((group) => ({
      displayName: group.name,
      buckets: group.buckets.map((bucket) => ({
        bucketId: bucket.id, displayName: bucket.name, window: bucket.window,
        remainingFraction: bucket.remaining_fraction, resetTime: bucket.reset_time,
      })),
    })) }, now);
  } catch { return []; }
}

function locateBinary(): string | null {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'agy'),
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
  ];
  // O instalador Windows põe o mesmo `agy` do Mac em %LOCALAPPDATA%\agy\bin.
  // Sem este caminho a cota nativa (agy --print /quota) nunca roda aqui.
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) {
      candidates.unshift(
        path.join(local, 'agy', 'bin', 'agy.exe'),
        path.join(local, 'agy', 'bin', 'agy.cmd'),
      );
    }
  }
  const mode = process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, mode); return candidate; }
    catch { /* Try the next native installation location. */ }
  }
  return null;
}

/** Native account only. CLI owns its login; no token extraction or independent refresh. */
export async function fetchAgyCliUsageWindows(opts: { binary?: string; timeoutMs?: number; now?: number } = {}): Promise<QuotaWindow[] | null> {
  const binary = opts.binary ?? locateBinary();
  if (!binary) return null;
  try {
    // Reuse the bounded, mtime-cached binary marker scanner.
    if (!claudeCliDeclaresMarker(binary, READ_ONLY_PRINT_MARKER)) return null;
    const output = await new Promise<string | null>((resolve) => {
      execFile(binary, CLI_ARGS, {
        cwd: os.tmpdir(), timeout: opts.timeoutMs ?? CLI_TIMEOUT_MS,
        killSignal: 'SIGKILL', maxBuffer: CLI_MAX_OUTPUT_BYTES,
        encoding: 'utf8', windowsHide: true,
      }, (error, stdout) => resolve(error ? null : stdout));
    });
    if (!output) return null;
    const windows = parseAgyCliUsage(output, opts.now);
    return windows.length ? windows : null;
  } catch { return null; }
}
