/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceStore } from '../voice/voice-store';
import { DictationModeChip } from './DictationModeChip';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

type VoiceInfoPatch = { dictationOutputMode?: 'english' | 'portuguese' };

const setConfig = vi.fn(async (patch: VoiceInfoPatch) => ({
  dictationOutputMode: patch.dictationOutputMode,
}));

function setStoreInfo(info: VoiceInfoPatch | null): void {
  useVoiceStore.setState({
    info: info as unknown as ReturnType<typeof useVoiceStore.getState>['info'],
  });
}

describe('DictationModeChip', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setConfig.mockClear();
    (window as unknown as { nexus: unknown }).nexus = {
      voice: { setConfig },
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    setStoreInfo(null);
  });

  it('mostra CODE por default (english) e CHAT quando portuguese', () => {
    setStoreInfo(null);
    act(() => root.render(<DictationModeChip />));
    expect(host.querySelector('button')?.textContent).toBe('CODE');

    setStoreInfo({ dictationOutputMode: 'portuguese' });
    act(() => root.render(<DictationModeChip />));
    expect(host.querySelector('button')?.textContent).toBe('CHAT');
  });

  it('clique alterna o modo via setConfig e reflete a resposta no store', async () => {
    setStoreInfo({ dictationOutputMode: 'english' });
    act(() => root.render(<DictationModeChip />));

    await act(async () => {
      host.querySelector('button')?.click();
      await Promise.resolve();
    });

    expect(setConfig).toHaveBeenCalledWith({ dictationOutputMode: 'portuguese' });
    expect(host.querySelector('button')?.textContent).toBe('CHAT');
  });

  it('falha do setConfig não muda o rótulo (chip não mente)', async () => {
    setConfig.mockRejectedValueOnce(new Error('offline'));
    setStoreInfo({ dictationOutputMode: 'english' });
    act(() => root.render(<DictationModeChip />));

    await act(async () => {
      host.querySelector('button')?.click();
      await Promise.resolve();
    });

    expect(host.querySelector('button')?.textContent).toBe('CODE');
  });
});
