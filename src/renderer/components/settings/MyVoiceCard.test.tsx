/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recorder = vi.hoisted(() => ({
  duration: 5,
  peak: 0.2,
  started: [] as number[],
}));

vi.mock('../../voice/voice-sample-recorder', () => ({
  VoiceSampleRecorder: class {
    onLevel: ((level: number) => void) | null = null;
    async start(maxSec: number) {
      recorder.started.push(maxSec);
    }
    async stop() {
      return {
        wav: new Uint8Array([1, 2, 3]),
        durationSec: recorder.duration,
        sampleRate: 48_000,
        peakRms: recorder.peak,
      };
    }
    cancel() {}
  },
}));

import { MyVoiceCard } from './MyVoiceCard';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const api = {
  list: vi.fn(),
  begin: vi.fn(),
  verifyDeclaration: vi.fn(),
  create: vi.fn(),
  cancel: vi.fn(async () => ({ ok: true })),
  remove: vi.fn(),
};

function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(text));
  if (!found) throw new Error(`botão "${text}" ausente: ${host.textContent}`);
  return found;
}

async function click(text: string) {
  await act(async () => {
    button(text).click();
  });
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function render(connected = true) {
  await act(async () => {
    root.render(<MyVoiceCard elevenLabsConnected={connected} />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  recorder.duration = 5;
  recorder.peak = 0.2;
  recorder.started = [];
  api.list.mockResolvedValue([]);
  api.begin.mockResolvedValue({
    sessionId: 'a'.repeat(32),
    code: '482913',
    consentVersion: 'v',
    readingText: 'Texto para ler em voz alta.',
    expiresAt: Date.now() + 60_000,
  });
  Object.defineProperty(window, 'nexus', { configurable: true, value: { voiceClone: api, platform: 'win32' } });
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  Reflect.deleteProperty(window, 'nexus');
});

describe('Minha voz', () => {
  it('sem ElevenLabs conectada, não deixa começar e diz o que fazer', async () => {
    await render(false);
    expect(button('Criar minha voz').disabled).toBe(true);
    expect(host.textContent).toContain('Conecte a ElevenLabs');
  });

  it('só continua com nome e os dois consentimentos marcados', async () => {
    await render();
    await click('Criar minha voz');
    expect(host.textContent).toContain('dado biométrico');
    expect(button('Continuar').disabled).toBe(true);
    type(host.querySelector<HTMLInputElement>('input:not([type])')!, 'Ana Souza');
    const boxes = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    act(() => boxes[0].click());
    expect(button('Continuar').disabled).toBe(true);
    act(() => boxes[1].click());
    expect(button('Continuar').disabled).toBe(false);
    await click('Continuar');
    expect(api.begin).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Eu, Ana Souza, sou maior de 18 anos');
    expect(host.textContent).toContain('Código 4 8 2 9 1 3');
  });

  async function throughConsent() {
    await render();
    await click('Criar minha voz');
    type(host.querySelector<HTMLInputElement>('input:not([type])')!, 'Ana Souza');
    const boxes = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    act(() => boxes[0].click());
    act(() => boxes[1].click());
    await click('Continuar');
  }

  it('declaração recusada mostra o que faltou e não avança', async () => {
    api.verifyDeclaration.mockResolvedValue({ ok: false, missing: ['código'], error: 'Não ouvi na declaração: código.' });
    await throughConsent();
    await click('Gravar declaração');
    expect(recorder.started).toEqual([40]);
    await click('Parar e conferir');
    expect(api.verifyDeclaration).toHaveBeenCalledWith({
      sessionId: 'a'.repeat(32),
      speakerName: 'Ana Souza',
      wav: expect.any(Uint8Array),
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('código');
    expect(host.textContent).toContain('Gravar declaração');
  });

  it('silêncio não vai para conferência', async () => {
    recorder.peak = 0;
    await throughConsent();
    await click('Gravar declaração');
    await click('Parar e conferir');
    expect(api.verifyDeclaration).not.toHaveBeenCalled();
    expect(host.textContent).toContain('gravou silêncio');
  });

  it('leitura curta não cria; leitura de 1 min 30 s cria a voz', async () => {
    api.verifyDeclaration.mockResolvedValue({ ok: true });
    api.create.mockResolvedValue({
      ok: true,
      receipt: { id: 'r'.repeat(24), provider: 'elevenlabs', voiceId: 'v1', voiceName: 'Voz de Ana', createdAt: '2026-10-19T12:00:00Z', requiresVerification: false },
    });
    await throughConsent();
    await click('Gravar declaração');
    await click('Parar e conferir');
    expect(host.textContent).toContain('2 de 2');

    recorder.duration = 30;
    await click('Gravar leitura');
    expect(recorder.started.at(-1)).toBe(180);
    await click('Parar');
    expect(host.textContent).toContain('precisa de pelo menos 1:00');
    expect(button('Criar a voz na ElevenLabs').disabled).toBe(true);

    recorder.duration = 90;
    await click('Gravar de novo');
    await click('Parar');
    expect(button('Criar a voz na ElevenLabs').disabled).toBe(false);
    api.list.mockResolvedValue([
      { id: 'r'.repeat(24), provider: 'elevenlabs', voiceId: 'v1', voiceName: 'Voz de Ana', createdAt: '2026-10-19T12:00:00Z', requiresVerification: false },
    ]);
    await click('Criar a voz na ElevenLabs');
    expect(api.create).toHaveBeenCalledWith({
      sessionId: 'a'.repeat(32),
      voiceName: 'Voz de Ana',
      samples: [expect.any(Uint8Array)],
    });
    expect(host.textContent).toContain('criada na sua conta da ElevenLabs');
    expect(host.textContent).toContain('recibo neste computador');
  });

  it('cancelar no meio encerra a sessão no Main', async () => {
    await throughConsent();
    await click('Cancelar');
    expect(api.cancel).toHaveBeenCalledWith('a'.repeat(32));
    expect(host.textContent).toContain('Criar minha voz');
  });

  it('apagar pede confirmação; se o provedor falhar, oferece apagar só daqui', async () => {
    api.list.mockResolvedValue([
      { id: 'r'.repeat(24), provider: 'elevenlabs', voiceId: 'v1', voiceName: 'Voz de Ana', createdAt: '2026-10-19T12:00:00Z', requiresVerification: true },
    ]);
    api.remove
      .mockResolvedValueOnce({ ok: false, error: 'A ElevenLabs recusou apagar a voz (HTTP 500).', canRemoveLocally: true })
      .mockResolvedValueOnce({ ok: true, removedAtProvider: false });
    await render();
    expect(host.textContent).toContain('verificação extra');
    await click('Apagar minha voz');
    expect(api.remove).not.toHaveBeenCalled();
    await click('Apagar na ElevenLabs e aqui');
    expect(api.remove).toHaveBeenLastCalledWith({ id: 'r'.repeat(24), localOnly: false });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('HTTP 500');
    api.list.mockResolvedValue([]);
    await click('Apagar só deste computador');
    expect(api.remove).toHaveBeenLastCalledWith({ id: 'r'.repeat(24), localOnly: true });
  });

  it('sem a ponte do preload não desenha nada', async () => {
    Object.defineProperty(window, 'nexus', { configurable: true, value: {} });
    await render();
    expect(host.innerHTML).toBe('');
  });
});
