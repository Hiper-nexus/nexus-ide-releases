/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePanePickerStore } from '../state/pane-picker-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { useLayoutStore } from '../state/layout-store';

vi.mock('../browser/browser-host', () => ({ waitForBrowserPaneCreated: vi.fn(async () => undefined) }));
import { VideoProjectsSection } from './VideoProjectsSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let progress: ((event: { jobId: string; pct: number; stage: string | null }) => void) | null = null;
const studio = {
  listProjects: vi.fn(),
  doctor: vi.fn(),
  render: vi.fn(),
  cancel: vi.fn(async () => ({ ok: true })),
  exportVideo: vi.fn(),
  mediaUrl: vi.fn(async (path: string) => ({ ok: true, url: `nexus-media://media/${'a'.repeat(31)}${path.length % 10}` })),
  reveal: vi.fn(async () => ({ ok: true })),
  previewStart: vi.fn(),
  previewStop: vi.fn(async () => ({ ok: true })),
  onProgress: vi.fn((callback) => {
    progress = callback;
    return () => {
      progress = null;
    };
  }),
};
const voiceClone = { list: vi.fn(async () => [] as unknown[]) };
const browser = { load: vi.fn(async () => undefined) };

const PROMO = {
  name: 'promo',
  path: 'videos/promo',
  engine: 'hyperframes',
  renders: [{ path: 'videos/promo/renders/a.mp4', sizeBytes: 3_400_000, modifiedAt: Date.parse('2026-10-19T15:00:00Z') }],
  exports: [],
  hasNarration: true,
  hasMusic: false,
};

function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === text || item.textContent?.includes(text));
  if (!found) throw new Error(`botão "${text}" ausente: ${host.textContent}`);
  return found;
}

async function click(text: string) {
  await act(async () => {
    button(text).click();
  });
}

async function render(onRequestClose = vi.fn()) {
  await act(async () => {
    root.render(<VideoProjectsSection onRequestClose={onRequestClose} />);
  });
  return onRequestClose;
}

