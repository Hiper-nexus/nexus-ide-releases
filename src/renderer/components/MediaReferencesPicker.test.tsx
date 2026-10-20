/** @vitest-environment jsdom */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaReferenceInfo } from '../../shared/media-reference-types';
import { MediaReferencesPicker, referenceSelectable } from './MediaReferencesPicker';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const originalNexus = Object.getOwnPropertyDescriptor(window, 'nexus');

function ref(name: string, extra: Partial<MediaReferenceInfo> = {}): MediaReferenceInfo {
  return {
    storageKey: `media/referencias/lzx3k1a0-${name}`,
    name,
    kind: 'image',
    bytes: 2048,
    vector: false,
    addedAt: 1,
    ...extra,
  };
}

let library: MediaReferenceInfo[] = [];
const api = {
  list: vi.fn(async () => library),
  save: vi.fn(async (name: string) => {
    const saved = ref(name);
    library = [saved, ...library];
    return { ok: true as const, reference: saved };
  }),
  remove: vi.fn(async (key: string) => {
    library = library.filter((r) => r.storageKey !== key);
    return { ok: true };
  }),
  readDataUrl: vi.fn(async () => ({ ok: true, dataUrl: 'data:image/png;base64,AAAA' })),
};

let lastSelected: string[] = [];

function Harness({ max, videos = 0 }: { max: number; videos?: number }) {
  const [selected, setSelected] = useState<string[]>([]);
  lastSelected = selected;
  return (
    <MediaReferencesPicker
      maxSelectable={max}
      maxVideos={videos}
      selected={selected}
      onSelectedChange={setSelected}
      roleHint="A 1ª imagem vira o primeiro quadro."
    />
  );
}

async function render(max: number, videos = 0): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<Harness max={max} videos={videos} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return host;
}

function cards(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('.ms-refs__card'));
}

beforeEach(() => {
  library = [];
  lastSelected = [];
  for (const fn of Object.values(api)) fn.mockClear();
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: { mediaReferences: api },
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  if (originalNexus) Object.defineProperty(window, 'nexus', originalNexus);
  else Reflect.deleteProperty(window, 'nexus');
});

describe('MediaReferencesPicker', () => {
  it('sem referências explica como trazer (arrastar, colar, adicionar) e onde ficam', async () => {
    const host = await render(3);
    expect(host.textContent).toContain('Arraste para cá');
    expect(host.textContent).toContain('⌘V');
    expect(host.textContent).toContain('media/referencias');
  });

  it('o arquivo escolhido é enviado como bytes e já entra em uso', async () => {
    const host = await render(3);
    const input = host.querySelector<HTMLInputElement>('[data-testid="ms-refs-input"]')!;
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', {
      type: 'image/png',
    });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.save).toHaveBeenCalledWith('logo.png', expect.any(ArrayBuffer));
    expect(lastSelected).toEqual(['media/referencias/lzx3k1a0-logo.png']);
    expect(cards(host)[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.ms-refs__order')?.textContent).toBe('1');
  });

  it('seleciona em ordem até o limite do modelo; com limite 1, clicar troca', async () => {
    library = [ref('a.png'), ref('b.png'), ref('c.png')];
    const host = await render(1);
    act(() => cards(host)[0]!.click());
    expect(lastSelected).toEqual(['media/referencias/lzx3k1a0-a.png']);
    act(() => cards(host)[1]!.click());
    expect(lastSelected).toEqual(['media/referencias/lzx3k1a0-b.png']);
    act(() => cards(host)[1]!.click());
    expect(lastSelected).toEqual([]);
  });

  it('vídeo de exemplo e SVG ficam na biblioteca, mas não vão para o modelo', async () => {
    library = [ref('demo.mp4', { kind: 'video' }), ref('logo.svg', { vector: true })];
    const host = await render(3);
    expect(cards(host).every((card) => card.disabled)).toBe(true);
    expect(cards(host)[0]!.title).toMatch(/vídeo por código/u);
    expect(cards(host)[1]!.title).toMatch(/SVG/u);
    expect(referenceSelectable(library[0]!)).toBe(false);
  });

  it('F-1613: com modelo que recebe vídeo, o vídeo de exemplo entra em uso, com teto próprio', async () => {
    library = [
      ref('demo.mp4', { kind: 'video', storageKey: 'media/referencias/lzx3k1a0-demo.mp4' }),
      ref('rosto.png'),
    ];
    const host = await render(1, 1);
    act(() => cards(host)[0]!.click());
    act(() => cards(host)[1]!.click());
    expect(lastSelected).toEqual([
      'media/referencias/lzx3k1a0-demo.mp4',
      'media/referencias/lzx3k1a0-rosto.png',
    ]);
    expect(referenceSelectable(library[0]!, true)).toBe(true);
  });

  it('remover manda para a Lixeira e tira da seleção', async () => {
    library = [ref('a.png')];
    const host = await render(2);
    act(() => cards(host)[0]!.click());
    expect(lastSelected).toHaveLength(1);
    const remove = host.querySelector<HTMLButtonElement>('.ms-refs__remove')!;
    expect(remove.getAttribute('aria-label')).toContain('Lixeira');
    await act(async () => {
      remove.click();
    });
    expect(api.remove).toHaveBeenCalledWith('media/referencias/lzx3k1a0-a.png');
    expect(lastSelected).toEqual([]);
  });
});
