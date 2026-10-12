// Inspired by pingdotgg/t3code @ 26285ab (no code copied) — perfil de carga
// canônico do F-764: 15 sessões de agente empurrando TUI ao mesmo tempo.
// Contagem determinística (mensagens IPC, chunks em voo, bytes), sem relógio.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import fs from 'node:fs';
import { resetLicensedAccessMock } from '../__tests__/licensed-access';
import { PTY_CHANNELS } from '../../shared/channels';
import type { PtyProcHandle, PtySessionHandlers } from './pty-host-core';
import {
  __resetPtyShutdownLifecycleForTests,
  orchTerminateSession,
  setPtyHost,
  spawnSession,
  tapSessionData,
} from './pty-manager';
import { PTY_TAP_BUDGET } from './pty-tap-dispatcher';

vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);

/**
 * F-764 — perfil de carga canônico no wire (Main → renderer).
 *
 * 15 sessões (teto do incidente de 03/10) × rajada de TUI. O Main não pode
 * pagar N_chunks × N_sessões mensagens: cada sessão tem a janela T3 de
 * 8 chunks / 64 KiB em voo. Os taps seguem vendo toda a saída (nenhuma perda).
 *
 * Tetos (valor medido no commit que criou o orçamento entre parênteses):
 * - sessions (15): o perfil canônico de carga.
 * - chunksPerSession (80): rajada de TUI plausível por pane.
 * - dataSendsTotal (120 = 15×8): janela de ACK por sessão, não por chunk.
 * - maxPendingChunksPerSession (8): janela T3 `OutputProtocol`.
 * - tapCharsPerSession (80×80 = 6400): os taps não perdem a rajada.
 */
const BUDGET = {
  sessions: 15,
  chunksPerSession: 80,
  dataSendsTotal: 15 * 8,
  maxPendingChunksPerSession: 8,
  tapCharsPerSession: 80 * 80,
} as const;

const CHUNK = `${'x'.repeat(79)}\n`;

const disposers: Array<() => void> = [];
const liveSessions: string[] = [];

beforeEach(() => {
  resetLicensedAccessMock();
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
});

afterEach(async () => {
  while (disposers.length > 0) disposers.pop()?.();
  // Encerra qualquer sessão que o teste não tenha liquidado (falha no meio).
  for (const sessionId of liveSessions.splice(0)) {
    try {
      const exited = orchTerminateSession(sessionId);
      await vi.runAllTimersAsync();
      await exited;
    } catch {
      // já morta
    }
  }
  vi.useRealTimers();
  __resetPtyShutdownLifecycleForTests();
});

function spawnShell(index: number): {
  sessionId: string;
  handlers: PtySessionHandlers;
  send: ReturnType<typeof vi.fn>;
} {
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
        installationId: 'installation-load-profile',
        projectId: 'project-load-profile',
        checkoutId: `checkout-load-profile-${index}`,
        rootRealPath: cwd,
        identitySource: 'provisional',
      },
    },
  );
  liveSessions.push(sessionId);
  return { sessionId, handlers: handlers!, send };
}

function dataSends(send: ReturnType<typeof vi.fn>): number {
  return send.mock.calls.filter(([channel]) => channel === PTY_CHANNELS.data).length;
}

describe('perfil de carga canônico do wire (F-764)', () => {
  it(`${BUDGET.sessions} sessões × ${BUDGET.chunksPerSession} chunks: IPC limitado por janela, taps sem perda`, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shells = Array.from({ length: BUDGET.sessions }, (_, i) => spawnShell(i));
    const tapChars = new Map<string, number>();
    disposers.push(
      tapSessionData((sessionId, data) => {
        if (!shells.some((s) => s.sessionId === sessionId)) return;
        tapChars.set(sessionId, (tapChars.get(sessionId) ?? 0) + data.length);
      }, 'load-profile-taps'),
    );

    for (const shell of shells) {
      for (let i = 0; i < BUDGET.chunksPerSession; i += 1) shell.handlers.onData(CHUNK);
    }
    // Taps em lote (F-764 C.1): o flush depende do relógio falso.
    vi.advanceTimersByTime(PTY_TAP_BUDGET.flushMs);

    const perSessionSends = shells.map((s) => dataSends(s.send));
    const totalSends = perSessionSends.reduce((a, b) => a + b, 0);
    const work = {
      sessions: shells.length,
      totalSends,
      maxSendsOneSession: Math.max(...perSessionSends),
      minTapChars: Math.min(...shells.map((s) => tapChars.get(s.sessionId) ?? 0)),
    };
    console.info('[perf-budget] pty-load-profile', JSON.stringify(work));

    // Nenhuma sessão passa da janela T3; o total é a soma das janelas.
    expect(work.maxSendsOneSession).toBeLessThanOrEqual(BUDGET.maxPendingChunksPerSession);
    expect(work.totalSends).toBeLessThanOrEqual(BUDGET.dataSendsTotal);
    // Os taps de análise continuam vendo a rajada inteira em cada sessão.
    expect(work.minTapChars).toBeGreaterThanOrEqual(BUDGET.tapCharsPerSession);

    for (const shell of shells) {
      const idx = liveSessions.indexOf(shell.sessionId);
      if (idx >= 0) liveSessions.splice(idx, 1);
      const exited = orchTerminateSession(shell.sessionId);
      await vi.runAllTimersAsync();
      await expect(exited).resolves.toBe(true);
    }
  });
});
