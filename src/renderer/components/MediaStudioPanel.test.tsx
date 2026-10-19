/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaStudioPanel } from './MediaStudioPanel';
import { useMediaStudioStore } from '../state/media-studio-store';
import { useProductNavigationStore } from '../state/product-navigation-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const originalNexusDescriptor = Object.getOwnPropertyDescriptor(window, 'nexus');

function MediaHarness() {
  const open = useMediaStudioStore((state) => state.open);
  const show = useMediaStudioStore((state) => state.show);
  const hide = useMediaStudioStore((state) => state.hide);
  return (
    <>
      <button type="button" onClick={show}>
        Abrir Estúdio de Mídia
      </button>
      <MediaStudioPanel open={open} onClose={hide} />
    </>
  );
}

function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return host;
}

function renderHarness(): HTMLButtonElement {
  const host = render(<MediaHarness />);
  const invoker = host.querySelector<HTMLButtonElement>('button');
  if (!invoker) throw new Error('Media Studio invoker was not rendered');
  return invoker;
}

async function openFrom(invoker: HTMLButtonElement): Promise<HTMLElement> {
  act(() => {
    invoker.focus();
    invoker.click();
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const dialog = document.querySelector<HTMLElement>(
    '[role="dialog"][aria-modal="true"]',
  );
  if (!dialog) throw new Error('Media Studio dialog was not rendered');
  return dialog;
}

function referencedText(element: HTMLElement, attribute: string): string {
  return (element.getAttribute(attribute) ?? '')
    .split(/\s+/u)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
    .filter(Boolean)
    .join(' ');
}

function enabledFocusables(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getAttribute('aria-hidden') !== 'true');
}

function keydown(target: EventTarget, key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  act(() => target.dispatchEvent(event));
  return event;
}

beforeEach(() => {
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    writable: true,
    value: {
      media: {
        listProviders: vi.fn(async () => []),
        listArtifacts: vi.fn(async () => []),
        readArtifactDataUrl: vi.fn(async () => ({ ok: false })),
        generate: vi.fn(),
        cancelGenerate: vi.fn(),
        revealArtifact: vi.fn(),
      },
    },
  });
  useMediaStudioStore.setState({ open: false });
  useProductNavigationStore.setState({
    destination: { kind: 'terminal' },
    settingsReturnDestination: null,
  });
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  if (originalNexusDescriptor) {
    Object.defineProperty(window, 'nexus', originalNexusDescriptor);
  } else {
    Reflect.deleteProperty(window, 'nexus');
  }
});

describe('MediaStudioPanel: revelar arquivo por sistema (F-1579)', () => {
  it('no Windows a galeria mostra no Explorador de Arquivos, nunca no Finder', async () => {
    const nexus = window.nexus as unknown as {
      platform?: string;
      media: { listArtifacts: ReturnType<typeof vi.fn> };
    };
    nexus.platform = 'win32';
    nexus.media.listArtifacts.mockResolvedValue([
      { id: 'a1', kind: 'image', storageKey: 'media/foto.png', costUsd: null, createdAt: 1 },
    ]);
    const dialog = await openFrom(renderHarness());
    const card = dialog.querySelector<HTMLButtonElement>('.ms-card');
    expect(card?.title).toBe('Mostrar no Explorador de Arquivos');
    expect(dialog.textContent).not.toContain('Finder');
  });
});

