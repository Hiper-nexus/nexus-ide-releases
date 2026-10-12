import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  DICTATION_PENDING_MAX_MS,
  deliverDictation,
  resetPendingDictationsForTests,
  type DictationDeliveryPorts,
  type DictationLogLevel,
} from './dictation-delivery';
import { submitDictationToPaneConfirmed } from '../terminal/pane-submit';
import type { PtyPromptState } from '../../shared/types';

interface LogLine {
  level: DictationLogLevel;
  event: string;
}

function makePorts(
  overrides: Partial<DictationDeliveryPorts> = {},
): { ports: DictationDeliveryPorts; logs: LogLine[] } {
  const logs: LogLine[] = [];
  const ports: DictationDeliveryPorts = {
    getFocusedPaneId: () => 'pane-focused',
    listLivePaneIds: () => ['pane-focused', 'pane-other'],
    getSessionId: (paneId) => `sess-${paneId}`,
    deliverConfirmed: vi.fn(async () => true),
    deliverOperator: vi.fn(async () => false),
    log: (level, event) => logs.push({ level, event }),
    ...overrides,
  };
  return { ports, logs };
}

describe('deliverDictation — entrega confirmada', () => {
  it('confirma a entrega no pane focado e reporta a verdade (ok)', async () => {
    const deliverConfirmed = vi.fn(async () => true);
    const { ports } = makePorts({ deliverConfirmed });

    const result = await deliverDictation('corrige o login', ports);

    expect(result).toEqual({ ok: true, paneId: 'pane-focused' });
    // Passa a sessão VIVA recuperada, não o paneId cru: recibo real.
    expect(deliverConfirmed).toHaveBeenCalledWith(
      'pane-focused',
      'corrige o login',
      'sess-pane-focused',
    );
  });

  it('false-green agora é falha real: PTY não confirma → delivery-failed', async () => {
    const deliverConfirmed = vi.fn(async () => false);
    const { ports, logs } = makePorts({ deliverConfirmed });

    const result = await deliverDictation('texto perdido', ports);

    expect(result).toEqual({ ok: false, reason: 'delivery-failed' });
    // O salto do PTY é registrado como erro — morte deixa de ser silenciosa.
    expect(logs.some((l) => l.event === 'dictation.ptyFailed' && l.level === 'error')).toBe(
      true,
    );
  });

  it('instrumenta os 4 saltos do trajeto no caminho feliz', async () => {
    const { ports, logs } = makePorts();

    await deliverDictation('oi', ports);

    const events = logs.map((l) => l.event);
    expect(events).toEqual([
      'dictation.emit',
      'dictation.targetResolved',
      'dictation.ipcDispatch',
      'dictation.ptyConfirmed',
    ]);
  });

  it('foco sem sessão viva cai no fallback do primeiro pane vivo (sem silent-drop)', async () => {
    const deliverConfirmed = vi.fn(async () => true);
    const { ports, logs } = makePorts({
      getFocusedPaneId: () => 'pane-dead',
      listLivePaneIds: () => ['pane-alive'],
      deliverConfirmed,
    });

    const result = await deliverDictation('rota alternativa', ports);

    expect(result).toEqual({ ok: true, paneId: 'pane-alive' });
    expect(deliverConfirmed).toHaveBeenCalledWith(
      'pane-alive',
      'rota alternativa',
      'sess-pane-alive',
    );
    const resolved = logs.find((l) => l.event === 'dictation.targetResolved');
    expect(resolved).toBeDefined();
  });

  it('nenhum pane vivo → no-live-pane com erro visível, jamais false-green', async () => {
    const deliverConfirmed = vi.fn(async () => true);
    const { ports, logs } = makePorts({
      getFocusedPaneId: () => 'pane-dead',
      listLivePaneIds: () => [],
      deliverConfirmed,
    });

    const result = await deliverDictation('sem destino', ports);

    expect(result).toEqual({ ok: false, reason: 'no-live-pane' });
    expect(deliverConfirmed).not.toHaveBeenCalled();
    expect(logs.some((l) => l.event === 'dictation.noLivePane' && l.level === 'error')).toBe(
      true,
    );
  });

  it('sessão morre entre a resolução e a escrita → no-live-pane, nunca escreve', async () => {
    const deliverConfirmed = vi.fn(async () => true);
    const { ports } = makePorts({
      getSessionId: () => null,
      deliverConfirmed,
    });

    const result = await deliverDictation('sessao morta', ports);

    expect(result).toEqual({ ok: false, reason: 'no-live-pane' });
    expect(deliverConfirmed).not.toHaveBeenCalled();
  });
});

