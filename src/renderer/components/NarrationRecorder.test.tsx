/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** F-1602 — gravar a narração no Estúdio e alinhar ao roteiro. */

const recorder = vi.hoisted(() => ({ peak: 0.2, duration: 42 }));
vi.mock('../voice/voice-sample-recorder', () => ({
  VoiceSampleRecorder: class {
    onLevel: ((level: number) => void) | null = null;
    async start() {}
    async stop() {
      return { wav: new Uint8Array([82, 73, 70, 70]), durationSec: recorder.duration, sampleRate: 48_000, peakRms: recorder.peak };
    }
    cancel() {}
  },
}));

import { NarrationRecorder } from './NarrationRecorder';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const studio = { alignRecording: vi.fn() };

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

function typeScript(value: string) {
  const textarea = host.querySelector('textarea')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  recorder.peak = 0.2;
  Object.defineProperty(window, 'nexus', { configurable: true, value: { videoStudio: studio } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(window, 'nexus');
});

describe('Gravar narração', () => {
  it('grava, mostra a duração e alinha com o roteiro pela ElevenLabs', async () => {
    const done = vi.fn();
    studio.alignRecording.mockResolvedValue({
      ok: true,
      audioPath: 'promo/assets/narration-recorded-1.wav',
      words: 56,
      matchedRatio: 1,
      costUsd: 0.0026,
      warnings: [],
      files: ['promo/assets/narration.timeline.json'],
    });
    await act(async () => {
      root.render(<NarrationRecorder projectPath="promo" onDone={done} />);
    });
    expect(button('Salvar e alinhar').disabled).toBe(true);
    typeScript('O Claude escreve.');
    await click('Gravar');
    await click('Parar');
    expect(host.textContent).toContain('Gravado: 0:42');
    await click('Salvar e alinhar');
    expect(studio.alignRecording).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: 'promo', script: 'O Claude escreve.', engine: 'elevenlabs', wav: expect.any(Uint8Array) }),
    );
    expect(host.textContent).toContain('56 palavras, 100% reconhecidas');
    expect(done).toHaveBeenCalled();
  });

  it('no computador pede o OK para baixar o modelo e reaproveita a gravação já salva', async () => {
    studio.alignRecording
      .mockResolvedValueOnce({ ok: false, needsModelDownload: true, error: 'baixa', audioPath: 'promo/assets/narration-recorded-1.wav' })
      .mockResolvedValueOnce({ ok: true, audioPath: 'promo/assets/narration-recorded-1.wav', words: 3, matchedRatio: 1, costUsd: 0, warnings: [], files: [] });
    await act(async () => {
      root.render(<NarrationRecorder projectPath="promo" onDone={vi.fn()} />);
    });
    typeScript('Olá a todos.');
    const select = host.querySelector('select')!;
    act(() => {
      select.value = 'local';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('Gravar');
    await click('Parar');
    await click('Salvar e alinhar');
    expect(host.textContent).toContain('639 MB');
    await click('Baixar e alinhar');
    expect(studio.alignRecording.mock.calls[1][0]).toEqual({
      projectPath: 'promo',
      script: 'Olá a todos.',
      engine: 'local',
      audioPath: 'promo/assets/narration-recorded-1.wav',
      allowModelDownload: true,
    });
  });

  it('gravação em silêncio não vai para o alinhamento', async () => {
    recorder.peak = 0;
    await act(async () => {
      root.render(<NarrationRecorder projectPath="promo" onDone={vi.fn()} />);
    });
    typeScript('Olá.');
    await click('Gravar');
    await click('Parar');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('silêncio');
    expect(button('Salvar e alinhar').disabled).toBe(true);
  });
});
