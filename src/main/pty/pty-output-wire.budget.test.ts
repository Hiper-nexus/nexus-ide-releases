// Inspired by pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62 (no code copied)
// Referência (T3 Code, MIT): só o método de
// packages/client-runtime/src/operations/commands.performance.test.ts (teto de
// bytes de wire por mensagem + teto de mensagens, CI falha quando passa), num
// teste do Nexus para o push de saída de PTY do Main ao renderer e para os taps do Main;
// harness de sessão copiado de pty-manager-tap-batching.test.ts.
import { resetLicensedAccessMock } from '../__tests__/licensed-access';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { PTY_CHANNELS } from '../../shared/channels';
import type { PtyProcHandle, PtySessionHandlers } from './pty-host-core';
import {
  __resetPtyShutdownLifecycleForTests,
  acknowledgeSessionOutput,
  orchTerminateSession,
  setPtyHost,
  spawnSession,
  tapSessionData,
} from './pty-manager';
import { PTY_TAP_BUDGET } from './pty-tap-dispatcher';

vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);

/**
 * QLT-01 — orçamento de wire da saída de PTY (Main → renderer e taps do Main).
 *
 * Tudo é contagem: mensagens `wc.send`, bytes de JSON por mensagem e entregas
 * aos taps, com relógio falso. Como mudar um teto: docs/perf-budgets.md.
 *
 * Tetos (valor medido no commit que criou o orçamento entre parênteses):
 * - dataSendsPerChunk (1): o renderer recebe cada chunk uma vez, com
 *   sequência própria.
 * - stateSendsPerBusyRun (1): a virada para busy sai uma vez por rajada, não
 *   a cada chunk (o guard `session.state !== "busy"` do pty-manager).
 * - envelopeBytesPerEvent (64; medido 53): o evento é só
 *   `{ sessionId, data, sequence }` — campo novo no envelope paga em toda
 *   mensagem de toda sessão. Folga de 11 bytes só para os dígitos do contador
 *   do sessionId e da sequência, que variam com a ordem dos testes.
 * - tapDeliveriesPerBurst (2): F-764 C.1 — os taps de dados recebem a rajada
 *   em lote (o 1º chunk na virada para busy + 1 lote de ≤ 16 ms / 32 KB), não
 *   chunk a chunk.
 * - unackedPushChars (524288 = 512 KiB): renderer que não drena pausa o push
 *   sem ack; a fila de IPC dentro do Main não cresce sem limite. Teto externo:
 *   quem segura de fato é a janela T3 abaixo (64 KiB em voo).
 * - pendingPushChunks (8) e pendingPushChars (65536 = 64 KiB): janela T3
 *   `OutputProtocol` — no máximo 8 chunks / 64 KiB em voo sem ack, para que
 *   rajadas de chunks minúsculos não encham o IPC do Electron (400×80 chars
 *   são 32 KiB, abaixo do teto de caracteres, mas 400 mensagens).
 */
const BUDGET = {
  dataSendsPerChunk: 1,
  stateSendsPerBusyRun: 1,
  envelopeBytesPerEvent: 64,
  tapDeliveriesPerBurst: 2,
  unackedPushChars: 512 * 1024,
  pendingPushChunks: 8,
  pendingPushChars: 64 * 1024,
} as const;

const BURST_CHUNKS = 400;
const CHUNK = `${'x'.repeat(79)}\n`;

beforeEach(resetLicensedAccessMock);

interface Spawned {
  readonly sessionId: string;
  readonly handlers: PtySessionHandlers;
  readonly send: ReturnType<typeof vi.fn>;
  readonly owner: WebContents;
}

const disposers: Array<() => void> = [];

afterEach(async () => {
  while (disposers.length > 0) disposers.pop()?.();
  vi.useRealTimers();
  __resetPtyShutdownLifecycleForTests();
});

function fakeClock(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
}

function spawnShell(): Spawned {
  let handlers: PtySessionHandlers | null = null;
  const proc: PtyProcHandle = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminate: vi.fn(async () => {
      handlers?.onExit(0);
      return { ok: true, rootExited: true, descendantsExited: true };
    }),
  };
  setPtyHost({
    spawn(_spec, next) {
      handlers = next;
      return proc;
    },
  });
  const send = vi.fn();
  const owner = { isDestroyed: () => false, isCrashed: () => false, send } as unknown as WebContents;
  const cwd = fs.realpathSync(process.cwd());
  const { sessionId } = spawnSession(
    owner,
    { kind: 'shell', cols: 80, rows: 24 },
    {
      cwd,
      shell: '/bin/zsh',
      scope: {
        version: 1,
        installationId: 'installation-wire-budget',
        projectId: 'project-wire-budget',
        checkoutId: 'checkout-wire-budget',
        rootRealPath: cwd,
        identitySource: 'provisional',
      },
    },
  );
  return { sessionId, handlers: handlers!, send, owner };
}

async function finish(shell: Spawned): Promise<void> {
  const exited = orchTerminateSession(shell.sessionId);
  await vi.runAllTimersAsync();
  await expect(exited).resolves.toBe(true);
}

function sendsOn(shell: Spawned, channel: string): unknown[] {
  return shell.send.mock.calls.filter(([sent]) => sent === channel).map(([, payload]) => payload);
}

