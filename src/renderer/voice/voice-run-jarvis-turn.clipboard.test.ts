/** @vitest-environment jsdom */
/**
 * M6 (F-1419): o port REAL de leitura da área de transferência.
 *
 * `voice-run-jarvis-turn.ts` mapeava `readClipboard` com `.catch(() => '')`:
 * janela sem foco faz `readText()` REJEITAR, a falha virava string vazia e o
 * `dictation-delivery` comparava essa Mentira contra o baseline real — um
 * valor fabricado lido como "o operador copiou algo novo". Três estados num
 * tipo só: li algo, não li, e o que li não é o que está lá agora.
 *
 * Este teste exercita o port de verdade (routeDictation + terminal-host),
 * não um dublê com o mesmo nome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deliverConfirmed = vi.hoisted(() => vi.fn());
const deliverOperator = vi.hoisted(() => vi.fn());
const probePromptState = vi.hoisted(() => vi.fn());
const writeText = vi.hoisted(() => vi.fn());
const readText = vi.hoisted(() => vi.fn());

// O seam real: `getPaneSessionId`/`probePanePromptState`/os submits saem TODOS
// de terminal-host, que guarda as sessões num mapa interno. Sem pane vivo o
// roteamento responde `no-live-pane` e nenhum port é tocado.
vi.mock('../terminal/terminal-host', () => ({
  getPaneSessionId: (paneId: string) => (paneId === 'p1' ? 'sess-1' : null),
  probePanePromptState: probePromptState,
  submitDictationToPaneConfirmed: deliverConfirmed,
  submitDictationToPaneOperatorInput: deliverOperator,
  submitPromptToPane: vi.fn(async () => true),
  setRestoredPanesHandler: vi.fn(),
  setTerminalSnapshotProvider: vi.fn(),
}));

// Um pane focado e VIVO é o mínimo para o roteamento chegar nos ports.
// Mock parcial: `setTerminalSnapshotProvider` é chamado no import do
// terminal-host (que só precisa existir, não precisa funcionar aqui).
vi.mock('../state/layout-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state/layout-store')>()),
  useLayoutStore: {
    getState: () => ({
      focusedPaneId: 'p1',
      // Inline: vi.mock é hoisted e não enxerga variáveis de topo.
      root: { kind: 'leaf', id: 'p1', pane: { id: 'p1', kind: 'terminal', title: 'p1' } },
    }),
    subscribe: vi.fn(() => () => {}),
  },
}));
vi.mock('../state/session-state-store', () => ({
  useSessionStateStore: {
    getState: () => ({ sessions: { p1: 'sess-1' } }),
    subscribe: vi.fn(() => () => {}),
  },
}));
vi.mock('../state/orch-store', () => ({
  useOrchStore: {
    getState: () => ({ paneMissions: {} }),
    subscribe: vi.fn(() => () => {}),
  },
}));
// Corta o grafo pesado (workspace-store → terminal-host), padrão dos testes
// vizinhos de voice: o alvo é o PORT do clipboard, não o host de terminais.
vi.mock('../state/workspace-store', () => ({
  useWorkspaceStore: { getState: () => ({ current: { path: '/tmp/ws' } }) },
}));
vi.mock('../state/gamification-store', () => ({
  useGamificationStore: { getState: () => ({}) },
}));
vi.mock('./voice-live-ipc', () => ({
  logVoiceEvent: vi.fn(),
  liveEndTurn: vi.fn(),
  liveStatus: vi.fn(),
  quiesceLiveForClassic: vi.fn(),
  queueLiveContextRefresh: vi.fn(),
}));

import { routeDictation } from './voice-run-jarvis-turn';
import { cancelPendingDictation, hasPendingDictation, resetPendingDictationsForTests } from './dictation-delivery';
import { useVoiceStore } from './voice-store';

describe('M6 — o port real de leitura da área de transferência', () => {
  afterEach(() => {
    resetPendingDictationsForTests();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    resetPendingDictationsForTests();
    vi.clearAllMocks();
    // Pane com diálogo: o ditado fica PENDENTE e o `settle` vai consultar a
    // área de transferência para não sobrescrever o que o operador copiou.
    probePromptState.mockResolvedValue({ turnStartSequence: 5, state: 'idle', awaitingInput: true });
    // A primeira rota devolve `wait` (diálogo aberto) e o PENDENTE nasce; os
    // ticks seguintes devolvem `lost` — o texto foi escrito mas o envio não se
    // confirmou, que é o desfecho que consulta a área de transferência.
    deliverConfirmed.mockResolvedValueOnce('wait').mockResolvedValue('lost');
    deliverOperator.mockResolvedValue(false);
    writeText.mockResolvedValue(undefined);
    vi.stubGlobal('nexus', {
      voice: { logVoice: vi.fn() },
      layout: {},
      session: {},
    });
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      clipboard: { readText, writeText },
    });
  });

  /** Deixa o painel ficar livre e o pendente ser assombrado. */
  const freeThePane = async (onSettled: ReturnType<typeof vi.fn>) => {
    probePromptState.mockResolvedValue({ turnStartSequence: 5, state: 'idle', awaitingInput: false });
    await vi.waitFor(
      () => expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ result: 'error' })),
      { timeout: 5_000, interval: 100 },
    );
  };

  it('leitura que falha NÃO inventa "o operador copiou algo novo"', async () => {
    // A primeira leitura (baseline, no momento em que o ditado ficou
    // pendente) funciona; a segunda falha — a janela perdeu o foco entre as
    // duas. Esse é o cenário real: um `''` fabricado na segunda leitura é
    // diferente do baseline e o código conclui "o operador copiou".
    readText.mockResolvedValueOnce('conteúdo antigo').mockRejectedValue(
      new Error('Document is not focused'),
    );
    const onSettled = vi.fn();

    await routeDictation('ditado falado', onSettled);
    await vi.waitFor(() => expect(probePromptState).toHaveBeenCalled(), {
      timeout: 5_000,
      interval: 100,
    });
    await freeThePane(onSettled);

    // "Não sei o que o operador copiou" NÃO é motivo para descartar o texto:
    // a escrita do refúgio acontece e o texto continua recuperável.
    // O port real de refúgio é `navigator.clipboard.writeText`.
    expect(writeText).toHaveBeenCalledWith('ditado falado');
    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'error', preserved: true }),
    );
  });

  it('leitura que falha desde o início também guarda o texto', async () => {
    // Janela sem foco o tempo todo: as DUAS leituras falham.
    readText.mockRejectedValue(new Error('Document is not focused'));
    const onSettled = vi.fn();

    await routeDictation('ditado falado', onSettled);
    await vi.waitFor(() => expect(probePromptState).toHaveBeenCalled(), {
      timeout: 5_000,
      interval: 100,
    });
    await freeThePane(onSettled);

    expect(writeText).toHaveBeenCalledWith('ditado falado');
  });

  it('o operador copiou de verdade: o clipboard dele continua intacto', async () => {
    // Contraprova: quando a leitura FUNCIONA e o conteúdo mudou, o ditado
    // respeita a área de transferência do operador e não copia por cima.
    readText
      .mockResolvedValueOnce('conteúdo antigo')
      .mockResolvedValue('código que o operador copiou');
    const onSettled = vi.fn();

    await routeDictation('ditado falado', onSettled);
    await vi.waitFor(() => expect(probePromptState).toHaveBeenCalled(), {
      timeout: 5_000,
      interval: 100,
    });
    await freeThePane(onSettled);

    expect(writeText).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'error', preserved: false }),
    );
  });

  it('o refúgio CHEGA no voice-store: o texto continua recuperável pelo HUD', async () => {
    // O cenário exato da revisão, ponta a ponta pelo port real: o operador
    // dita, o painel tem um diálogo, ele copia algo no editor e responde o
    // diálogo. O clipboard dele é respeitado e o texto falado ia embora.
    readText.mockResolvedValueOnce('conteúdo qualquer').mockResolvedValue('código copiado pelo operador');
    useVoiceStore.setState({ lastUndeliveredDictation: null });
    // O painel recusa (diálogo aberto) → o ditado vira PENDENTE.
    probePromptState.mockResolvedValue({ turnStartSequence: 5, state: 'idle', awaitingInput: true });
    deliverConfirmed.mockReset().mockResolvedValue('wait');

    await routeDictation('o texto ditado que o operador falou');
    await vi.waitFor(() => expect(probePromptState).toHaveBeenCalled(), {
      timeout: 5_000,
      interval: 100,
    });
    expect(hasPendingDictation()).toBe(true);

    // Ele responde o diálogo com "y": cancelPendingDictation.
    cancelPendingDictation('p1');

    await vi.waitFor(
      () => expect(useVoiceStore.getState().lastUndeliveredDictation).not.toBeNull(),
      { timeout: 5_000, interval: 100 },
    );
    expect(useVoiceStore.getState().lastUndeliveredDictation).toMatchObject({
      text: 'o texto ditado que o operador falou',
      paneId: 'p1',
      reason: 'pending-cancelled',
    });
    // O clipboard do operador segue intacto — o refúgio NÃO sobrescreveu nada.
    expect(writeText).not.toHaveBeenCalled();
  });
});