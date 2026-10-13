/** @vitest-environment jsdom */
import fs from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// "Reenviar" entrega o texto de novo pelo MESMO caminho do ditado.
const resend = vi.hoisted(() => vi.fn(async () => ({ ok: true, paneId: 'pane-focused' })));
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
    vi.stubGlobal('nexus', { voice: {}, settings: {} });
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
    vi.stubGlobal('nexus', { voice: {}, settings: {} });
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
    expect(resend).toHaveBeenCalledWith('o texto que o operador falou');
    expect(useVoiceStore.getState().lastUndeliveredDictation).toBeNull();
  });
});