describe('deliverDictation — lane do operador para panes governados', () => {
  function makeLanePorts(overrides: Partial<DictationDeliveryPorts> = {}) {
    const logs: LogLine[] = [];
    const ports: DictationDeliveryPorts = {
      getFocusedPaneId: () => 'pane-orq',
      listLivePaneIds: () => ['pane-orq'],
      getSessionId: () => 'sess-orq',
      deliverConfirmed: vi.fn(async () => false),
      deliverOperator: vi.fn(async () => true),
      log: (level, event) => logs.push({ level, event }),
      ...overrides,
    };
    return { ports, logs };
  }

  it('lane terminal recusa (pane governado) → lane do operador entrega', async () => {
    const deliverOperator = vi.fn(async () => true);
    const { ports, logs } = makeLanePorts({ deliverOperator });

    const result = await deliverDictation('sobe a cobertura', ports);

    expect(result).toEqual({ ok: true, paneId: 'pane-orq' });
    expect(deliverOperator).toHaveBeenCalledWith(
      'pane-orq',
      'sobe a cobertura',
      'sess-orq',
    );
    expect(logs.some((l) => l.event === 'dictation.laneFallback')).toBe(true);
    expect(logs.some((l) => l.event === 'dictation.ptyConfirmed')).toBe(true);
  });

  it('não tenta a lane do operador quando a terminal confirma', async () => {
    const deliverOperator = vi.fn(async () => true);
    const { ports } = makeLanePorts({
      deliverConfirmed: vi.fn(async () => true),
      deliverOperator,
    });

    await deliverDictation('oi', ports);

    expect(deliverOperator).not.toHaveBeenCalled();
  });

  it('ambas as lanes recusam → delivery-failed verdadeiro', async () => {
    const { ports, logs } = makeLanePorts({
      deliverOperator: vi.fn(async () => false),
    });

    const result = await deliverDictation('texto perdido', ports);

    expect(result).toEqual({ ok: false, reason: 'delivery-failed' });
    expect(
      logs.some((l) => l.event === 'dictation.ptyFailed' && l.level === 'error'),
    ).toBe(true);
  });
});

describe('F-1393 — ditado recusado pelo pane não some', () => {
  it('as duas lanes recusam: o texto vai para a área de transferência e o resultado diz isso', async () => {
    const preserveUndelivered = vi.fn(async () => true);
    const { ports, logs } = makePorts({
      deliverConfirmed: vi.fn(async () => false),
      deliverOperator: vi.fn(async () => false),
      preserveUndelivered,
    });

    const result = await deliverDictation('refatora o voice-controller', ports);

    expect(result).toEqual({ ok: false, reason: 'delivery-failed', preserved: true });
    expect(preserveUndelivered).toHaveBeenCalledWith('refatora o voice-controller');
    expect(logs).toContainEqual({ level: 'info', event: 'dictation.preserved' });
  });

  it('sem pane vivo também guarda; cópia que falha vira preserved:false sem lançar', async () => {
    const { ports } = makePorts({
      listLivePaneIds: () => [],
      preserveUndelivered: vi.fn(async () => {
        throw new Error('clipboard negado');
      }),
    });

    await expect(deliverDictation('abre o PR', ports)).resolves.toEqual({
      ok: false,
      reason: 'no-live-pane',
      preserved: false,
    });
  });

  it('entrega confirmada não toca a área de transferência', async () => {
    const preserveUndelivered = vi.fn(async () => true);
    const { ports } = makePorts({ preserveUndelivered });

    await expect(deliverDictation('ok', ports)).resolves.toEqual({ ok: true, paneId: 'pane-focused' });
    expect(preserveUndelivered).not.toHaveBeenCalled();
  });
});

