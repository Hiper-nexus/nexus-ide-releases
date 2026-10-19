/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceStore } from '../voice/voice-store';
import { VoiceSettings } from './VoiceSettings';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const info = {
  stt: { active: null, chain: [] },
  tts: { active: null, chain: [] },
  jarvisBrain: { active: null, chain: [] },
  speakMode: 'off',
  dictationOutputMode: 'english',
  holdToTalkMs: 400,
  routing: 'focused',
  pushToTalkKeyCode: null,
  shortcut: 'F13',
  hotkeyMode: 'hold',
  hotkeyScope: 'global',
  hotkeyArmed: true,
  wakeWordEnabled: true,
  jarvisLive: { enabled: false, transport: 'classic', openaiVoice: 'ash', voiceName: 'Charon' },
  persona: { assistantName: 'Jarvis', userName: '', customInstructions: '' },
  ttsVoice: 'ash',
  keys: [],
};

let mounted: { host: HTMLDivElement; root: Root } | null = null;

function render(platform: NodeJS.Platform): HTMLDivElement {
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: { platform, voice: { getInfo: vi.fn(async () => info) } },
  });
  useVoiceStore.setState({ info: info as never });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { host, root };
  act(() => root.render(<VoiceSettings embedded />));
  return host;
}

describe('VoiceSettings: textos por sistema (F-1579)', () => {
  beforeEach(() => {
    useVoiceStore.setState({ info: null });
  });

  afterEach(() => {
    if (mounted) {
      act(() => mounted!.root.unmount());
      mounted.host.remove();
      mounted = null;
    }
    Reflect.deleteProperty(window, 'nexus');
  });

  it('no Windows a wake word diz que a detecção é local neste computador, sem citar o Mac', () => {
    const host = render('win32');
    const tab = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.startsWith('Conversa'));
    act(() => tab!.click());
    expect(host.textContent).toContain('Diga “Hey Jarvis”; detecção local neste computador.');
    expect(host.textContent).not.toContain('detecção local no Mac');
  });
});