describe('MediaStudioPanel behavioral contract', () => {
  it('uses its rendered title and description for the dialog name and moves initial focus inside', async () => {
    const invoker = renderHarness();

    const dialog = await openFrom(invoker);

    expect(referencedText(dialog, 'aria-labelledby')).toBe('Estúdio de Mídia');
    expect(referencedText(dialog, 'aria-describedby')).toContain(
      'Crie imagens e vídeos com IA.',
    );
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(invoker);
  });

  it('traps Tab and Shift+Tab through every enabled control in DOM order', async () => {
    const dialog = await openFrom(renderHarness());
    const focusables = enabledFocusables(dialog);
    expect(focusables.length).toBeGreaterThan(2);

    for (const [index, element] of focusables.entries()) {
      element.focus();
      keydown(element, 'Tab');
      expect(document.activeElement).toBe(
        focusables[(index + 1) % focusables.length],
      );
    }

    for (const [index, element] of focusables.entries()) {
      element.focus();
      keydown(element, 'Tab', true);
      expect(document.activeElement).toBe(
        focusables[(index - 1 + focusables.length) % focusables.length],
      );
    }
  });

  it('closes before deep-linking the empty-provider action to canonical Settings media', async () => {
    const dialog = await openFrom(renderHarness());
    const configure = Array.from(
      dialog.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Conectar serviço de mídia'));
    if (!configure) throw new Error('Connect media service action was not rendered');
    expect(dialog.textContent).toContain('Ajustes → Serviços de mídia');
    expect(dialog.textContent).not.toMatch(/API key|provider/);

    act(() => configure.click());

    expect(useMediaStudioStore.getState().open).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'settings',
      section: 'media',
    });
  });

  it('cancels with Escape or backdrop press and restores focus to the invoking action', async () => {
    const invoker = renderHarness();

    let dialog = await openFrom(invoker);
    keydown(document.activeElement ?? dialog, 'Escape');
    expect(useMediaStudioStore.getState().open).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(invoker);

    dialog = await openFrom(invoker);
    const backdrop = dialog.parentElement;
    if (!backdrop) throw new Error('Media Studio backdrop was not rendered');
    act(() =>
      backdrop.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
      ),
    );
    expect(useMediaStudioStore.getState().open).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(invoker);
  });
});

describe('MediaStudioPanel: falha do serviço (F-1584)', () => {
  it('chave recusada mostra a frase do Main e leva a Serviços de mídia', async () => {
    const media = (window.nexus as unknown as {
      media: Record<string, ReturnType<typeof vi.fn>>;
    }).media;
    media.listProviders.mockResolvedValue([
      {
        id: 'openai-image',
        kind: 'image',
        label: 'OpenAI',
        envVar: 'OPENAI_API_KEY',
        defaultModel: 'gpt-image-2',
        models: ['gpt-image-2'],
        hasKey: true,
        maskedKey: null,
      },
    ]);
    media.generate.mockResolvedValue({
      ok: false,
      error: 'OpenAI recusou a chave (HTTP 401). Confira ou troque a chave em Ajustes → Serviços de mídia.',
      errorKind: 'key',
    });
    const dialog = await openFrom(renderHarness());
    const prompt = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(prompt, 'um gato astronauta');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      dialog.querySelector<HTMLButtonElement>('.ms-generate')!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const alert = dialog.querySelector('.ms-error')!;
    expect(alert.textContent).toContain('OpenAI recusou a chave (HTTP 401)');
    const open = Array.from(alert.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('Abrir Serviços de mídia'),
    )!;
    act(() => open.click());
    expect(useMediaStudioStore.getState().open).toBe(false);
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'settings',
      section: 'media',
    });
  });
});

describe('MediaStudioPanel sem projeto aberto (F-1589)', () => {
  const keyedImage = {
    id: 'openai-image',
    kind: 'image',
    label: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    defaultModel: 'gpt-image-2',
    models: ['gpt-image-2'],
    hasKey: true,
    maskedKey: null,
  };

  it('mostra os serviços, explica que falta o projeto e não deixa gerar', async () => {
    const media = (window.nexus as unknown as {
      media: Record<string, ReturnType<typeof vi.fn>>;
    }).media;
    media.listProviders.mockResolvedValue([keyedImage]);
    media.listArtifacts.mockResolvedValue(null);

    const dialog = await openFrom(renderHarness());
    expect(dialog.querySelector('[role="status"]')?.textContent).toContain('Abra um projeto para gerar');
    expect(dialog.querySelector<HTMLSelectElement>('select')?.value).toBe('openai-image::gpt-image-2');
    const prompt = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(prompt, 'um gato astronauta');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const generate = dialog.querySelector<HTMLButtonElement>('.ms-generate')!;
    expect(generate.disabled).toBe(true);
    expect(media.generate).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain('Abra um projeto para vê-las');
  });

  it('a galeria falhar não esconde os serviços', async () => {
    const media = (window.nexus as unknown as {
      media: Record<string, ReturnType<typeof vi.fn>>;
    }).media;
    media.listProviders.mockResolvedValue([keyedImage]);
    media.listArtifacts.mockRejectedValue(new Error('renderer has no authorized workspace scope'));

    const dialog = await openFrom(renderHarness());
    expect(dialog.querySelector<HTMLSelectElement>('select')?.value).toBe('openai-image::gpt-image-2');
    expect(dialog.textContent).not.toContain('authorized workspace scope');
  });
});

