import { describe, it, expect, vi } from 'vitest';
import {
  deliverDictation,
  type DictationDeliveryPorts,
  type DictationLogLevel,
} from './dictation-delivery';

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
