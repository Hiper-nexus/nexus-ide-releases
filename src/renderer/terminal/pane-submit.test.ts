import { describe, expect, it, vi } from 'vitest';
import {
  submitDictationToPaneConfirmed,
  submitDictationToPaneOperator,
  submitPromptToPane,
  submitPromptToPaneConfirmed,
  submitPromptToPaneOperator,
  type PaneSubmitPorts,
} from './pane-submit';

function createPorts(sessionId: string | null = 'session-1') {
  let currentSessionId = sessionId;
  const write = vi.fn();
  const writeConfirmed = vi.fn(async () => true);
  const ports: PaneSubmitPorts = {
    getSessionId: () => currentSessionId,
    write,
    writeConfirmed,
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  };
  return {
    ports,
    write,
    writeConfirmed,
    setSessionId: (next: string | null) => {
      currentSessionId = next;
    },
  };
}

describe('pane prompt submission', () => {
  it('pastes multiline text, then sends Enter after the paste settles', () => {
    vi.useFakeTimers();
    try {
      const { ports, write } = createPorts();
      expect(submitPromptToPane('pane-1', 'Objective\nAcceptance', ports)).toBe(true);
      expect(write).toHaveBeenCalledWith(
        'session-1',
        '\x1b[200~Objective\nAcceptance\x1b[201~',
      );
      vi.advanceTimersByTime(749);
      expect(write).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(1);
      expect(write).toHaveBeenLastCalledWith('session-1', '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('confirms only after Enter reaches the expected session', async () => {
    vi.useFakeTimers();
    try {
      const { ports, writeConfirmed } = createPorts();
      const confirmed = submitPromptToPaneConfirmed(
        'pane-1',
        'Continue',
        'session-1',
        ports,
      );
      await Promise.resolve();
      vi.advanceTimersByTime(750);
      await expect(confirmed).resolves.toBe(true);
      expect(writeConfirmed).toHaveBeenNthCalledWith(
        1,
        'session-1',
        '\x1b[200~Continue\x1b[201~',
      );
      expect(writeConfirmed).toHaveBeenLastCalledWith('session-1', '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects before paste when another session already won', async () => {
    const { ports, writeConfirmed } = createPorts('session-newer');
    await expect(submitPromptToPaneConfirmed(
      'pane-1',
      'Continue',
      'session-recovered',
      ports,
    )).resolves.toBe(false);
    expect(writeConfirmed).not.toHaveBeenCalled();
  });

  it('does not send Enter when the recovered session changes after paste', async () => {
    vi.useFakeTimers();
    try {
      const { ports, writeConfirmed, setSessionId } = createPorts();
      const confirmed = submitPromptToPaneConfirmed(
        'pane-1',
        'Continue',
        'session-1',
        ports,
      );
      await Promise.resolve();
      setSessionId('session-2');
      vi.advanceTimersByTime(750);
      await expect(confirmed).resolves.toBe(false);
      expect(writeConfirmed).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing without a live session', async () => {
    const { ports, write, writeConfirmed } = createPorts(null);
    expect(submitPromptToPane('pane-1', 'Objective', ports)).toBe(false);
    await expect(submitPromptToPaneConfirmed(
      'pane-1',
      'Objective',
      'session-1',
      ports,
    )).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(writeConfirmed).not.toHaveBeenCalled();
  });

  it('rejects terminal control bytes before writing either half', async () => {
    const { ports, write, writeConfirmed } = createPorts();
    const injected = 'Safe prefix\x1b[201~\rdestructive command';
    expect(submitPromptToPane('pane-1', injected, ports)).toBe(false);
    await expect(submitPromptToPaneConfirmed(
      'pane-1',
      injected,
      'session-1',
      ports,
    )).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(writeConfirmed).not.toHaveBeenCalled();
  });

  it('does not confirm when main rejects either PTY write', async () => {
    vi.useFakeTimers();
    try {
      const { ports, writeConfirmed } = createPorts();
      writeConfirmed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const confirmed = submitPromptToPaneConfirmed(
        'pane-1',
        'Continue',
        'session-1',
        ports,
      );
      await Promise.resolve();
      vi.advanceTimersByTime(750);
      await expect(confirmed).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits longer before Enter for large Claude-style prompts', () => {
    vi.useFakeTimers();
    try {
      const { ports, write } = createPorts();
      const longPrompt = 'x'.repeat(1_200);
      expect(submitPromptToPane('pane-1', longPrompt, ports)).toBe(true);
      vi.advanceTimersByTime(1_679);
      expect(write).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(1);
      expect(write).toHaveBeenLastCalledWith('session-1', '\r');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('submitPromptToPaneOperator — lane do operador (pane governado)', () => {
  function createOperatorPorts(sessionId: string | null = 'session-1') {
    let currentSessionId = sessionId;
    const operatorWrite = vi.fn(async () => true);
    const ports = {
      getSessionId: () => currentSessionId,
      operatorWrite,
      schedule: (callback: () => void, delayMs: number) =>
        setTimeout(callback, delayMs),
    };
    return {
      ports,
      operatorWrite,
      setSessionId: (next: string | null) => {
        currentSessionId = next;
      },
    };
  }

  it('digita o texto e envia Enter depois do settle, ambos com recibo', async () => {
    vi.useFakeTimers();
    try {
      const { ports, operatorWrite } = createOperatorPorts();
      const submitted = submitPromptToPaneOperator(
        'pane-1',
        'corrige o parser',
        'session-1',
        ports,
      );
      await Promise.resolve();
      expect(operatorWrite).toHaveBeenCalledWith('session-1', 'corrige o parser');
      await vi.advanceTimersByTimeAsync(2_500);
      await expect(submitted).resolves.toBe(true);
      expect(operatorWrite).toHaveBeenLastCalledWith('session-1', '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('normaliza quebras de linha em espaço (a lane rejeita colagem bracketed)', async () => {
    vi.useFakeTimers();
    try {
      const { ports, operatorWrite } = createOperatorPorts();
      const submitted = submitPromptToPaneOperator(
        'pane-1',
        'linha um\nlinha dois',
        'session-1',
        ports,
      );
      await Promise.resolve();
      expect(operatorWrite).toHaveBeenCalledWith('session-1', 'linha um linha dois');
      await vi.advanceTimersByTimeAsync(2_500);
      await expect(submitted).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recusa quando a escrita do texto não confirma — e não envia Enter', async () => {
    vi.useFakeTimers();
    try {
      const { ports, operatorWrite } = createOperatorPorts();
      operatorWrite.mockResolvedValueOnce(false);
      const submitted = submitPromptToPaneOperator(
        'pane-1',
        'texto',
        'session-1',
        ports,
      );
      await vi.advanceTimersByTimeAsync(2_500);
      await expect(submitted).resolves.toBe(false);
      expect(operatorWrite).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recusa quando a sessão troca antes do Enter', async () => {
    vi.useFakeTimers();
    try {
      const { ports, operatorWrite, setSessionId } = createOperatorPorts();
      const submitted = submitPromptToPaneOperator(
        'pane-1',
        'texto',
        'session-1',
        ports,
      );
      await Promise.resolve();
      setSessionId('session-2');
      await vi.advanceTimersByTimeAsync(2_500);
      await expect(submitted).resolves.toBe(false);
      expect(operatorWrite).toHaveBeenCalledOnce();
      expect(operatorWrite).not.toHaveBeenCalledWith('session-1', '\r');
    } finally {
      vi.useRealTimers();
    }
  });
});


// Campo (14/08): Enter comido deixava texto PRESO no composer do claude sem
// sinal. As lanes confirmadas ganham prova de turno (idle→busy) + UM CR de
// destravamento — nunca re-paste.
describe('prova de turno após o Enter (compose unstick)', () => {
  function createProbePorts(busyAfter: number | null) {
    let stateCbs: Array<(state: string) => void> = [];
    let crCount = 0;
    const writeConfirmed = vi.fn(async (_s: string, data: string) => {
      if (data === '\r') crCount += 1;
      if (busyAfter !== null && crCount >= busyAfter) {
        // macrotask: a assinatura do awaitTurnStart acontece no .then do CR —
        // disparar síncrono aqui seria PERDER o evento (ninguém inscrito ainda).
        setTimeout(() => {
          for (const cb of [...stateCbs]) cb('busy');
        }, 0);
      }
      return true;
    });
    const ports: PaneSubmitPorts = {
      getSessionId: () => 'session-1',
      write: vi.fn(),
      writeConfirmed,
      schedule: (cb, ms) => setTimeout(cb, ms),
      onSessionState: (_s, cb) => {
        stateCbs.push(cb);
        return () => {
          stateCbs = stateCbs.filter((x) => x !== cb);
        };
      },
    };
    return { ports, writeConfirmed };
  }

  it('resolve true quando o turno abre após o Enter — sem CR extra', async () => {
    vi.useFakeTimers();
    try {
      const { ports, writeConfirmed } = createProbePorts(1);
      const pending = submitPromptToPaneConfirmed('pane-1', 'tarefa simples', 'session-1', ports);
      const assertion = expect(pending).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(3_000);
      await assertion;
      expect(writeConfirmed).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Enter comido → UM CR de destravamento e resolve com o que aconteceu', async () => {
    vi.useFakeTimers();
    try {
      const { ports, writeConfirmed } = createProbePorts(2);
      const pending = submitPromptToPaneConfirmed('pane-1', 'tarefa simples', 'session-1', ports);
      const assertion = expect(pending).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(writeConfirmed).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sem sonda de estado: comportamento atual preservado (aceita o Enter)', async () => {
    vi.useFakeTimers();
    try {
      const { ports, writeConfirmed } = createProbePorts(null);
      const portsSemSonda: PaneSubmitPorts = { ...ports, onSessionState: undefined };
      const pending = submitPromptToPaneConfirmed('pane-1', 'tarefa', 'session-1', portsSemSonda);
      const assertion = expect(pending).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(3_000);
      await assertion;
      expect(writeConfirmed).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});


describe('F-266: Kimi uses canonical turn proof, never input busy as acceptance', () => {
  it.each(['swallowed', 'input-busy', 'dialog'] as const)('%s after first CR', async (scenario) => {
    vi.useFakeTimers();
    try {
      let enters = 0;
      const writes: string[] = [];
      const ports = {
        getSessionId: () => 'session-kimi',
        schedule: (cb: () => void, ms: number) => setTimeout(cb, ms),
        write: vi.fn(),
        writeConfirmed: async (_id: string, data: string) => { writes.push(data); return true; },
        submitPromptEnter: async () => { writes.push('\r'); enters++; return true; },
        bracketedPaste: false,
        probePromptState: async () => ({ turnStartSequence: enters >= 2 ? 1 : 0,
          state: scenario === 'input-busy' && enters > 0 ? 'busy' as const : 'idle' as const,
          awaitingInput: scenario === 'dialog' && enters > 0 }),
      };
      const pending = submitPromptToPaneConfirmed('pane-kimi', 'new prompt', 'session-kimi', ports);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await pending).toBe(scenario === 'swallowed');
      expect(writes[0]).toBe('new prompt');
      expect(enters).toBe(scenario === 'swallowed' ? 2 : 1);
    } finally { vi.useRealTimers(); }
  });

  it('operator lane observes a turn even when it starts during the CR write', async () => {
    vi.useFakeTimers();
    try {
      let sequence = 4;
      const write = vi.fn(async (_id: string, data: string) => { if (data === '\r') sequence++; return true; });
      const pending = submitPromptToPaneOperator('pane-kimi', 'new prompt', 'session-kimi', {
        getSessionId: () => 'session-kimi', operatorWrite: write,
        submitPromptEnter: async id => write(id, '\r'),
        schedule: (cb, ms) => setTimeout(cb, ms),
        probePromptState: async () => ({ turnStartSequence: sequence, state: 'idle', awaitingInput: false }),
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toBe(true);
      expect(write).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});

it('F-266: a dialog appearing after the probe is vetoed by the atomic Main Enter', async () => {
  vi.useFakeTimers();
  try {
    const writes: string[] = [];
    const ports = {
      getSessionId: () => 'session-kimi', bracketedPaste: false,
      schedule: (cb: () => void, ms: number) => setTimeout(cb, ms), write: vi.fn(),
      writeConfirmed: async (_id: string, data: string) => { writes.push(data); return true; },
      probePromptState: async () => ({ turnStartSequence: 2, state: 'idle' as const, awaitingInput: false }),
      submitPromptEnter: vi.fn(async () => false),
    };
    const pending = submitPromptToPaneConfirmed('pane-kimi', 'new prompt', 'session-kimi', ports);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toBe(false);
    expect(writes).toEqual(['new prompt']);
    expect(ports.submitPromptEnter).toHaveBeenCalledWith('session-kimi', 2, false);
  } finally { vi.useRealTimers(); }
});

describe('F-1393: ditado chega ao pane ocupado que enfileira', () => {
  function claudePorts(state: { state: 'idle' | 'busy'; awaitingInput: boolean; queues?: boolean }) {
    const writes: string[] = [];
    const ports = {
      getSessionId: () => 'session-claude',
      schedule: (cb: () => void, ms: number) => setTimeout(cb, ms),
      write: vi.fn(),
      writeConfirmed: vi.fn(async (_id: string, data: string) => { writes.push(data); return true; }),
      submitPromptEnter: vi.fn(async () => { writes.push('\r'); return true; }),
      probePromptState: async () => ({
        turnStartSequence: 3,
        state: state.state,
        awaitingInput: state.awaitingInput,
        ...(state.queues === false ? {} : { queuesInputWhileBusy: true }),
      }),
    };
    return { ports, writes };
  }

  it('(a) claude ocupado recebe o ditado: texto colado e depois Enter, sem esperar o turno abrir', async () => {
    vi.useFakeTimers();
    try {
      const { ports, writes } = claudePorts({ state: 'busy', awaitingInput: false });
      const pending = submitDictationToPaneConfirmed('pane-claude', 'refatora o login', 'session-claude', ports);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toBe('queued');
      expect(writes).toEqual(['\x1b[200~refatora o login\x1b[201~', '\r']);
      expect(ports.submitPromptEnter).toHaveBeenCalledWith('session-claude', 3, false);
    } finally { vi.useRealTimers(); }
  });

  it('lane do operador também enfileira no pane governado ocupado', async () => {
    vi.useFakeTimers();
    try {
      const operatorWrite = vi.fn(async () => true);
      const pending = submitDictationToPaneOperator('pane-claude', 'abre o PR', 'session-claude', {
        getSessionId: () => 'session-claude',
        operatorWrite,
        submitPromptEnter: vi.fn(async () => true),
        schedule: (cb, ms) => setTimeout(cb, ms),
        probePromptState: async () => ({ turnStartSequence: 3, state: 'busy', awaitingInput: false, queuesInputWhileBusy: true }),
      });
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toBe('queued');
      expect(operatorWrite).toHaveBeenCalledWith('session-claude', 'abre o PR');
    } finally { vi.useRealTimers(); }
  });

  it.each([
    { name: 'diálogo aberto', state: 'idle' as const, awaitingInput: true, queues: true },
    { name: 'diálogo aberto no turno', state: 'busy' as const, awaitingInput: true, queues: true },
    { name: 'adapter sem fila ocupado', state: 'busy' as const, awaitingInput: false, queues: false },
  ])('$name: nada é escrito e o ditado espera (wait)', async ({ state, awaitingInput, queues }) => {
    vi.useFakeTimers();
    try {
      const { ports, writes } = claudePorts({ state, awaitingInput, queues });
      const pending = submitDictationToPaneConfirmed('pane-claude', 'texto', 'session-claude', ports);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toBe('wait');
      expect(writes).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('(c) recovery e demais chamadores continuam exigindo idle: pane ocupado que enfileira é recusado', async () => {
    vi.useFakeTimers();
    try {
      const { ports, writes } = claudePorts({ state: 'busy', awaitingInput: false });
      const pending = submitPromptToPaneConfirmed('pane-claude', 'retoma a tarefa', 'session-claude', ports);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(pending).resolves.toBe(false);
      expect(writes).toEqual([]);
      const operatorWrite = vi.fn(async () => true);
      const operator = submitPromptToPaneOperator('pane-claude', 'retoma', 'session-claude', {
        getSessionId: () => 'session-claude', operatorWrite, schedule: (cb, ms) => setTimeout(cb, ms),
        submitPromptEnter: vi.fn(async () => true),
        probePromptState: async () => ({ turnStartSequence: 3, state: 'busy', awaitingInput: false, queuesInputWhileBusy: true }),
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(operator).resolves.toBe(false);
      expect(operatorWrite).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe('C1 (F-1393): ramo busy — Enter com a sequência atual e falha pós-escrita é lost', () => {
  it('turno termina no settle: o Enter vai com a sequência nova e o ditado entra (queued)', async () => {
    vi.useFakeTimers();
    try {
      let sequence = 3;
      const writes: string[] = [];
      const submitPromptEnter = vi.fn(async (_id: string, expected: number) => {
        if (expected !== sequence) return false; // Main recusa sequência velha
        writes.push('\r');
        return true;
      });
      const pending = submitDictationToPaneConfirmed('pane-claude', 'roda o lint', 'session-claude', {
        getSessionId: () => 'session-claude',
        schedule: (cb, ms) => setTimeout(cb, ms),
        write: vi.fn(),
        writeConfirmed: vi.fn(async (_id: string, data: string) => {
          writes.push(data);
          sequence = 4; // o turno em curso acabou e outro começou durante o settle
          return true;
        }),
        submitPromptEnter,
        probePromptState: async () => ({ turnStartSequence: sequence, state: 'busy', awaitingInput: false, queuesInputWhileBusy: true }),
      });
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toBe('queued');
      expect(submitPromptEnter).toHaveBeenCalledWith('session-claude', 4, false);
      expect(writes).toEqual(['\x1b[200~roda o lint\x1b[201~', '\r']);
    } finally { vi.useRealTimers(); }
  });

  it('texto escrito e Enter recusado: lost (não failed), para nenhuma lane colar de novo', async () => {
    vi.useFakeTimers();
    try {
      const pending = submitDictationToPaneConfirmed('pane-claude', 'abre o PR', 'session-claude', {
        getSessionId: () => 'session-claude',
        schedule: (cb, ms) => setTimeout(cb, ms),
        write: vi.fn(),
        writeConfirmed: vi.fn(async () => true),
        submitPromptEnter: vi.fn(async () => false),
        probePromptState: async () => ({ turnStartSequence: 3, state: 'busy', awaitingInput: false, queuesInputWhileBusy: true }),
      });
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toBe('lost');
    } finally { vi.useRealTimers(); }
  });
});

describe('F-1411 follow-up: multiline to Claude (bracketedPaste:false) stays bracketed', () => {
  function declinedPorts(state: 'idle' | 'busy' = 'idle') {
    const writes: string[] = [];
    let enters = 0;
    const ports: PaneSubmitPorts = {
      getSessionId: () => 'session-claude',
      schedule: (cb: () => void, ms: number) => setTimeout(cb, ms),
      write: vi.fn(),
      writeConfirmed: vi.fn(async (_id: string, data: string) => { writes.push(data); return true; }),
      submitPromptEnter: vi.fn(async () => { writes.push('\r'); enters++; return true; }),
      bracketedPaste: false,
      probePromptState: async () => ({
        turnStartSequence: enters >= 1 ? 1 : 0,
        state: state as 'idle' | 'busy',
        awaitingInput: false,
        ...(state === 'busy' ? { queuesInputWhileBusy: true } : {}),
      }),
    };
    return { ports, writes };
  }

  it('confirmed multiline wraps despite bracketedPaste:false (LF-as-Enter guard)', async () => {
    vi.useFakeTimers();
    try {
      const { ports, writes } = declinedPorts();
      const pending = submitPromptToPaneConfirmed('pane-claude', 'linha um\nlinha dois', 'session-claude', ports);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await pending).toBe(true);
      expect(writes[0]).toBe('\x1b[200~linha um\nlinha dois\x1b[201~');
    } finally { vi.useRealTimers(); }
  });

  it('single-line keeps the F-1411 raw path', async () => {
    vi.useFakeTimers();
    try {
      const { ports, writes } = declinedPorts();
      const pending = submitPromptToPaneConfirmed('pane-claude', 'uma linha', 'session-claude', ports);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await pending).toBe(true);
      expect(writes[0]).toBe('uma linha');
    } finally { vi.useRealTimers(); }
  });

  it('dictation multiline wraps despite bracketedPaste:false', async () => {
    vi.useFakeTimers();
    try {
      const { ports, writes } = declinedPorts('busy');
      const pending = submitDictationToPaneConfirmed('pane-claude', 'fala um\nfala dois', 'session-claude', ports);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toBe('queued');
      expect(writes).toEqual(['\x1b[200~fala um\nfala dois\x1b[201~', '\r']);
    } finally { vi.useRealTimers(); }
  });
});