const utf8 = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('orçamento de wire da saída de PTY (QLT-01)', () => {
  it(`rajada de ${BURST_CHUNKS} chunks: mensagens ao renderer, bytes de envelope e entregas aos taps`, async () => {
    fakeClock();
    const shell = spawnShell();
    let analysisDeliveries = 0;
    let completeDeliveries = 0;
    let delivered = '';
    disposers.push(
      tapSessionData((sessionId) => {
        if (sessionId === shell.sessionId) analysisDeliveries += 1;
      }, 'orcamento-analise'),
      tapSessionData((sessionId, data) => {
        if (sessionId !== shell.sessionId) return;
        completeDeliveries += 1;
        delivered += data;
      }, { name: 'orcamento-anel', delivery: 'complete' }),
    );

    for (let i = 0; i < BURST_CHUNKS; i += 1) shell.handlers.onData(CHUNK);
    vi.advanceTimersByTime(PTY_TAP_BUDGET.flushMs);

    const dataEvents = sendsOn(shell, PTY_CHANNELS.data) as Array<{ data: string }>;
    const stateEvents = sendsOn(shell, PTY_CHANNELS.stateChange);
    const envelopeBytes = Math.max(...dataEvents.map((event) => utf8(event) - utf8(event.data)));
    const work = {
      dataSends: dataEvents.length,
      stateSends: stateEvents.length,
      envelopeBytes,
      analysisDeliveries,
      completeDeliveries,
    };
    console.info('[perf-budget] pty-output burst', JSON.stringify(work));

    // O orçamento só vale se nada se perdeu no caminho.
    expect(delivered).toBe(CHUNK.repeat(BURST_CHUNKS));
    expect(work.dataSends).toBeLessThanOrEqual(BURST_CHUNKS * BUDGET.dataSendsPerChunk);
    expect(work.stateSends).toBeLessThanOrEqual(BUDGET.stateSendsPerBusyRun);
    expect(work.envelopeBytes).toBeLessThanOrEqual(BUDGET.envelopeBytesPerEvent);
    expect(work.analysisDeliveries).toBeLessThanOrEqual(BUDGET.tapDeliveriesPerBurst);
    expect(work.completeDeliveries).toBeLessThanOrEqual(BUDGET.tapDeliveriesPerBurst);
    await finish(shell);
  });

  it('renderer que não confirma: o push pausa no teto de saída sem ack', async () => {
    fakeClock();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shell = spawnShell();
    const chunk = `${'y'.repeat(1_023)}\n`;
    // 4 MiB sem nenhum ack: sem o teto, tudo iria para a fila de IPC do Main.
    for (let i = 0; i < 4_096; i += 1) shell.handlers.onData(chunk);

    const pushed = (sendsOn(shell, PTY_CHANNELS.data) as Array<{ data: string }>).reduce(
      (sum, event) => sum + event.data.length,
      0,
    );
    console.info('[perf-budget] pty-output unacked', JSON.stringify({ pushed }));
    expect(pushed).toBeLessThanOrEqual(BUDGET.unackedPushChars);
    await finish(shell);
  });

  it('janela T3 de ACK: no máximo 8 chunks / 64 KiB em voo sem confirmação', async () => {
    fakeClock();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shell = spawnShell();
    // Chunks minúsculos ficam ABAIXO do teto de caracteres (400×80 = 32 KiB)
    // mas estouram o teto de mensagens do OutputProtocol do T3.
    const tiny = `${'z'.repeat(79)}\n`;
    for (let i = 0; i < 400; i += 1) shell.handlers.onData(tiny);

    const events = sendsOn(shell, PTY_CHANNELS.data) as Array<{ sequence: number; data: string }>;
    const pushedChars = events.reduce((sum, event) => sum + event.data.length, 0);
    const work = { chunks: events.length, pushedChars };
    console.info('[perf-budget] pty-output pending-window', JSON.stringify(work));
    expect(work.chunks).toBeLessThanOrEqual(BUDGET.pendingPushChunks);
    expect(work.pushedChars).toBeLessThanOrEqual(BUDGET.pendingPushChars);

    // ACK dos 8 em voo reabre a janela: os PAUSADOS saem na hora, em ordem
    // (9..16), sem saída nova nem pull — e de novo no máximo 8 em voo. O chunk
    // ao vivo seguinte não fura a fila: espera atrás dos pausados.
    const last = events.at(-1)!;
    acknowledgeSessionOutput(shell.owner, shell.sessionId, last.sequence);
    const drained = (sendsOn(shell, PTY_CHANNELS.data) as Array<{ sequence: number }>)
      .slice(events.length)
      .map((event) => event.sequence);
    shell.handlers.onData(tiny);
    const afterAck = sendsOn(shell, PTY_CHANNELS.data).length;
    console.info('[perf-budget] pty-output pending-window-after-ack', JSON.stringify({ afterAck }));
    expect(drained).toEqual(Array.from({ length: BUDGET.pendingPushChunks }, (_, i) => last.sequence + 1 + i));
    expect(afterAck).toBe(events.length + BUDGET.pendingPushChunks);
    await finish(shell);
  });
});
