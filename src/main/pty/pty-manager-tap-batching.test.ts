import { resetLicensedAccessMock } from '../__tests__/licensed-access';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { PTY_CHANNELS } from '../../shared/channels';
import { setTraceDirectory, flushMainTrace } from '../observability/main-trace';
import type { PtyProcHandle, PtySessionHandlers } from './pty-host-core';
import {
  __resetPtyShutdownLifecycleForTests,
  orchTerminateSession,
  orchWriteSession,
  publishSessionActivityState,
  setPtyHost,
  spawnSession,
  tapSessionData,
  tapSessionExit,
  tapSessionInput,
  tapSessionState,
  tapSessionTermination,
} from './pty-manager';
import { PTY_TAP_BUDGET } from './pty-tap-dispatcher';

vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);

beforeEach(resetLicensedAccessMock);

/**
 * F-764 C.1 — o pty-manager entrega a saída aos taps de dados em lote, sem
 * mudar o que cada tap vê nem a ordem em relação aos eventos do Main.
 */

interface Spawned {
  readonly sessionId: string;
  readonly handlers: PtySessionHandlers;
  readonly proc: PtyProcHandle;
  readonly send: ReturnType<typeof vi.fn>;
}

const disposers: Array<() => void> = [];
const track = (dispose: () => void) => {
  disposers.push(dispose);
  return dispose;
};

afterEach(async () => {
  while (disposers.length > 0) disposers.pop()?.();
  vi.useRealTimers();
  __resetPtyShutdownLifecycleForTests();
});

/** Timers falsos com `performance.now` junto: o lote usa relógio monotônico. */
function fakeClock(): void {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
      'performance',
    ],
  });
}

/** Encerra a sessão até a prova física (o reset do lifecycle exige isso). */
async function finish(shell: Spawned, fake = true): Promise<void> {
  const exited = orchTerminateSession(shell.sessionId);
  if (fake) await vi.runAllTimersAsync();
  await expect(exited).resolves.toBe(true);
}