beforeEach(() => {
  vi.clearAllMocks();
  studio.listProjects.mockResolvedValue({ ok: true, projects: [PROMO] });
  Object.defineProperty(window, 'nexus', { configurable: true, value: { videoStudio: studio, voiceClone, browser } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(window, 'nexus');
  usePanePickerStore.setState({ pendingOpen: false, pendingAccountsAdapterId: null, pendingBrief: null });
});

describe('Vídeos do projeto', () => {
  it('lista o projeto com o último render e as ações', async () => {
    await render();
    expect(host.textContent).toContain('promo');
    expect(host.textContent).toContain('videos/promo · HyperFrames · com narração');
    expect(host.textContent).toContain('Último render: a.mp4 · 3,2 MB');
    for (const label of ['Renderizar rascunho', 'Renderizar final', 'Exportar', 'Assistir', 'Abrir pasta']) {
      expect(button(label)).toBeTruthy();
    }
  });

  it('renderiza com progresso e cancelamento, depois toca o arquivo pelo nexus-media', async () => {
    let finish!: (value: unknown) => void;
    studio.render.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await render();
    await click('Renderizar final');
    const request = studio.render.mock.calls[0][0] as { jobId: string; quality: string; projectPath: string };
    expect(request).toMatchObject({ projectPath: 'videos/promo', quality: 'final' });
    await act(async () => progress?.({ jobId: request.jobId, pct: 42, stage: 'capture' }));
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42');
    expect(host.textContent).toContain('Renderizando 42%');
    await click('Cancelar');
    expect(studio.cancel).toHaveBeenCalledWith(request.jobId);
    await act(async () => {
      finish({ ok: true, path: 'videos/promo/renders/b.mp4', durationSec: 27, width: 1080, height: 1920, renderMs: 15_000, networkAccess: ['Fetched fonts from Google Fonts'] });
    });
    expect(host.textContent).toContain('Renderizado: 27 s, 1080×1920, em 15 s.');
    expect(host.textContent).toContain('O render buscou coisas na rede');
    const video = host.querySelector('video');
    expect(video?.getAttribute('src')).toMatch(/^nexus-media:\/\/media\//u);
    expect(studio.mediaUrl).toHaveBeenCalledWith('videos/promo/renders/b.mp4');
  });

  it('exporta para a rede escolhida e mostra loudness, rótulo e checklist', async () => {
    studio.exportVideo.mockResolvedValue({
      ok: true,
      files: { video: 'videos/promo/exports/a-vertical-9x16.mp4' },
      loudness: { integratedLufs: -14, truePeakDb: -1, withinTarget: true },
      label: { burned: true, reason: 'narração com voz clonada' },
      aspectMismatch: false,
      publishChecklist: [{ network: 'tiktok', title: 'TikTok', steps: ['Ative "Conteúdo gerado por IA" ao publicar.'] }],
    });
    await render();
    await click('Exportar');
    expect(studio.exportVideo.mock.calls[0][0]).toMatchObject({ inputPath: 'videos/promo/renders/a.mp4', preset: 'vertical-9x16', label: 'auto' });
    expect(host.textContent).toContain('Áudio em -14,0 LUFS');
    expect(host.textContent).toContain('Rótulo de IA: na tela (narração com voz clonada)');
    expect(host.textContent).toContain('Conteúdo gerado por IA');
  });

  it('erro do render aparece com as últimas linhas do log', async () => {
    studio.render.mockResolvedValue({ ok: false, error: 'o HyperFrames terminou com código 1', log: ['Error: lint failed'] });
    await render();
    await click('Renderizar rascunho');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('código 1');
    expect(host.textContent).toContain('Error: lint failed');
  });

  it('Novo vídeo de apresentação vai para Terminais e abre o + Pane com o brief', async () => {
    const openTerminal = vi.spyOn(useProductNavigationStore.getState(), 'openTerminal');
    const close = await render();
    await click('Novo vídeo de apresentação');
    const submit = button('Escolher o agente no + Pane');
    expect(submit.disabled).toBe(true);
    const textarea = host.querySelector('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(textarea, 'Agendify, agenda online para barbearias');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Escolher o agente no + Pane');
    expect(openTerminal).toHaveBeenCalled();
    expect(usePanePickerStore.getState().pendingOpen).toBe(true);
    expect(usePanePickerStore.getState().pendingBrief).toContain('Produto: Agendify, agenda online para barbearias');
    expect(close).toHaveBeenCalled();
  });

  it('Prévia ao vivo abre o Studio num painel do navegador; com prévia aberta, oferece parar (F-1603)', async () => {
    studio.previewStart.mockResolvedValue({ ok: true, id: 'vpreview-1', url: 'http://127.0.0.1:4000/#project/promo', reused: false });
    const addBrowserPane = vi.spyOn(useLayoutStore.getState(), 'addBrowserPane').mockReturnValue('pane-b');
    const openTerminal = vi.spyOn(useProductNavigationStore.getState(), 'openTerminal');
    const close = await render();
    await click('Prévia ao vivo');
    expect(studio.previewStart).toHaveBeenCalledWith('videos/promo');
    expect(openTerminal).toHaveBeenCalled();
    expect(addBrowserPane).toHaveBeenCalledWith('about:blank');
    expect(browser.load).toHaveBeenCalledWith('pane-b', 'http://127.0.0.1:4000/#project/promo');
    expect(close).toHaveBeenCalled();
    addBrowserPane.mockRestore();

    studio.listProjects.mockResolvedValue({ ok: true, projects: [{ ...PROMO, preview: { id: 'vpreview-1', url: 'http://127.0.0.1:4000/' } }] });
    act(() => root.unmount());
    root = createRoot(host);
    await render();
    expect(button('Abrir prévia')).toBeTruthy();
    await click('Parar prévia');
    expect(studio.previewStop).toHaveBeenCalledWith('vpreview-1');
  });

  it('falha da prévia aparece com o log e não abre painel', async () => {
    studio.previewStart.mockResolvedValue({ ok: false, error: 'o Studio do HyperFrames não respondeu a tempo', log: ['porta ocupada'] });
    const addBrowserPane = vi.spyOn(useLayoutStore.getState(), 'addBrowserPane');
    await render();
    await click('Prévia ao vivo');
    expect(host.textContent).toContain('não respondeu a tempo');
    expect(host.textContent).toContain('porta ocupada');
    expect(addBrowserPane).not.toHaveBeenCalled();
    addBrowserPane.mockRestore();
  });

  it('a verificação da máquina mostra o comando que resolve', async () => {
    studio.doctor.mockResolvedValue({
      ok: false,
      engineVersion: '0.8.177',
      checks: [
        { id: 'node', ok: true, detail: 'Node.js v22.23.2' },
        { id: 'ffmpeg', ok: false, detail: 'ffmpeg não encontrado no PATH', fix: 'winget install --id Gyan.FFmpeg -e' },
      ],
    });
    await render();
    await click('Verificar máquina');
    expect(host.textContent).toContain('Falta algo para renderizar');
    expect(host.textContent).toContain('winget install --id Gyan.FFmpeg -e');
    expect(button('Copiar comando')).toBeTruthy();
  });

  it('projeto Remotion explica a licença e não oferece render', async () => {
    studio.listProjects.mockResolvedValue({ ok: true, projects: [{ ...PROMO, name: 'reel', path: 'reel', engine: 'remotion', renders: [] }] });
    await render();
    expect(host.textContent).toContain('o Nexus não renderiza Remotion');
    expect([...host.querySelectorAll('button')].some((item) => item.textContent?.includes('Renderizar'))).toBe(false);
  });

  it('sem projeto aberto e sem projetos de vídeo dizem o que fazer', async () => {
    studio.listProjects.mockResolvedValue({ ok: false, error: 'renderer has no authorized workspace scope' });
    await render();
    expect(host.textContent).toContain('Abra um projeto para ver os vídeos dele.');
    act(() => root.unmount());
    root = createRoot(host);
    studio.listProjects.mockResolvedValue({ ok: true, projects: [] });
    await render();
    expect(host.textContent).toContain('Nenhum projeto de vídeo neste projeto ainda');
  });
});
