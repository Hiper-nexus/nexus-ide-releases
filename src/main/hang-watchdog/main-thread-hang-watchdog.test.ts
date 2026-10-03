import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HANG_WATCHDOG_WORKER_SOURCE,
  startMainThreadHangWatchdog,
  type HangWatchdogHandle,
} from './main-thread-hang-watchdog';
import type { HangProfileFrame, HangWatchdogRecord } from './hang-watchdog-logic';

/**
 * F-764 A.1 — prova com Worker REAL, inspector REAL e o MESMO código que vai
 * no bundle: a main thread fica presa num laço síncrono (que nunca devolve o
 * controle ao event loop) e, mesmo assim, a worker liga o Profiler, para e
 * grava o `.cpuprofile` — porque as mensagens do inspector chegam à main por
 * interrupção do V8, inclusive no meio de uma regex.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A regex do limit-detector ANTES da correção do F-764: cúbica em tela de TUI em branco. */
const CUBIC_LIMIT_RE = /^[\s⎿│]*(?:claude|error:?)?\s*usage limit reached/im;

/**
 * O laço que trava a main. Só sai depois de `minMs` E de ver (lendo o disco
 * de forma síncrona, sem ceder o loop) que a worker já gravou o profile —
 * ou no teto `maxMs`.
 */
function nexusHangTestBusyLoop(input: {
  readonly minMs: number;
  readonly maxMs: number;
  readonly profileWritten: () => boolean;
}): { spins: number; sawProfileWhileBlocked: boolean; elapsedMs: number } {
  const startedAt = Date.now();
  const blankTuiScreen = `${' \n'.repeat(600)}x`;
  let spins = 0;
  let sawProfileWhileBlocked = false;
  while (Date.now() - startedAt < input.maxMs) {
    CUBIC_LIMIT_RE.exec(blankTuiScreen);
    spins += 1;
    if (!sawProfileWhileBlocked) sawProfileWhileBlocked = input.profileWritten();
    if (sawProfileWhileBlocked && Date.now() - startedAt >= input.minMs) break;
  }
  return { spins, sawProfileWhileBlocked, elapsedMs: Date.now() - startedAt };
}

function readRecords(logsDir: string): Array<Record<string, unknown>> {
  try {
    return fs
      .readFileSync(path.join(logsDir, 'main-hang.ndjson'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condição não chegou no prazo');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Top frame por amostras próprias, contado direto do arquivo (independente da worker). */
function topSelfFrame(profile: {
  nodes: Array<{ id: number; callFrame: { functionName: string } }>;
  samples: number[];
}): string | undefined {
  const counts = new Map<number, number>();
  for (const id of profile.samples) counts.set(id, (counts.get(id) ?? 0) + 1);
  const names = new Map(profile.nodes.map((node) => [node.id, node.callFrame.functionName]));
  const byName = new Map<string, number>();
  for (const [id, count] of counts) {
    const name = names.get(id) ?? '';
    if (name === '(root)' || name === '(idle)') continue;
    byName.set(name, (byName.get(name) ?? 0) + count);
  }
  return [...byName.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

let handle: HangWatchdogHandle | null = null;
let logsDir: string | null = null;

afterEach(async () => {
  await handle?.stop();
  handle = null;
  if (logsDir) fs.rmSync(logsDir, { recursive: true, force: true });
  logsDir = null;
});

describe('watchdog da main thread com inspector real (F-764 A.1)', () => {
  it('embute a worker verbatim: o texto que roda é o arquivo .cjs', () => {
    expect(HANG_WATCHDOG_WORKER_SOURCE).toBe(
      fs.readFileSync(path.join(HERE, 'hang-watchdog-worker.cjs'), 'utf8'),
    );
  });

  it('main presa numa regex catastrófica: o .cpuprofile sai DURANTE o travamento com a função do laço no topo', async () => {
    // connectToMainThread perfila a thread principal do processo: o teste
    // precisa estar nela (pool `forks`, o padrão do vitest).
    expect(isMainThread).toBe(true);
    logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-hang-watchdog-'));
    const dir = logsDir;
    const received: HangWatchdogRecord[] = [];
    handle = startMainThreadHangWatchdog({
      logsDir: dir,
      version: '0.0.0-test',
      heartbeatMs: 50,
      tuning: {
        thresholdMs: 500,
        checkIntervalMs: 50,
        profileDurationMs: 1_000,
        inspectorTimeoutMs: 8_000,
      },
      onRecord: (record) => received.push(record),
    });
    expect(handle).not.toBeNull();
    // O monitor de event-loop (A.3) manda o último resumo; ele sai na linha do travamento.
    handle?.reportEventLoop({ windowMs: 30_000, p50Ms: 1.2, p99Ms: 340, maxMs: 1_900, liveAgents: 12 });
    // Heartbeats correndo antes do travamento.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const loop = nexusHangTestBusyLoop({
      minMs: 2_500,
      maxMs: 15_000,
      profileWritten: () => readRecords(dir).some((r) => r.kind === 'main-thread-hang-profile'),
    });
    const loopEndedAt = Date.now();

    // A worker conseguiu tudo com a main sem ceder o event loop uma única vez.
    expect(loop.sawProfileWhileBlocked).toBe(true);
    const records = readRecords(dir);
    const hang = records.find((r) => r.kind === 'main-thread-hang');
    const profileRecord = records.find((r) => r.kind === 'main-thread-hang-profile');
    expect(hang?.hangDurationMs).toBeGreaterThan(500);
    expect(hang?.eventLoop).toEqual({ windowMs: 30_000, p50Ms: 1.2, p99Ms: 340, maxMs: 1_900, liveAgents: 12 });
    expect(profileRecord?.profilerUnavailable).toBeUndefined();
    expect(profileRecord?.capturedAt as number).toBeLessThan(loopEndedAt);
    expect(profileRecord?.sampleCount as number).toBeGreaterThan(100);

    const top = (profileRecord?.topFrames as HangProfileFrame[] | undefined)?.[0];
    expect(top?.functionName).toBe('nexusHangTestBusyLoop');
    expect(top?.url).toContain('main-thread-hang-watchdog.test.ts');
    expect(top?.selfPercent).toBeGreaterThan(50);

    // O arquivo é um .cpuprofile válido (abre no DevTools) e diz o mesmo.
    const profileFile = profileRecord?.profileFile as string;
    expect(profileFile).toMatch(/^main-hang-.+\.cpuprofile$/);
    const profile = JSON.parse(fs.readFileSync(path.join(dir, profileFile), 'utf8'));
    expect(Array.isArray(profile.nodes) && Array.isArray(profile.samples)).toBe(true);
    expect(topSelfFrame(profile)).toBe('nexusHangTestBusyLoop');

    // Main de volta: o heartbeat fecha o episódio e o main recebe as linhas.
    const recovered = await waitFor(
      () => readRecords(dir).find((r) => r.kind === 'main-thread-hang-recovered'),
      5_000,
    );
    expect(recovered.hangDurationMs as number).toBeGreaterThanOrEqual(loop.elapsedMs - 100);
    await waitFor(() => (received.length >= 3 ? true : undefined), 5_000);
    expect(received.map((record) => record.kind)).toEqual([
      'main-thread-hang',
      'main-thread-hang-profile',
      'main-thread-hang-recovered',
    ]);
  }, 40_000);
});
