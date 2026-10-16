/** @vitest-environment jsdom */
import fs from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// "Reenviar" entrega o texto de novo pelo MESMO caminho do ditado.
const resend = vi.hoisted(() =>
  vi.fn(async (_text: string, ..._hooks: unknown[]) => ({ ok: true, paneId: 'pane-focused' })),
);
const setConfig = vi.hoisted(() => vi.fn());
vi.mock('../voice/voice-run-jarvis-turn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../voice/voice-run-jarvis-turn')>()),
  routeDictation: resend,
}));

import { VoiceHud } from './VoiceHud';
import { useVoiceStore } from '../voice/voice-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const PENDING_NOTE =
  'O painel está com uma pergunta aberta ou ocupado. O ditado entra sozinho quando ele ficar livre; se você digitar no painel, ele é cancelado.';

describe('F-1393 — HUD do ditado legível', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setConfig.mockReset();
    vi.stubGlobal('nexus', { voice: { setConfig }, settings: {} });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    useVoiceStore.setState({
      status: 'idle',
      error: null,
      lastTranscript: '',
      micHealth: 'ok',
      dictationDelivery: null,
      hud: { mode: 'expanded', corner: 'br', dx: 16, dy: 16, width: 300 },
      info: {
        enabled: true,
        wakeWordEnabled: false,
        jarvisLive: { enabled: false },
        dictationOutputMode: 'portuguese',
      } as never,
    } as never);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const render = () => act(() => root.render(<VoiceHud />));
  const label = () => host.querySelector('.voice-hud__label')?.textContent;

  it('pendente troca o título "Jarvis pronta" por "Ditado aguardando" e mostra a explicação inteira', () => {
    useVoiceStore.setState({ dictationDelivery: 'pending', note: PENDING_NOTE } as never);
    render();
    expect(label()).toBe('Ditado aguardando');
    const note = host.querySelector('.voice-hud__detail--note');
    expect(note?.textContent).toContain(PENDING_NOTE);
  });

  it('enfileirado mostra "Ditado na fila"; sem entrega volta a "Jarvis pronta"', () => {
    useVoiceStore.setState({ dictationDelivery: 'queued', note: 'na fila' } as never);
    render();
    expect(label()).toBe('Ditado na fila');
    act(() => useVoiceStore.setState({ dictationDelivery: null } as never));
    expect(label()).toBe('Jarvis pronta');
  });

  it('o HUD fica visível com ditado pendente mesmo com a Jarvis desligada', () => {
    useVoiceStore.setState({
      dictationDelivery: 'pending',
      note: PENDING_NOTE,
      info: { enabled: false, wakeWordEnabled: false, jarvisLive: { enabled: false } } as never,
    } as never);
    render();
    expect(label()).toBe('Ditado aguardando');
  });

  it('a nota quebra linha em vez de cortar com reticências; tema claro sem fundo escurecido', () => {
    const css = fs.readFileSync(path.join(__dirname, '../styles/voice-hud.css'), 'utf-8');
    const noteRule = /\.voice-hud__detail--note\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '';
    expect(noteRule).toMatch(/white-space:\s*normal/u);
    const lightRule = /\[data-theme='nexus-light'\]\s*\.voice-hud\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '';
    expect(lightRule).toContain('var(--bg-elevated)');
    expect(lightRule).not.toContain('#000');
  });
});

