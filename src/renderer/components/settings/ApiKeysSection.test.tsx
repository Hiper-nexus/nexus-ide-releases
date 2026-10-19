/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeysSection, SYSTEM_API_KEYS } from './ApiKeysSection';
import { useVoiceStore } from '../../voice/voice-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ host: HTMLDivElement; root: Root }> = [];

function mount(node: React.ReactNode): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push({ host, root });
  act(() => root.render(node));
  return host;
}

describe('ApiKeysSection', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        platform: 'darwin',
        voice: {
          getInfo: vi.fn(async () => ({
            keys: [
              {
                envVar: 'GEMINI_API_KEY',
                providers: ['gemini-live'],
                hasEnv: false,
                hasStoredKey: true,
                keyMasked: '••••',
                secureStorageAvailable: true,
              },
              {
                envVar: 'XAI_API_KEY',
                providers: ['grok-realtime'],
                hasEnv: false,
                hasStoredKey: false,
                keyMasked: null,
                secureStorageAvailable: true,
              },
            ],
          })),
          setKey: vi.fn(async () => ({ ok: true })),
        },
        providers: {
          list: vi.fn(async () => [
            {
              adapterId: 'claude',
              label: 'Claude',
              hasKey: true,
              keyMasked: 'sk-ant-••••',
              keyEnvVar: 'ANTHROPIC_API_KEY',
            },
          ]),
          setKey: vi.fn(async () => ({ ok: true })),
          testKey: vi.fn(async () => ({ ok: true, detail: 'conectado com sucesso' })),
        },
        media: {
          listProviders: vi.fn(async () => []),
          setKey: vi.fn(async () => ({ ok: true })),
        },
        jev: {
          status: vi.fn(async () => ({
            hasStoredKey: true,
            hasEnv: false,
            keyMasked: 'api…ghij',
            secureStorageAvailable: true,
            autopilot: true,
            model: 'jev-latest',
            stats: { calls: 0, failures: 0, inputTokens: 0, estimatedUsd: 0 },
          })),
          setKey: vi.fn(async () => ({ ok: true })),
          test: vi.fn(async () => ({ ok: true, detail: 'Conectado — modelos: jev-latest' })),
        },
      },
    });

    useVoiceStore.setState({
      info: {
        keys: [
          {
            envVar: 'GEMINI_API_KEY',
            providers: ['gemini-live'],
            hasEnv: false,
            hasStoredKey: true,
            keyMasked: '••••',
            secureStorageAvailable: true,
          },
        ],
      } as any,
    });
  });

  afterEach(() => {
    for (const { host, root } of mountedRoots) {
      act(() => root.unmount());
      host.remove();
    }
    mountedRoots.length = 0;
  });

  it('renders heading and cards for all system keys', async () => {
    const host = mount(<ApiKeysSection />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.querySelector('.settings-detail__title')?.textContent).toBe('Chaves de API');
    const cards = host.querySelectorAll('.api-key-card');
    expect(cards.length).toBe(SYSTEM_API_KEYS.length);
    expect(host.textContent).toContain('Google Gemini');
    expect(host.textContent).toContain('Grok (xAI)');
    expect(host.textContent).toContain('Groq Cloud');
    expect(host.textContent).toContain('OpenAI');
    expect(host.textContent).toContain('Anthropic Claude');
  });

  it('filters keys by search term', async () => {
    const host = mount(<ApiKeysSection />);
    await act(async () => {
      await Promise.resolve();
    });

    const search = host.querySelector<HTMLInputElement>('input[type="search"]');
    expect(search).not.toBeNull();

    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(search, 'groq');
      search!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      await Promise.resolve();
    });

    const cards = host.querySelectorAll('.api-key-card');
    expect(cards.length).toBe(1);
    expect(host.textContent).toContain('Groq Cloud');
    expect(host.textContent).not.toContain('Anthropic Claude');
  });

  it('shows stored status for keys present in keychain', async () => {
    const host = mount(<ApiKeysSection />);
    await act(async () => {
      await Promise.resolve();
    });

    // Gemini was mocked with hasStoredKey: true
    const geminiCard = [...host.querySelectorAll('.api-key-card')].find((c) =>
      c.textContent?.includes('Google Gemini'),
    );
    expect(geminiCard?.textContent).toContain('Salva no Keychain');

    // Grok was mocked with hasStoredKey: false
    const grokCard = [...host.querySelectorAll('.api-key-card')].find((c) =>
      c.textContent?.includes('Grok (xAI)'),
    );
    expect(grokCard?.textContent).toContain('Não configurada');
  });

  it('no Windows o cofre é o do Windows, nunca o Keychain (F-1579)', async () => {
    (window.nexus as { platform?: string }).platform = 'win32';
    const host = mount(<ApiKeysSection />);
    await act(async () => {
      await Promise.resolve();
    });

    const geminiCard = [...host.querySelectorAll('.api-key-card')].find((c) =>
      c.textContent?.includes('Google Gemini'),
    );
    expect(geminiCard?.textContent).toContain('Salva no cofre do Windows');
    expect(host.textContent).toContain('Cofre do Windows');
    expect(host.textContent).toContain('cifrado pelo cofre do Windows de cada máquina');
    expect(host.textContent).not.toMatch(/Keychain|macOS|\bMac\b|Reajustar Para Padrões/);
  });

  it('no Windows a confirmação de salvar diz o cofre do Windows (F-1579)', async () => {
    (window.nexus as { platform?: string }).platform = 'win32';
    const host = mount(<ApiKeysSection />);
    await act(async () => {
      await Promise.resolve();
    });
    const grokCard = [...host.querySelectorAll('.api-key-card')].find((c) =>
      c.textContent?.includes('Grok (xAI)'),
    );
    const input = grokCard?.querySelector<HTMLInputElement>('input[type="password"]');
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        ?.call(input, 'xai-test-key-123');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const saveBtn = [...(grokCard?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Salvar chave'),
    );
    await act(async () => {
      saveBtn!.click();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Chave salva com sucesso no cofre do Windows.');
  });

  it('saves new key and updates voice, providers, and media stores', async () => {
    const host = mount(<ApiKeysSection />);
    await act(async () => {
      await Promise.resolve();
    });

    const grokCard = [...host.querySelectorAll('.api-key-card')].find((c) =>
      c.textContent?.includes('Grok (xAI)'),
    );
    const input = grokCard?.querySelector<HTMLInputElement>('input[type="password"]');
    expect(input).not.toBeNull();

    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(input, 'xai-test-key-123');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const saveBtn = [...(grokCard?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Salvar chave'),
    );
    expect(saveBtn).not.toBeNull();
    expect(saveBtn?.disabled).toBe(false);

    await act(async () => {
      saveBtn!.click();
      await Promise.resolve();
    });

    expect(window.nexus.voice.setKey).toHaveBeenCalledWith({
      envVar: 'XAI_API_KEY',
      key: 'xai-test-key-123',
    });
    expect(window.nexus.providers.setKey).toHaveBeenCalledWith({
      adapterId: 'grok',
      key: 'xai-test-key-123',
    });
  });

  it('renders the TypeSafe (Jev) card', async () => {
    const host = mount(<ApiKeysSection />);
    await act(async () => {
      await Promise.resolve();
    });
    const card = [...host.querySelectorAll('.api-key-card')].find((c) =>
      c.textContent?.includes('TypeSafe (Jev)'),
    );
    expect(card).toBeDefined();
    expect(card?.textContent).toContain('TYPESAFE_API_KEY');
  });

  it('maps jev status to configured and saves via jev.setKey', async () => {
    const host = mount(<ApiKeysSection />);
    await act(async () => {
      await Promise.resolve();
    });

    const card = [...host.querySelectorAll('.api-key-card')].find((c) =>
      c.textContent?.includes('TypeSafe (Jev)'),
    );
    expect(card?.textContent).toContain('Salva no Keychain');

    const input = card?.querySelector<HTMLInputElement>('input[type="password"]');
    expect(input).not.toBeNull();
    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(input, 'apikey_typed_123');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const saveBtn = [...(card?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Salvar chave'),
    );
    await act(async () => {
      saveBtn!.click();
      await Promise.resolve();
    });
    expect(window.nexus.jev.setKey).toHaveBeenCalledWith({ key: 'apikey_typed_123' });
  });

  it('test button calls jev.test', async () => {
    const host = mount(<ApiKeysSection />);
    await act(async () => {
      await Promise.resolve();
    });

    const card = [...host.querySelectorAll('.api-key-card')].find((c) =>
      c.textContent?.includes('TypeSafe (Jev)'),
    );
    const testBtn = [...(card?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Testar conexão'),
    );
    expect(testBtn).not.toBeNull();

    await act(async () => {
      testBtn!.click();
      await Promise.resolve();
    });
    expect(window.nexus.jev.test).toHaveBeenCalled();
    expect(card?.textContent).toContain('Conectado');
  });
});