describe('MediaStudioPanel: vídeo com as opções do modelo (F-1585)', () => {
  const replicateVideo = {
    id: 'replicate-video',
    kind: 'video',
    label: 'Replicate',
    envVar: 'REPLICATE_API_TOKEN',
    defaultModel: 'bytedance/seedance-2.0',
    models: ['bytedance/seedance-2.0', 'google/veo-3.1', 'wan-video/wan-2.5-i2v'],
    hasKey: true,
    maskedKey: null,
  };

  function media(): Record<string, ReturnType<typeof vi.fn>> {
    return (window.nexus as unknown as { media: Record<string, ReturnType<typeof vi.fn>> }).media;
  }

  function chipTexts(dialog: HTMLElement, group: string): string[] {
    return Array.from(
      dialog.querySelectorAll<HTMLButtonElement>(`[aria-label="${group}"] button`),
    ).map((b) => b.textContent ?? '');
  }

  function pressedChip(dialog: HTMLElement, group: string): string | undefined {
    return dialog.querySelector(`[aria-label="${group}"] [aria-pressed="true"]`)?.textContent ?? undefined;
  }

  async function openVideoTab(): Promise<HTMLElement> {
    media().listProviders.mockResolvedValue([replicateVideo]);
    const dialog = await openFrom(renderHarness());
    const videoTab = Array.from(dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (b) => b.textContent === 'Vídeo',
    )!;
    act(() => videoTab.click());
    return dialog;
  }

  function choose(dialog: HTMLElement, value: string): void {
    const select = dialog.querySelector<HTMLSelectElement>('select')!;
    act(() => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('Veo mostra só 4/6/8 s, começa em 8 s e o custo de lista antes de gerar', async () => {
    const dialog = await openVideoTab();
    choose(dialog, 'replicate-video::google/veo-3.1');
    expect(chipTexts(dialog, 'Duração')).toEqual(['4s', '6s', '8s']);
    expect(pressedChip(dialog, 'Duração')).toBe('8s');
    expect(chipTexts(dialog, 'Resolução')).toEqual(['720p', '1080p']);
    expect(chipTexts(dialog, 'Proporção')).toEqual(['16:9', '9:16']);
    expect(dialog.textContent).toContain('Custo estimado: $3.20 (preço de lista');

    // 1080p só com 8 s.
    const hd = Array.from(dialog.querySelectorAll<HTMLButtonElement>('[aria-label="Resolução"] button')).find(
      (b) => b.textContent === '1080p',
    )!;
    act(() => hd.click());
    expect(chipTexts(dialog, 'Duração')).toEqual(['8s']);
  });

  it('o pedido leva só o que o modelo aceita', async () => {
    media().generate.mockResolvedValue({ ok: false, error: 'x' });
    const dialog = await openVideoTab();
    choose(dialog, 'replicate-video::google/veo-3.1');
    const prompt = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(prompt, 'praia ao pôr do sol');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      dialog.querySelector<HTMLButtonElement>('.ms-generate')!.click();
    });
    expect(media().generate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'video',
        model: 'google/veo-3.1',
        durationSeconds: 8,
        resolution: '720p',
        aspectRatio: '16:9',
      }),
    );
  });

  it('modelo que precisa de imagem inicial aparece desabilitado e com o motivo', async () => {
    const dialog = await openVideoTab();
    const option = Array.from(dialog.querySelectorAll<HTMLOptionElement>('option')).find((o) =>
      o.value.endsWith('wan-video/wan-2.5-i2v'),
    )!;
    expect(option.disabled).toBe(true);
    expect(option.textContent).toContain('precisa de imagem inicial');
  });

  it('F-1587: Gemini Omni sem escolha de duração, taxa por segundo e duração real no resultado', async () => {
    const googleVideo = {
      id: 'google-video',
      kind: 'video',
      label: 'Google nativo — Gemini Omni / Veo (AI Studio)',
      envVar: 'GEMINI_API_KEY',
      defaultModel: 'gemini-omni-1.1-flash',
      models: ['gemini-omni-1.1-flash', 'veo-3.1-generate-preview'],
      hasKey: true,
      maskedKey: null,
    };
    media().listProviders.mockResolvedValue([googleVideo]);
    media().generate.mockResolvedValue({
      ok: true,
      path: 'C:\\proj\\generated-9.mp4',
      provider: 'google-video',
      model: 'gemini-omni-1.1-flash',
      kind: 'video',
      estimatedCostUsd: 0.8,
      durationMs: 40_000,
      videoDurationSeconds: 8.042,
    });
    const dialog = await openFrom(renderHarness());
    const videoTab = Array.from(dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (b) => b.textContent === 'Vídeo',
    )!;
    act(() => videoTab.click());

    // O padrão do serviço é o Omni: sem chips de duração, a frase no lugar.
    expect(dialog.querySelector<HTMLSelectElement>('select')!.value).toBe(
      'google-video::gemini-omni-1.1-flash',
    );
    expect(chipTexts(dialog, 'Duração')).toEqual([]);
    expect(dialog.textContent).toContain('O modelo decide quanto o vídeo dura.');
    expect(chipTexts(dialog, 'Resolução')).toEqual(['360p', '720p', '1080p', '4k']);
    expect(chipTexts(dialog, 'Proporção')).toEqual(['16:9', '9:16']);
    expect(dialog.textContent).toContain('Custo estimado: $0.10 por segundo de vídeo');
    const uhd = Array.from(
      dialog.querySelectorAll<HTMLButtonElement>('[aria-label="Resolução"] button'),
    ).find((b) => b.textContent === '4k')!;
    act(() => uhd.click());
    expect(dialog.textContent).toContain('Custo estimado: $0.30 por segundo de vídeo');

    const prompt = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(prompt, 'um farol na tempestade');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      dialog.querySelector<HTMLButtonElement>('.ms-generate')!.click();
    });
    const request = media().generate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).toMatchObject({
      kind: 'video',
      providerId: 'google-video',
      model: 'gemini-omni-1.1-flash',
      resolution: '4k',
      aspectRatio: '16:9',
    });
    expect(request).not.toHaveProperty('durationSeconds');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dialog.textContent).toContain('Custo estimado: $0.80 · 8 s de vídeo');
  });

  it('F-1599: só com a chave da xAI, o Grok Imagine gera vídeo com as opções e o preço do modelo', async () => {
    const xaiVideo = {
      id: 'xai-video',
      kind: 'video',
      label: 'xAI — Grok Imagine (vídeo)',
      envVar: 'XAI_API_KEY',
      defaultModel: 'grok-imagine-video-1.5',
      models: ['grok-imagine-video-1.5', 'grok-imagine-video-1.5-lite', 'grok-imagine-video'],
      hasKey: true,
      maskedKey: null,
    };
    media().listProviders.mockResolvedValue([xaiVideo]);
    media().generate.mockResolvedValue({
      ok: true,
      path: 'C:\\proj\\generated-7.mp4',
      provider: 'xai-video',
      model: 'grok-imagine-video',
      kind: 'video',
      estimatedCostUsd: 0.35,
      durationMs: 60_000,
      jobId: 'a3d1008e-4544-40d4-d075-11527e794e4a',
    });
    const dialog = await openFrom(renderHarness());
    const videoTab = Array.from(dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (b) => b.textContent === 'Vídeo',
    )!;
    act(() => videoTab.click());

    expect(dialog.querySelector<HTMLSelectElement>('select')!.value).toBe('xai-video::grok-imagine-video-1.5');
    expect(chipTexts(dialog, 'Resolução')).toEqual(['480p', '720p', '1080p']);
    expect(chipTexts(dialog, 'Proporção')).toEqual(['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9', '5:2']);
    const slider = dialog.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect([slider.min, slider.max, slider.value]).toEqual(['1', '15', '5']);
    // 5 s × US$ 0,14/s (720p no 1.5).
    expect(dialog.textContent).toContain('Custo estimado: $0.70');

    // O clássico vai só até 720p: o 1080p some e o custo segue o modelo.
    choose(dialog, 'xai-video::grok-imagine-video');
    expect(chipTexts(dialog, 'Resolução')).toEqual(['480p', '720p']);
    expect(dialog.textContent).toContain('Custo estimado: $0.35');

    const prompt = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(prompt, 'um farol na tempestade');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      dialog.querySelector<HTMLButtonElement>('.ms-generate')!.click();
    });
    expect(media().generate.mock.calls[0]?.[0]).toMatchObject({
      kind: 'video',
      providerId: 'xai-video',
      model: 'grok-imagine-video',
      durationSeconds: 5,
      resolution: '720p',
      aspectRatio: '16:9',
    });
  });
});