function spawnShell(): Spawned {
  let handlers: PtySessionHandlers | null = null;
  const proc: PtyProcHandle = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminate: vi.fn(async () => {
      // Prova física imediata: a raiz sai e o host confirma a árvore.
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
  const owner = {
    isDestroyed: () => false,
    isCrashed: () => false,
    send,
  } as unknown as WebContents;
  const cwd = fs.realpathSync(process.cwd());
  const { sessionId } = spawnSession(
    owner,
    { kind: 'shell', cols: 80, rows: 24 },
    {
      cwd,
      shell: '/bin/zsh',
      scope: {
        version: 1,
        installationId: 'installation-batching-test',
        projectId: 'project-batching-test',
        checkoutId: 'checkout-batching-test',
        rootRealPath: cwd,
        identitySource: 'provisional',
      },
    },
  );
  return { sessionId, handlers: handlers!, proc, send };
}

describe('pty-manager: taps de dados em lote (F-764 C.1)', () => {
  it('o primeiro chunk depois do idle sai na hora; os seguintes vão em lote', async () => {
    fakeClock();
    const shell = spawnShell();
    const seen: string[] = [];
    track(tapSessionData((sessionId, data) => {
      if (sessionId === shell.sessionId) seen.push(data);
    }, 'teste'));
    shell.handlers.onData('a');
    // spawning → busy: a virada esvazia o lote antes do estado.
    expect(seen).toEqual(['a']);
    shell.handlers.onData('b');
    shell.handlers.onData('c');
    expect(seen).toEqual(['a']);
    vi.advanceTimersByTime(PTY_TAP_BUDGET.flushMs);
    expect(seen).toEqual(['a', 'bc']);
    // O renderer continua recebendo chunk a chunk, com sequência própria.
    const pushes = shell.send.mock.calls.filter(([channel]) => channel === PTY_CHANNELS.data);
    expect(pushes.map(([, event]) => event.data)).toEqual(['a', 'b', 'c']);
    await finish(shell);
  });

  it('troca de estado esvazia o lote antes dos taps de estado', async () => {
    fakeClock();
    const shell = spawnShell();
    const log: string[] = [];
    track(tapSessionData((sessionId, data) => {
      if (sessionId === shell.sessionId) log.push(`dados:${data}`);
    }));
    track(tapSessionState((sessionId, state) => {
      if (sessionId === shell.sessionId) log.push(`estado:${state}`);
    }));
    shell.handlers.onData('a');
    shell.handlers.onData('b');
    shell.handlers.onData('c');
    publishSessionActivityState(shell.sessionId, 'idle');
    expect(log).toEqual(['dados:a', 'estado:busy', 'dados:bc', 'estado:idle']);
    await finish(shell);
  });

  it('escrita no PTY esvazia o lote antes da escrita e dos taps de entrada', async () => {
    fakeClock();
    const shell = spawnShell();
    const log: string[] = [];
    track(tapSessionData((sessionId, data) => {
      if (sessionId === shell.sessionId) log.push(`dados:${data}`);
    }));
    track(tapSessionInput((sessionId, data) => {
      if (sessionId === shell.sessionId) log.push(`entrada:${data}`);
    }));
    vi.mocked(shell.proc.write).mockImplementation((data: string) => {
      log.push(`escrita:${data}`);
    });
    shell.handlers.onData('eco');
    shell.handlers.onData(' da colagem');
    expect(orchWriteSession(shell.sessionId, '\r', { markInputBusy: false })).toBe(true);
    expect(log).toEqual(['dados:eco', 'dados: da colagem', 'escrita:\r', 'entrada:\r']);
    await finish(shell);
  });

  it('encerramento e saída: todo o texto chega antes dos taps de encerramento e de saída', async () => {
    fakeClock();
    const shell = spawnShell();
    const log: string[] = [];
    track(tapSessionData((sessionId, data) => {
      if (sessionId === shell.sessionId) log.push(`dados:${data}`);
    }));
    track(tapSessionTermination((sessionId) => {
      if (sessionId === shell.sessionId) log.push('encerramento');
    }));
    track(tapSessionExit((sessionId) => {
      if (sessionId === shell.sessionId) log.push('saída');
    }));
    shell.handlers.onData('a');
    shell.handlers.onData('PRONTO: fim');
    const exited = orchTerminateSession(shell.sessionId);
    await vi.runAllTimersAsync();
    await expect(exited).resolves.toBe(true);
    expect(log).toEqual(['dados:a', 'dados:PRONTO: fim', 'encerramento', 'saída']);
  });

  it('tap registrado agora não recebe saída que chegou antes do registro', async () => {
    fakeClock();
    const shell = spawnShell();
    const early: string[] = [];
    const late: string[] = [];
    track(tapSessionData((sessionId, data) => {
      if (sessionId === shell.sessionId) early.push(data);
    }));
    shell.handlers.onData('a');
    shell.handlers.onData('velho');
    track(tapSessionData((sessionId, data) => {
      if (sessionId === shell.sessionId) late.push(data);
    }));
    shell.handlers.onData('novo');
    vi.advanceTimersByTime(PTY_TAP_BUDGET.flushMs);
    expect(early).toEqual(['a', 'velho', 'novo']);
    expect(late).toEqual(['novo']);
    await finish(shell);
  });

  it('tap immediate recebe cada chunk na chegada', async () => {
    fakeClock();
    const shell = spawnShell();
    const chunks: string[] = [];
    track(tapSessionData((sessionId, data) => {
      if (sessionId === shell.sessionId) chunks.push(data);
    }, { name: 'portão', delivery: 'immediate' }));
    shell.handlers.onData('a');
    shell.handlers.onData('b');
    shell.handlers.onData('c');
    expect(chunks).toEqual(['a', 'b', 'c']);
    await finish(shell);
  });

  it('5 MB/s numa sessão: análise só com o tail, anel com tudo, trace pty-flood (F-764 C.2)', async () => {
    fakeClock();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f764-flood-trace-'));
    setTraceDirectory(dir);
    try {
      const shell = spawnShell();
      const analysis: number[] = [];
      const complete: string[] = [];
      track(tapSessionData((sessionId, data) => {
        if (sessionId === shell.sessionId) analysis.push(data.length);
      }, 'analise-teste'));
      track(tapSessionData((sessionId, data) => {
        if (sessionId === shell.sessionId) complete.push(data);
      }, { name: 'anel-teste', delivery: 'complete' }));
      const chunk = `${'y'.repeat(1_023)}\n`;
      // 2 s a 5 MB/s: 5 chunks de 1 KB por milissegundo.
      for (let ms = 0; ms < 2_000; ms += 1) {
        for (let i = 0; i < 5; i += 1) shell.handlers.onData(chunk);
        vi.advanceTimersByTime(1);
      }
      publishSessionActivityState(shell.sessionId, 'idle');
      const sentChars = 2_000 * 5 * chunk.length;
      expect(complete.join('').length).toBe(sentChars);
      const analysisChars = analysis.reduce((sum, size) => sum + size, 0);
      // Rajada de detecção (~512 KB) + 16 KB a cada 250 ms: bem menos que 10 MB.
      expect(analysisChars).toBeLessThan(
        PTY_TAP_BUDGET.floodEnterCharsPerSec + 12 * PTY_TAP_BUDGET.floodTailChars,
      );
      await flushMainTrace();
      const events = fs
        .readFileSync(path.join(dir, 'logs', 'main.trace.ndjson'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'pty-flood',
          sessionId: shell.sessionId,
          paneId: null,
          adapterId: null,
        }),
      );
      await finish(shell);
    } finally {
      await flushMainTrace();
      setTraceDirectory(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tap lento vira trace pty-tap-slow com o nome registrado', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f764-tap-trace-'));
    setTraceDirectory(dir);
    try {
      const shell = spawnShell();
      track(tapSessionData((sessionId) => {
        if (sessionId !== shell.sessionId) return;
        const until = performance.now() + PTY_TAP_BUDGET.tapSlowMs + 10;
        while (performance.now() < until) {
          // espera ocupada: simula um tap caro no main
        }
      }, 'tap-lento-de-teste'));
      shell.handlers.onData('x');
      await flushMainTrace();
      const lines = fs
        .readFileSync(path.join(dir, 'logs', 'main.trace.ndjson'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines).toContainEqual(
        expect.objectContaining({
          kind: 'pty-tap-slow',
          tapKind: 'data',
          tap: 'tap-lento-de-teste',
          sessionId: shell.sessionId,
        }),
      );
      await finish(shell, false);
    } finally {
      await flushMainTrace();
      setTraceDirectory(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
