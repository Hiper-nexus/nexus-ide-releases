import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  DICTATION_PENDING_FAILED_RETRIES,
  DICTATION_PENDING_MAX_MS,
  cancelPendingDictation,
  deliverDictation,
  hasPendingDictation,
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
          prompt.value = { ...prompt.value, state: 'busy', turnStartSequence: prompt.value.turnStartSequence + 1 };
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
    });
    // B1: pendente não vai para a área de transferência (colar + entrega = 2×).
    expect(pane.ports.preserveUndelivered).not.toHaveBeenCalled();
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

  it('B1: input humano no pane cancela o pendente — o pane livre não recebe o prompt de novo', async () => {
    vi.useFakeTimers();
    const pane = claudePane();
    pane.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: true };
    await Promise.all([deliverDictation('roda os testes', pane.ports), vi.advanceTimersByTimeAsync(3_000)]);
    expect(pane.ports.preserveUndelivered).not.toHaveBeenCalled();

    // O operador respondeu o diálogo e colou o texto à mão.
    expect(cancelPendingDictation('pane-focused')).toBe(true);
    pane.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: false };
    await vi.advanceTimersByTimeAsync(10_000);

    expect(pane.writes).toEqual([]);
    expect(pane.logs).toContainEqual({ level: 'info', event: 'dictation.pendingCancelled' });
    expect(cancelPendingDictation('pane-focused')).toBe(false);
  });

  it('C1: lane do terminal escreveu e não confirmou (lost) — a lane do operador NÃO cola de novo', async () => {
    const deliverOperator = vi.fn(async () => true);
    const preserveUndelivered = vi.fn(async () => true);
    const { ports, logs } = makePorts({
      deliverConfirmed: vi.fn(async () => 'lost' as const),
      deliverOperator,
      preserveUndelivered,
    });

    const result = await deliverDictation('corrige o teste', ports);

    expect(result).toEqual({ ok: false, reason: 'delivery-lost', preserved: true });
    expect(deliverOperator).not.toHaveBeenCalled();
    expect(preserveUndelivered).toHaveBeenCalledWith('corrige o teste');
    expect(logs).toContainEqual({ level: 'error', event: 'dictation.ptyLost' });
  });

  it('C2: o desfecho do pendente chega ao chamador (entregue, cancelado, sessão mudou com cópia)', async () => {
    vi.useFakeTimers();
    const delivered = claudePane();
    const onDelivered = vi.fn();
    delivered.ports.onSettled = onDelivered;
    delivered.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: true };
    await Promise.all([deliverDictation('um', delivered.ports), vi.advanceTimersByTimeAsync(3_000)]);
    delivered.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: false };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onDelivered).toHaveBeenCalledExactlyOnceWith({ paneId: 'pane-focused', result: 'ok' });

    resetPendingDictationsForTests();
    const cancelled = claudePane();
    const onCancelled = vi.fn();
    cancelled.ports.onSettled = onCancelled;
    cancelled.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: true };
    await Promise.all([deliverDictation('dois', cancelled.ports), vi.advanceTimersByTimeAsync(3_000)]);
    cancelPendingDictation('pane-focused');
    await vi.advanceTimersByTimeAsync(0);
    // C-1: responder o diálogo cancela o pendente, e o prompt falado vai para
    // a área de transferência (o pendente já saiu do mapa: colar não duplica).
    expect(cancelled.ports.preserveUndelivered).toHaveBeenCalledWith('dois');
    expect(onCancelled).toHaveBeenCalledExactlyOnceWith({
      paneId: 'pane-focused',
      result: 'error',
      errorCode: 'pending-cancelled',
      preserved: true,
    });

    resetPendingDictationsForTests();
    const restarted = claudePane();
    const onRestarted = vi.fn();
    restarted.ports.onSettled = onRestarted;
    restarted.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: true };
    await Promise.all([deliverDictation('três', restarted.ports), vi.advanceTimersByTimeAsync(3_000)]);
    restarted.switchSession('sess-nova');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(restarted.ports.preserveUndelivered).toHaveBeenCalledWith('três');
    expect(onRestarted).toHaveBeenCalledExactlyOnceWith({
      paneId: 'pane-focused',
      result: 'error',
      errorCode: 'pending-session-changed',
      preserved: true,
    });
  });

  it('C-5: no pane livre, texto escrito sem confirmação vira pending-lost com cópia (não pending-failed)', async () => {
    vi.useFakeTimers();
    const pane = claudePane();
    const onSettled = vi.fn();
    pane.ports.onSettled = onSettled;
    pane.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: true };
    await Promise.all([deliverDictation('abre o PR', pane.ports), vi.advanceTimersByTimeAsync(3_000)]);
    pane.ports.deliverConfirmed = vi.fn(async () => 'lost' as const);
    pane.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: false };
    await vi.advanceTimersByTimeAsync(2_000);

    expect(pane.ports.deliverOperator).not.toHaveBeenCalled();
    expect(pane.ports.preserveUndelivered).toHaveBeenCalledWith('abre o PR');
    expect(onSettled).toHaveBeenCalledExactlyOnceWith({
      paneId: 'pane-focused',
      result: 'error',
      errorCode: 'pending-lost',
      preserved: true,
    });
    expect(pane.logs).toContainEqual({ level: 'error', event: 'dictation.pendingLost' });
  });

  it('C-3: tecla durante a entrega em voo não cancela — o HUD ouve "entrando" e o ditado entra', async () => {
    vi.useFakeTimers();
    const pane = claudePane();
    const onDelivering = vi.fn();
    const onSettled = vi.fn();
    pane.ports.onDelivering = onDelivering;
    pane.ports.onSettled = onSettled;
    pane.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: true };
    await Promise.all([deliverDictation('roda o lint', pane.ports), vi.advanceTimersByTimeAsync(3_000)]);
    expect(hasPendingDictation()).toBe(true);

    pane.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: false };
    await vi.advanceTimersByTimeAsync(1_100);
    // Paste já saiu, Enter ainda no settle: a tecla do operador não cancela.
    expect(pane.writes).toEqual(['\x1b[200~roda o lint\x1b[201~']);
    expect(onDelivering).toHaveBeenCalledWith('pane-focused', true);
    expect(cancelPendingDictation('pane-focused')).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(pane.writes).toEqual(['\x1b[200~roda o lint\x1b[201~', '\r']);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith({ paneId: 'pane-focused', result: 'ok' });
    expect(hasPendingDictation()).toBe(false);
  });

  it('C-7: recusa sem escrita no pane livre tenta de novo até 3 vezes antes de desistir', async () => {
    vi.useFakeTimers();
    const pane = claudePane();
    const onSettled = vi.fn();
    pane.ports.onSettled = onSettled;
    pane.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: true };
    await Promise.all([deliverDictation('abre o PR', pane.ports), vi.advanceTimersByTimeAsync(3_000)]);
    const real = pane.ports.deliverConfirmed;
    let calls = 0;
    pane.ports.deliverConfirmed = vi.fn(async (paneId: string, text: string, sessionId: string) =>
      ++calls <= DICTATION_PENDING_FAILED_RETRIES ? ('failed' as const) : real(paneId, text, sessionId));
    pane.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: false };
    await vi.advanceTimersByTimeAsync(15_000);

    expect(pane.logs.filter((line) => line.event === 'dictation.pendingRetry')).toHaveLength(3);
    expect(pane.writes).toEqual(['\x1b[200~abre o PR\x1b[201~', '\r']);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith({ paneId: 'pane-focused', result: 'ok' });

    resetPendingDictationsForTests();
    const stubborn = claudePane();
    const onStubborn = vi.fn();
    stubborn.ports.onSettled = onStubborn;
    stubborn.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: true };
    await Promise.all([deliverDictation('dois', stubborn.ports), vi.advanceTimersByTimeAsync(3_000)]);
    stubborn.ports.deliverConfirmed = vi.fn(async () => 'failed' as const);
    stubborn.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: false };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(stubborn.ports.deliverConfirmed).toHaveBeenCalledTimes(DICTATION_PENDING_FAILED_RETRIES + 1);
    expect(onStubborn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ result: 'error', errorCode: 'pending-failed' }),
    );
  });

  it('um ditado novo substitui o pendente do mesmo pane: só o último entra', async () => {
    vi.useFakeTimers();
    const pane = claudePane();
    const onFirstSettled = vi.fn();
    pane.ports.onSettled = onFirstSettled;
    pane.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: true };
    await Promise.all([deliverDictation('primeiro', pane.ports), vi.advanceTimersByTimeAsync(3_000)]);
    await Promise.all([deliverDictation('segundo', pane.ports), vi.advanceTimersByTimeAsync(3_000)]);
    expect(pane.logs).toContainEqual({ level: 'info', event: 'dictation.pendingReplaced' });
    // C-2: substituído é `pending-replaced`, sem cópia (o texto novo é o que vale).
    expect(onFirstSettled).toHaveBeenCalledWith({
      paneId: 'pane-focused',
      result: 'error',
      errorCode: 'pending-replaced',
    });
    expect(pane.ports.preserveUndelivered).not.toHaveBeenCalled();
    pane.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: false };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pane.writes).toEqual(['\x1b[200~segundo\x1b[201~', '\r']);
  });

  it('F-1393 M4: ditado B aguarda ditado A em entrega terminar e entra na fila em vez de substituir A', async () => {
    vi.useFakeTimers();
    const pane = claudePane();
    const onFirstSettled = vi.fn();
    pane.ports.onSettled = onFirstSettled;

    // Ditado A fica pendente porque awaitingInput: true
    pane.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: true, queuesInputWhileBusy: true };
    await Promise.all([deliverDictation('ditado A', pane.ports), vi.advanceTimersByTimeAsync(3_000)]);
    expect(hasPendingDictation()).toBe(true);

    // O pane fica livre — A entra em delivering (paste já saiu, Enter ainda no settle)
    pane.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: false, queuesInputWhileBusy: true };
    await vi.advanceTimersByTimeAsync(1_100);
    expect(pane.writes).toEqual(['\x1b[200~ditado A\x1b[201~']);

    // Ditado B chega enquanto A está em delivering.
    // B deve aguardar A concluir e ser enfileirado (queued), sem substituir A nem juntar os textos.
    let bResult: any;
    const bPromise = deliverDictation('ditado B', pane.ports).then((r) => { bResult = r; });

    // Avança o tempo para A completar o settle do Enter e B processar
    await vi.advanceTimersByTimeAsync(5_000);
    await bPromise;

    // A foi entregue com sucesso (não substituído)
    expect(onFirstSettled).toHaveBeenCalledWith({
      paneId: 'pane-focused',
      result: 'ok',
    });
    // B entrou na fila (queued) atrás de A
    expect(bResult).toEqual({
      ok: true,
      paneId: 'pane-focused',
      queued: true,
    });
    // Escritas separadas: texto A, Enter, texto B, Enter — nunca misturados
    expect(pane.writes).toEqual([
      '\x1b[200~ditado A\x1b[201~',
      '\r',
      '\x1b[200~ditado B\x1b[201~',
      '\r',
    ]);
  });

  it('F-1393 M6: ditado pendente não sobrescreve a área de transferência se o operador copiou algo novo', async () => {
    vi.useFakeTimers();
    let clipboard = 'conteúdo copiado pelo operador';
    const readClipboard = vi.fn(async () => clipboard);
    const preserveUndelivered = vi.fn(async (text: string) => {
      clipboard = text;
      return true;
    });
    const onSettled = vi.fn();
    const pane = claudePane();
    pane.ports.readClipboard = readClipboard;
    pane.ports.preserveUndelivered = preserveUndelivered;
    pane.ports.onSettled = onSettled;

    // Ditado fica pendente
    pane.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: true };
    await Promise.all([deliverDictation('ditado falado', pane.ports), vi.advanceTimersByTimeAsync(3_000)]);
    expect(hasPendingDictation()).toBe(true);

    // Operador copia código novo enquanto o ditado está pendente
    clipboard = 'código importante copiado no editor';

    // Ditado pendente é cancelado (por tecla do operador)
    cancelPendingDictation('pane-focused');
    await vi.advanceTimersByTimeAsync(1_000);

    // O clipboard do operador NÃO foi sobrescrito!
    expect(preserveUndelivered).not.toHaveBeenCalled();
    expect(clipboard).toBe('código importante copiado no editor');
    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: 'pane-focused',
        result: 'error',
        errorCode: 'pending-cancelled',
        preserved: false,
      }),
    );
  });

  it('F-1393 M6: ditado pendente copia para a área de transferência se o operador NÃO copiou nada', async () => {
    vi.useFakeTimers();
    let clipboard = 'conteúdo antigo';
    const readClipboard = vi.fn(async () => clipboard);
    const preserveUndelivered = vi.fn(async (text: string) => {
      clipboard = text;
      return true;
    });
    const onSettled = vi.fn();
    const pane = claudePane();
    pane.ports.readClipboard = readClipboard;
    pane.ports.preserveUndelivered = preserveUndelivered;
    pane.ports.onSettled = onSettled;

    // Ditado fica pendente
    pane.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: true };
    await Promise.all([deliverDictation('ditado falado', pane.ports), vi.advanceTimersByTimeAsync(3_000)]);
    expect(hasPendingDictation()).toBe(true);

    // Operador NÃO copiou nada novo no clipboard. Ditado é cancelado por tecla.
    cancelPendingDictation('pane-focused');
    await vi.advanceTimersByTimeAsync(1_000);

    // Texto falado vai para o clipboard para não se perder
    expect(preserveUndelivered).toHaveBeenCalledWith('ditado falado');
    expect(clipboard).toBe('ditado falado');
    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: 'pane-focused',
        result: 'error',
        errorCode: 'pending-cancelled',
        preserved: true,
      }),
    );
  });

  it('M4: exceção na entrega não deixa a entrada presa em delivering', async () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    const onDelivering = vi.fn();
    const pane = claudePane();
    let attempts = 0;
    // O tick do pendente chama deliverOnLanes; um throw ali (IPC principal
    // fora do ar) não pode escapar nem deixar a entrada com delivering=true
    // para sempre — aí cancelPendingDictation passa a mentir ("não cancela,
    // está em voo") e o texto nunca mais sai.
    pane.ports.deliverConfirmed = vi.fn(async () => {
      // A primeira rota devolve `wait` (diálogo aberto) e o pendente nasce;
      // só o TICK do pendente, com o pane livre, é que estoura a exceção.
      if (attempts++ === 0) return 'wait' as const;
      throw new Error('ipc fora do ar');
    });
    pane.ports.onSettled = onSettled;
    pane.ports.onDelivering = onDelivering;
    pane.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: true, queuesInputWhileBusy: true };
    await deliverDictation('abre o PR', pane.ports);
    await vi.advanceTimersByTimeAsync(3_000);
    // Pane ficou livre → o tick tenta entregar e o throw estoura.
    pane.prompt.value = { turnStartSequence: 5, state: 'idle', awaitingInput: false, queuesInputWhileBusy: true };
    await vi.advanceTimersByTimeAsync(5_000);

    // O pendente foi encerrado como falha, não ficou preso.
    expect(hasPendingDictation()).toBe(false);
    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: 'pane-focused',
        result: 'error',
        errorCode: 'pending-failed',
      }),
    );
    // E o teclado do operador volta a poder cancelar (não há entrega em voo).
    expect(cancelPendingDictation('pane-focused')).toBe(false);
  });
});