describe('MediaStudioPanel: prévia do arquivo gerado (F-1586)', () => {
  it('mostra o arquivo deste resultado, não o mais novo do mesmo tipo', async () => {
    const media = (window.nexus as unknown as {
      media: Record<string, ReturnType<typeof vi.fn>>;
    }).media;
    media.listProviders.mockResolvedValue([
      {
        id: 'openai-image',
        kind: 'image',
        label: 'OpenAI',
        envVar: 'OPENAI_API_KEY',
        defaultModel: 'gpt-image-2',
        models: ['gpt-image-2'],
        hasKey: true,
        maskedKey: null,
      },
    ]);
    media.generate.mockResolvedValue({
      ok: true,
      path: 'C:\\proj\\generated-2.png',
      provider: 'openai-image',
      model: 'gpt-image-2',
      kind: 'image',
      estimatedCostUsd: 0.07,
      durationMs: 10,
      artifactId: 'media-mine',
    });
    // Um agente gerou outra imagem no mesmo projeto logo depois: ela é a
    // "mais nova do mesmo tipo" na galeria.
    const galleryAfter = [
      { id: 'media-agent', kind: 'image', provider: 'google-image', model: 'g', storageKey: 'agente.png', costUsd: 0.04, durationMs: 1, createdAt: 2 },
      { id: 'media-mine', kind: 'image', provider: 'openai-image', model: 'gpt-image-2', storageKey: 'generated-2.png', costUsd: 0.07, durationMs: 1, createdAt: 1 },
    ];
    media.listArtifacts.mockResolvedValueOnce([]).mockResolvedValue(galleryAfter);
    media.readArtifactDataUrl.mockImplementation(async (key: string) => ({
      ok: true,
      dataUrl: `data:image/png;base64,${key === 'generated-2.png' ? 'TUlORQ==' : 'QUdFTlRF'}`,
    }));

    const dialog = await openFrom(renderHarness());
    const prompt = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(prompt, 'um gato astronauta');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      dialog.querySelector<HTMLButtonElement>('.ms-generate')!.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const preview = dialog.querySelector<HTMLImageElement>('.ms-result__preview img')!;
    expect(preview.getAttribute('src')).toBe('data:image/png;base64,TUlORQ==');
    expect(dialog.querySelector('.ms-result__name')?.textContent).toBe('generated-2.png');
  });

  it('sem o id da criação não mostra o arquivo de outro; o nome sai sem o caminho do Windows', async () => {
    const media = (window.nexus as unknown as {
      media: Record<string, ReturnType<typeof vi.fn>>;
    }).media;
    media.listProviders.mockResolvedValue([
      {
        id: 'openai-image',
        kind: 'image',
        label: 'OpenAI',
        envVar: 'OPENAI_API_KEY',
        defaultModel: 'gpt-image-2',
        models: ['gpt-image-2'],
        hasKey: true,
        maskedKey: null,
      },
    ]);
    media.generate.mockResolvedValue({
      ok: true,
      path: 'C:\\proj\\generated-3.png',
      provider: 'openai-image',
      model: 'gpt-image-2',
      kind: 'image',
      estimatedCostUsd: 0.07,
      durationMs: 10,
    });
    media.listArtifacts.mockResolvedValueOnce([]).mockResolvedValue([
      { id: 'media-agent', kind: 'image', provider: 'google-image', model: 'g', storageKey: 'agente.png', costUsd: 0.04, durationMs: 1, createdAt: 2 },
    ]);
    const dialog = await openFrom(renderHarness());
    const prompt = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(prompt, 'outro gato');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      dialog.querySelector<HTMLButtonElement>('.ms-generate')!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(dialog.querySelector('.ms-result__preview img')).toBeNull();
    expect(dialog.querySelector('.ms-result__name')?.textContent).toBe('generated-3.png');
  });
});