describe('F-1393 — ditado ao pane ocupado: fila ou pendente até o pane ficar livre', () => {
  afterEach(() => {
    resetPendingDictationsForTests();
    vi.useRealTimers();
  });

  /** Pane Claude real (pane-submit) com estado de prompt mutável. */
  function claudePane() {
    const prompt: { value: PtyPromptState } = {
      value: { turnStartSequence: 5, state: 'busy', awaitingInput: false, queuesInputWhileBusy: true },
    };
    let session = 'sess-pane-focused';
    const writes: string[] = [];
    const paneSubmitPorts = {
      getSessionId: () => session,
      schedule: (cb: () => void, ms: number) => setTimeout(cb, ms),
      write: vi.fn(),
      writeConfirmed: vi.fn(async (_id: string, data: string) => { writes.push(data); return true; }),
      submitPromptEnter: vi.fn(async () => {
        writes.push('\r');
        if (prompt.value.state === 'idle') {
          prompt.value = { ...prompt.value, turnStartSequence: prompt.value.turnStartSequence + 1 };
        }
        return true;
      }),
      probePromptState: async () => prompt.value,
    };
    const logs: LogLine[] = [];
    const ports: DictationDeliveryPorts = {
      getFocusedPaneId: () => 'pane-focused',
      listLivePaneIds: () => ['pane-focused'],
      getSessionId: () => session,
      deliverConfirmed: (paneId, text, sessionId) =>
        submitDictationToPaneConfirmed(paneId, text, sessionId, paneSubmitPorts),
      deliverOperator: vi.fn(async () => false),
      probePromptState: async () => prompt.value,
      schedule: (cb, ms) => setTimeout(cb, ms),
      preserveUndelivered: vi.fn(async () => true),
      log: (level, event) => logs.push({ level, event }),
    };
    return {
      ports,
      logs,
      writes,
      prompt,
      switchSession: (next: string) => { session = next; },
    };
  }

  it('claude ocupado: entrega na hora (queued) e registra dictation.ptyQueued', async () => {
    vi.useFakeTimers();
    const pane = claudePane();
    const pending = deliverDictation('corrige o login', pane.ports);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toEqual({ ok: true, paneId: 'pane-focused', queued: true });
    expect(pane.writes).toEqual(['\x1b[200~corrige o login\x1b[201~', '\r']);
    expect(pane.logs).toContainEqual({ level: 'info', event: 'dictation.ptyQueued' });
    expect(pane.ports.preserveUndelivered).not.toHaveBeenCalled();
  });

  it('(b) diálogo aberto: nada é escrito; quando o pane fica idle o ditado entra sozinho', async () => {
    vi.useFakeTimers();
    const pane = claudePane();
    pane.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: true, queuesInputWhileBusy: true };

    const result = deliverDictation('abre o PR', pane.ports);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(result).resolves.toEqual({
      ok: false,
      reason: 'pending',
      paneId: 'pane-focused',
      preserved: true,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pane.writes).toEqual([]);

    pane.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: false, queuesInputWhileBusy: true };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pane.writes).toEqual(['\x1b[200~abre o PR\x1b[201~', '\r']);
    expect(pane.logs).toContainEqual({ level: 'info', event: 'dictation.pendingDelivered' });
  });

  it('pendente cai se a sessão do pane mudar ou passar o teto de 10 min — sem escrever', async () => {
    vi.useFakeTimers();
    const changed = claudePane();
    changed.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: true };
    await Promise.all([deliverDictation('um', changed.ports), vi.advanceTimersByTimeAsync(3_000)]);
    changed.switchSession('sess-nova');
    changed.prompt.value = { turnStartSequence: 0, state: 'idle', awaitingInput: false };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(changed.writes).toEqual([]);
    expect(changed.logs).toContainEqual({ level: 'warn', event: 'dictation.pendingDropped' });

    resetPendingDictationsForTests();
    const stuck = claudePane();
    stuck.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: true };
    await Promise.all([deliverDictation('dois', stuck.ports), vi.advanceTimersByTimeAsync(3_000)]);
    await vi.advanceTimersByTimeAsync(DICTATION_PENDING_MAX_MS + 5_000);
    expect(stuck.writes).toEqual([]);
    expect(stuck.logs).toContainEqual({ level: 'warn', event: 'dictation.pendingDropped' });
  });

  it('um ditado novo substitui o pendente do mesmo pane: só o último entra', async () => {
    vi.useFakeTimers();
    const pane = claudePane();
    pane.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: true };
    await Promise.all([deliverDictation('primeiro', pane.ports), vi.advanceTimersByTimeAsync(3_000)]);
    await Promise.all([deliverDictation('segundo', pane.ports), vi.advanceTimersByTimeAsync(3_000)]);
    expect(pane.logs).toContainEqual({ level: 'info', event: 'dictation.pendingReplaced' });
    pane.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: false };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pane.writes).toEqual(['\x1b[200~segundo\x1b[201~', '\r']);
  });
});

