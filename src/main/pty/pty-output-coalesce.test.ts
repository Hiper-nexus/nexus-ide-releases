// #17 da auditoria de velocidade: o push de saída do PTY ao renderer coalesce
// chunks pausados em UMA mensagem (faixa de sequências), sem furar a janela de
// ACK, sem reordenar, perder ou duplicar bytes. Harness copiado de
// pty-output-wire.budget.test.ts; o "renderer" usa o PtyGapBuffer real do preload.
import { resetLicensedAccessMock } from '../__tests__/licensed-access';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { PTY_CHANNELS } from '../../shared/channels';
import { PtyGapBuffer } from '../../preload/pty-gap-buffer';
import type { PtyProcHandle, PtySessionHandlers } from './pty-host-core';
import {
  __resetPtyShutdownLifecycleForTests,
  acknowledgeSessionOutput,
  orchTerminateSession,
  PTY_PUSH_COALESCE,
  recoverSessionOutput,
  setPtyHost,
  spawnSession,
} from './pty-manager';

vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);

beforeEach(resetLicensedAccessMock);
afterEach(() => {
  vi.useRealTimers();
  __resetPtyShutdownLifecycleForTests();
});

interface WireEvent { sessionId: string; data: string; sequence: number; firstSequence?: number }
interface Spawned { sessionId: string; handlers: PtySessionHandlers; send: ReturnType<typeof vi.fn>; owner: WebContents }

function spawnShell(): Spawned {
  let handlers: PtySessionHandlers | null = null;
  const proc: PtyProcHandle = {
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    terminate: vi.fn(async () => { handlers?.onExit(0); return { ok: true, rootExited: true, descendantsExited: true }; }),
  };
  setPtyHost({ spawn(_spec, next) { handlers = next; return proc; } });
  const send = vi.fn();
  const owner = { isDestroyed: () => false, isCrashed: () => false, send } as unknown as WebContents;
  const cwd = fs.realpathSync(process.cwd());
  const { sessionId } = spawnSession(owner, { kind: 'shell', cols: 80, rows: 24 }, {
    cwd, shell: '/bin/zsh',
    scope: { version: 1, installationId: 'installation-coalesce', projectId: 'project-coalesce', checkoutId: 'checkout-coalesce', rootRealPath: cwd, identitySource: 'provisional' },
  });
  return { sessionId, handlers: handlers!, send, owner };
}

const dataEvents = (shell: Spawned): WireEvent[] =>
  shell.send.mock.calls.filter(([channel]) => channel === PTY_CHANNELS.data).map(([, payload]) => payload as WireEvent);

/** Renderer fiel ao preload: gap buffer real, um ack por chunk entregue. */
function renderer(shell: Spawned) {
  const gap = new PtyGapBuffer();
  let cursor = 0;
  let text = '';
  return {
    get text() { return text; },
    /** Entrega o que o Main enviou desde a última volta e confirma, como um RTT. */
    roundTrip(options: { ack?: boolean } = {}): number {
      const events = dataEvents(shell).slice(cursor);
      cursor += events.length;
      for (const event of events) {
        for (const chunk of gap.push(event.sequence, event.data, event.firstSequence).chunks) {
          text += chunk.data;
          if (options.ack !== false) acknowledgeSessionOutput(shell.owner, shell.sessionId, chunk.sequence);
        }
      }
      return events.length;
    },
    /** O pull periódico de 15 s / pty.replay da adoção: recover a partir do high-water do preload. */
    pull(options: { ack?: boolean } = {}): number {
      const events = recoverSessionOutput(shell.owner, shell.sessionId, gap.highWater);
      for (const event of events) {
        for (const chunk of gap.push(event.sequence, event.data).chunks) {
          text += chunk.data;
          if (options.ack !== false) acknowledgeSessionOutput(shell.owner, shell.sessionId, chunk.sequence);
        }
      }
      return events.length;
    },
    get highWater() { return gap.highWater; },
  };
}

async function finish(shell: Spawned): Promise<void> {
  const exited = orchTerminateSession(shell.sessionId);
  await vi.runAllTimersAsync();
  await expect(exited).resolves.toBe(true);
}

