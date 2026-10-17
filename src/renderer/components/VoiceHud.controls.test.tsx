/** @vitest-environment jsdom */
/**
 * Bug 7 (Jarvis não clicável): regressão dos controles do HUD — fechar,
 * pausar (parar fala / silenciar), desligar e interagir têm que responder ao
 * clique em QUALQUER estado, apesar do beginDrag no pointerdown da raiz.
 * Os botões escapam do arrasto via stopPropagation; estes testes simulam a
 * sequência real de pointerdown → pointerup → click em cada ctl.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const powerOff = vi.hoisted(() => vi.fn(async () => {}));
const stopSpeech = vi.hoisted(() => vi.fn());
vi.mock('../voice/response-output-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  powerOffJarvis: powerOff,
  stopJarvisSpeech: stopSpeech,
}));

import { VoiceHud } from './VoiceHud';
import { useVoiceStore } from '../voice/voice-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

// jsdom não tem construtor PointerEvent — monta um Event com os campos que
// o componente lê (button/clientX no limiar do CLICK_SLOP_PX).
function pointerEvent(
  type: string,
  props: Record<string, unknown> = {},
): PointerEvent {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.assign(ev, {
    pointerId: 1,
    button: 0,
    buttons: 1,
    clientX: 10,
    clientY: 10,
    screenX: 110,
    screenY: 110,
    ...props,
  });
  return ev;
}

async function realClick(el: Element): Promise<void> {
  el.dispatchEvent(pointerEvent('pointerdown'));
  el.dispatchEvent(pointerEvent('pointerup', { buttons: 0 }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await act(async () => {});
}

const ctlByTitle = (host: HTMLElement, title: string): HTMLButtonElement => {
  const btn = [...host.querySelectorAll('.voice-hud__ctl')].find(
    (b) => b.getAttribute('title') === title,
  );
  expect(btn, `ctl "${title}" deveria existir no HUD`).toBeTruthy();
  return btn as HTMLButtonElement;
};

describe('VoiceHud — controles clicáveis em qualquer estado (Bug 7)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    powerOff.mockClear();
    stopSpeech.mockClear();
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
      lastUndeliveredDictation: null,
      hud: { mode: 'mini', corner: 'br', dx: 16, dy: 16, width: 300 },
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

  it('mini idle: clique no corpo do pill não desliga nem esconde (só wake/expand)', async () => {
    render();
    const pill = host.querySelector('.voice-hud--mini');
    expect(pill).toBeTruthy();
    await realClick(pill as Element);
    // canClickWake: pede wake; o pill continua mini e NADA destrutivo roda.
    expect(useVoiceStore.getState().hud.mode).toBe('mini');
    expect(powerOff).not.toHaveBeenCalled();
  });

  it('mini listening: botão “Desligar sessão Jarvis” chama powerOffJarvis', async () => {
    act(() => {
      useVoiceStore.setState({ status: 'listening' } as never);
    });
    render();
    await realClick(ctlByTitle(host, 'Desligar sessão Jarvis'));
    expect(powerOff).toHaveBeenCalled();
  });

  it('mini listening: botão “Parar fala” chama stopJarvisSpeech', async () => {
    act(() => {
      useVoiceStore.setState({ status: 'speaking' } as never);
    });
    render();
    await realClick(ctlByTitle(host, 'Parar fala atual'));
    expect(stopSpeech).toHaveBeenCalled();
  });

  it('mini listening: botão fechar (ocultar) muda o modo para hidden', async () => {
    act(() => {
      useVoiceStore.setState({ status: 'listening' } as never);
    });
    render();
    await realClick(ctlByTitle(host, 'Ocultar (só áudio)'));
    expect(useVoiceStore.getState().hud.mode).toBe('hidden');
  });

  it('expanded: power e minimizar do titlebar respondem apesar do beginDrag', async () => {
    act(() => {
      useVoiceStore.setState({
        status: 'listening',
        hud: { mode: 'expanded', corner: 'br', dx: 16, dy: 16, width: 300 },
      } as never);
    });
    render();
    await realClick(ctlByTitle(host, 'Desligar sessão Jarvis'));
    expect(powerOff).toHaveBeenCalled();
    await realClick(ctlByTitle(host, 'Minimizar (pill)'));
    expect(useVoiceStore.getState().hud.mode).toBe('mini');
  });

  it('expanded error: botão fechar também esconde o HUD', async () => {
    act(() => {
      useVoiceStore.setState({
        status: 'error',
        error: 'mic sem permissão',
        hud: { mode: 'expanded', corner: 'br', dx: 16, dy: 16, width: 300 },
      } as never);
    });
    render();
    await realClick(ctlByTitle(host, 'Ocultar (só áudio)'));
    expect(useVoiceStore.getState().hud.mode).toBe('hidden');
  });
});
