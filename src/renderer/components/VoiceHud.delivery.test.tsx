/** @vitest-environment jsdom */
import fs from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