const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
const chunkOf = (i: number) => `${String(i).padStart(5, '0')}:${'m'.repeat(73)}\n`;

describe('coalescência do push de saída do PTY (#17)', () => {
  it('2000 micro-chunks com RTT de ack: tudo chega em ordem, sem perda nem duplicata, em poucas mensagens e voltas', async () => {
    fakeClock();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shell = spawnShell();
    const view = renderer(shell);
    let expected = '';
    for (let i = 0; i < 2_000; i += 1) { const chunk = chunkOf(i); expected += chunk; shell.handlers.onData(chunk); }

    let rounds = 0;
    while (view.text.length < expected.length && rounds < 500) {
      vi.advanceTimersByTime(PTY_PUSH_COALESCE.windowMs);
      view.roundTrip();
      rounds += 1;
    }
    const events = dataEvents(shell);
    console.info('[perf-budget] pty-push coalesce', JSON.stringify({ chunks: 2_000, bytes: expected.length, sends: events.length, ackRoundTrips: rounds }));

    expect(view.text).toBe(expected);
    // Faixas crescentes, contíguas e sem sobreposição.
    let next = 1;
    for (const event of events) {
      expect(event.firstSequence ?? event.sequence).toBe(next);
      next = event.sequence + 1;
    }
    expect(next).toBe(2_001);
    // Antes: 2000 mensagens e 250 voltas (8 por RTT).
    expect(events.length).toBeLessThanOrEqual(20);
    expect(rounds).toBeLessThanOrEqual(8);
    await finish(shell);
  });

  it('renderer que não confirma: no máximo 8 mensagens e 64 KiB em voo, mesmo coalescendo', async () => {
    fakeClock();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shell = spawnShell();
    for (let i = 0; i < 4_000; i += 1) shell.handlers.onData(chunkOf(i));
    vi.advanceTimersByTime(PTY_PUSH_COALESCE.windowMs * 10);
    const events = dataEvents(shell);
    const chars = events.reduce((sum, event) => sum + event.data.length, 0);
    console.info('[perf-budget] pty-push unacked', JSON.stringify({ sends: events.length, chars }));
    expect(events.length).toBeLessThanOrEqual(8);
    // A janela confere antes de enviar: o último chunk pode passar do teto, nunca mais que ele.
    expect(chars).toBeLessThanOrEqual(64 * 1024 + chunkOf(0).length);
    // O que ficou retido segue puxável, chunk a chunk, pelo recover.
    const pulled = recoverSessionOutput(shell.owner, shell.sessionId, 0);
    expect(pulled).toHaveLength(4_000);
    expect(pulled.map((event) => event.sequence)).toEqual(Array.from({ length: 4_000 }, (_, i) => i + 1));
    await finish(shell);
  });

  it('o primeiro chunk depois do idle sai na hora; o excesso espera a janela curta', async () => {
    fakeClock();
    const shell = spawnShell();
    shell.handlers.onData('a');
    shell.handlers.onData('b');
    expect(dataEvents(shell).map((event) => [event.sequence, event.data])).toEqual([[1, 'a'], [2, 'b']]);
    shell.handlers.onData('c');
    shell.handlers.onData('d');
    expect(dataEvents(shell)).toHaveLength(2);
    vi.advanceTimersByTime(PTY_PUSH_COALESCE.windowMs);
    expect(dataEvents(shell).slice(2)).toEqual([{ sessionId: shell.sessionId, data: 'cd', sequence: 4, firstSequence: 3 }]);
    await finish(shell);
  });

  it('uma mensagem coalescida nunca passa de 64 KiB e o byte-limite empurra sem esperar o timer', async () => {
    fakeClock();
    const shell = spawnShell();
    const big = 'x'.repeat(20 * 1024);
    shell.handlers.onData('a');
    shell.handlers.onData('b');
    shell.handlers.onData(big); // retido
    expect(dataEvents(shell)).toHaveLength(2);
    shell.handlers.onData(big); // 40 KiB retidos >= flushChars: sai já, sem timer
    const last = dataEvents(shell).at(-1)!;
    expect(dataEvents(shell)).toHaveLength(3);
    expect(last.data.length).toBe(2 * big.length);
    expect(last.firstSequence).toBe(3);
    expect(last.data.length).toBeLessThanOrEqual(PTY_PUSH_COALESCE.maxChars);
    await finish(shell);
  });

  it('ack no meio de uma faixa coalescida não duplica nem perde bytes', async () => {
    fakeClock();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shell = spawnShell();
    let expected = '';
    for (let i = 0; i < 30; i += 1) { const chunk = chunkOf(i); expected += chunk; shell.handlers.onData(chunk); }
    vi.advanceTimersByTime(PTY_PUSH_COALESCE.windowMs);
    const range = dataEvents(shell).at(-1)!;
    expect(range.firstSequence).toBeDefined();
    const middle = Math.floor((range.firstSequence! + range.sequence) / 2);
    acknowledgeSessionOutput(shell.owner, shell.sessionId, middle);
    shell.handlers.onData('fim\n');
    expected += 'fim\n';
    const view = renderer(shell);
    for (let guard = 0; guard < 20 && view.text.length < expected.length; guard += 1) {
      vi.advanceTimersByTime(PTY_PUSH_COALESCE.windowMs);
      view.roundTrip();
    }
    expect(view.text).toBe(expected);
    await finish(shell);
  });

  it('saída do processo despeja o resto retido, em ordem, antes do pty:exit', async () => {
    fakeClock();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shell = spawnShell();
    let expected = '';
    for (let i = 0; i < 300; i += 1) { const chunk = chunkOf(i); expected += chunk; shell.handlers.onData(chunk); }
    await finish(shell);
    const calls = shell.send.mock.calls.map(([channel]) => channel);
    const lastData = calls.lastIndexOf(PTY_CHANNELS.data);
    expect(lastData).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf(PTY_CHANNELS.exit)).toBeGreaterThan(lastData);
    expect(dataEvents(shell).map((event) => event.data).join('')).toBe(expected);
  });

  it('recover entrega os retidos, sai mais saída e o processo morre antes do ack: o renderer fecha com o texto completo', async () => {
    fakeClock();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shell = spawnShell();
    const view = renderer(shell);
    let expected = '';
    const emit = (from: number, to: number) => {
      for (let i = from; i <= to; i += 1) { const chunk = chunkOf(i); expected += chunk; shell.handlers.onData(chunk); }
    };
    emit(1, 5); // 1 e 2 saem direto; 3..5 ficam retidos atrás de 2 mensagens em voo
    view.roundTrip({ ack: false });
    expect(view.highWater).toBe(2);
    // O pull de 15 s traz 3..5; o ack do preload ainda está a caminho do Main.
    expect(view.pull({ ack: false })).toBe(3);
    expect(view.highWater).toBe(5);
    emit(6, 7); // 6 e 7 chegam retidos e o processo sai antes do ack de 5
    await finish(shell);
    view.roundTrip({ ack: false });
    expect(view.text).toBe(expected);
  });

  it('o que o recover já entregou não volta numa faixa: saída nova antes do ack sai só com sequências novas', async () => {
    fakeClock();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shell = spawnShell();
    const view = renderer(shell);
    for (let i = 1; i <= 5; i += 1) shell.handlers.onData(chunkOf(i));
    view.roundTrip({ ack: false });
    view.pull({ ack: false });
    expect(view.highWater).toBe(5);
    const sentBefore = dataEvents(shell).length;
    shell.handlers.onData(chunkOf(6));
    vi.advanceTimersByTime(PTY_PUSH_COALESCE.windowMs * 3);
    const fresh = dataEvents(shell).slice(sentBefore);
    expect(fresh.length).toBeGreaterThan(0);
    // Uma faixa 3..6 cruzaria o high-water 5 do preload: seria descartada inteira (e recuperada por mais um pull).
    for (const event of fresh) expect(event.firstSequence ?? event.sequence).toBeGreaterThan(5);
    await finish(shell);
  });
});