describe('F-1419 — refúgio do ditado que ficou sem destino', () => {
  let host: HTMLDivElement;
  let root: Root;
  const writeText = vi.fn(async () => {});

  beforeEach(() => {
    setConfig.mockReset();
    vi.stubGlobal('nexus', { voice: { setConfig }, settings: {} });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));
    vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText } });
    writeText.mockClear();
    resend.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    useVoiceStore.setState({
      status: 'idle',
      error: null,
      lastTranscript: '',
      micHealth: 'ok',
      dictationDelivery: null,
      lastUndeliveredDictation: null,
      hud: { mode: 'expanded', corner: 'br', dx: 16, dy: 16, width: 300 },
      info: {
        enabled: true,
        wakeWordEnabled: false,
        jarvisLive: { enabled: false },
        dictationOutputMode: 'portuguese',
      } as never,
    } as never);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const render = () => act(() => root.render(<VoiceHud />));
  const refugeText = () =>
    host.querySelector('.voice-hud__refuge')?.textContent ?? '';

  it('sem ditado perdido, não há offered action no HUD', () => {
    render();
    expect(host.querySelector('.voice-hud__refuge')).toBeNull();
  });

  it('ditado perdido aparece com o texto e as ações copiar/reenviar', () => {
    useVoiceStore.setState({
      lastUndeliveredDictation: {
        text: 'o texto que o operador falou',
        paneId: 'pane-focused',
        reason: 'pending-cancelled',
      },
    } as never);
    render();
    expect(refugeText()).toContain('o texto que o operador falou');
    const labels = [...host.querySelectorAll('.voice-hud__action')].map(
      (b) => b.textContent,
    );
    expect(labels).toContain('Copiar ditado');
    expect(labels).toContain('Reenviar');
  });

  it('"Copiar ditado" escreve o texto e limpa o refúgio', async () => {
    useVoiceStore.setState({
      lastUndeliveredDictation: {
        text: 'o texto que o operador falou',
        paneId: 'pane-focused',
        reason: 'pending-cancelled',
      },
    } as never);
    render();
    const copy = [...host.querySelectorAll('.voice-hud__action')].find(
      (b) => b.textContent === 'Copiar ditado',
    ) as HTMLButtonElement;
    await act(async () => {
      copy.click();
    });
    expect(writeText).toHaveBeenCalledWith('o texto que o operador falou');
    expect(useVoiceStore.getState().lastUndeliveredDictation).toBeNull();
  });

  it('"Reenviar" entrega o texto de novo e limpa o refúgio', async () => {
    useVoiceStore.setState({
      lastUndeliveredDictation: {
        text: 'o texto que o operador falou',
        paneId: 'pane-focused',
        reason: 'pending-cancelled',
      },
    } as never);
    render();
    const again = [...host.querySelectorAll('.voice-hud__action')].find(
      (b) => b.textContent === 'Reenviar',
    ) as HTMLButtonElement;
    await act(async () => {
      again.click();
    });
    expect(resend.mock.calls[0]?.[0]).toBe('o texto que o operador falou');
    expect(useVoiceStore.getState().lastUndeliveredDictation).toBeNull();
  });

  const seed = (reason: string) =>
    useVoiceStore.setState({
      lastUndeliveredDictation: { text: 'o texto que o operador falou', paneId: 'pane-focused', reason },
    } as never);
  const action = (name: string) =>
    [...host.querySelectorAll('.voice-hud__action')].find(
      (b) => b.textContent === name,
    ) as HTMLButtonElement;

  it('"Copiar ditado" que falha mantém o refúgio e o "Reenviar" à mão', async () => {
    writeText.mockRejectedValueOnce(new Error('sem foco'));
    seed('pending-cancelled');
    render();
    await act(async () => {
      action('Copiar ditado').click();
    });
    expect(useVoiceStore.getState().lastUndeliveredDictation).not.toBeNull();
    expect(useVoiceStore.getState().note).toContain('Não consegui copiar');
    expect(action('Reenviar')).toBeTruthy();
  });

  it('"Reenviar" que fica pendente mostra "Ditado aguardando", não "recusou"', async () => {
    resend.mockResolvedValueOnce({ ok: false, reason: 'pending', paneId: 'pane-focused' } as never);
    seed('pending-cancelled');
    render();
    await act(async () => {
      action('Reenviar').click();
    });
    expect(resend).toHaveBeenCalledWith(
      'o texto que o operador falou',
      expect.any(Function),
      expect.any(Function),
    );
    expect(useVoiceStore.getState().note).toBe(PENDING_NOTE);
    expect(host.querySelector('.voice-hud__label')?.textContent).toBe('Ditado aguardando');
  });

  it('motivo *-lost avisa para conferir o pane antes de reenviar', () => {
    for (const reason of ['pending-lost', 'delivery-lost']) {
      seed(reason);
      render();
      expect(refugeText()).toContain('Confira o pane antes de reenviar');
    }
    seed('pending-cancelled');
    render();
    expect(refugeText()).not.toContain('Confira o pane');
  });
});

describe('HUD da JARVIS desativada', () => {
  let host: HTMLDivElement;
  let root: Root;

  const disabledInfo = {
    enabled: false,
    speakMode: 'off',
    wakeWordEnabled: false,
    jarvisLive: { enabled: false },
    dictationOutputMode: 'portuguese',
  };

  beforeEach(() => {
    setConfig.mockReset();
    vi.stubGlobal('nexus', { voice: { setConfig }, settings: {} });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    useVoiceStore.setState({
      status: 'idle',
      error: null,
      lastTranscript: '',
      micHealth: 'ok',
      dictationDelivery: null,
      responseMuted: false,
      hud: { mode: 'mini', corner: 'br', dx: 16, dy: 16, width: 300 },
      info: disabledInfo as never,
    } as never);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const render = () => act(() => root.render(<VoiceHud />));

  it('permanece visível, pode ser aberto por botão e explica as flags desligadas', () => {
    render();
    const trigger = host.querySelector(
      'button[aria-label="Abrir controles da JARVIS: desativada"]',
    ) as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    expect(host.querySelector('.voice-hud__mini-label')?.textContent).toBe('desativada');
    act(() => trigger.click());
    expect(host.querySelector('.voice-hud--expanded')).toBeTruthy();
    expect(host.textContent).toContain('A JARVIS está desativada nas configurações.');
    expect(host.textContent).toContain('Respostas faladas estão desativadas nas configurações.');
  });

  it('ativa a flag principal pelo HUD e atualiza o estado exibido', async () => {
    setConfig.mockResolvedValueOnce({ ...disabledInfo, enabled: true });
    render();
    const trigger = host.querySelector('button[aria-label*="desativada"]') as HTMLButtonElement;
    act(() => trigger.click());
    const enable = [...host.querySelectorAll('.voice-hud__action')].find(
      (button) => button.textContent === 'Ativar JARVIS',
    ) as HTMLButtonElement;
    await act(async () => enable.click());
    expect(setConfig).toHaveBeenCalledWith({ enabled: true });
    expect(useVoiceStore.getState().info?.enabled).toBe(true);
  });

  it('move pelo mesmo botão compacto sem disparar a ação de abrir', () => {
    vi.stubGlobal('innerWidth', 1_000);
    vi.stubGlobal('innerHeight', 800);
    render();
    const shell = host.querySelector('.voice-hud') as HTMLDivElement;
    vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue({
      left: 20,
      top: 20,
      width: 120,
      height: 32,
      bottom: 52,
      right: 140,
      x: 20,
      y: 20,
      toJSON: () => ({}),
    });
    const trigger = host.querySelector('button[aria-label*="desativada"]') as HTMLButtonElement;
    act(() => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 30 }));
      window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 160, clientY: 100 }));
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 160, clientY: 100 }));
    });
    expect(useVoiceStore.getState().hud.corner).toBe('tl');
    expect(host.querySelector('.voice-hud--expanded')).toBeNull();
  });
});
