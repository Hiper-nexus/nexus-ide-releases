import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShotFilesReceivedPayload } from '../../shared/shot-bridge';
import { initShotIngestToasts, type ShotIngestAppApi } from './shot-ingest';
import { useToastStore } from './toast-store';

function clearToasts(): void {
  for (const toast of useToastStore.getState().toasts) {
    useToastStore.getState().dismiss(toast.id);
  }
}

function makeApi(): {
  api: ShotIngestAppApi;
  emit: (payload: ShotFilesReceivedPayload) => void;
  openTerminalPath: ReturnType<typeof vi.fn>;
} {
  let sink: ((payload: ShotFilesReceivedPayload) => void) | undefined;
  const openTerminalPath = vi.fn(async (_path: string) => ({ ok: true }));
  const api: ShotIngestAppApi = {
    onShotFilesReceived: (cb) => {
      sink = cb;
      return () => {
        sink = undefined;
      };
    },
    openTerminalPath:
      openTerminalPath as unknown as ShotIngestAppApi['openTerminalPath'],
  };
  return { api, emit: (payload) => sink?.(payload), openTerminalPath };
}

function payloadOf(
  files: ShotFilesReceivedPayload['files'],
): ShotFilesReceivedPayload {
  return { files, source: 'nexus-shot', receivedAt: Date.now() };
}

const PNG: ShotFilesReceivedPayload['files'][number] = {
  path: '/Users/op/Pictures/Nexus Shot/clip.png',
  name: 'clip.png',
  size: 2048,
  kind: 'image',
};

afterEach(clearToasts);

describe('shot-ingest toasts (F-576)', () => {
  it('confirma arquivo único com ação Abrir que abre pelo app padrão', async () => {
    const { api, emit, openTerminalPath } = makeApi();
    initShotIngestToasts(api);

    emit(payloadOf([PNG]));

    const [toast] = useToastStore.getState().toasts;
    expect(toast.kind).toBe('success');
    expect(toast.title).toBe('Nexus Shot: clip.png');
    expect(toast.detail).toBe('imagem · 2 KB');
    expect(toast.action?.label).toBe('Abrir');
    await toast.action?.onClick();
    expect(openTerminalPath).toHaveBeenCalledWith(PNG.path);
  });

  it('resume lote de arquivos e abre a pasta do primeiro', async () => {
    const { api, emit, openTerminalPath } = makeApi();
    initShotIngestToasts(api);

    emit(
      payloadOf([
        {
          path: '/Users/op/Movies/Nexus Shot/take.mp4',
          name: 'take.mp4',
          size: 900 * 1024 * 1024,
          kind: 'video',
        },
        {
          path: '/Users/op/Pictures/Nexus Shot/frame-1.png',
          name: 'frame-1.png',
          size: 512,
          kind: 'image',
        },
      ]),
    );

    const [toast] = useToastStore.getState().toasts;
    expect(toast.title).toBe('Nexus Shot: 2 arquivos recebidos');
    expect(toast.detail).toBe('take.mp4, frame-1.png');
    expect(toast.action?.label).toBe('Abrir pasta');
    await toast.action?.onClick();
    expect(openTerminalPath).toHaveBeenCalledWith(
      '/Users/op/Movies/Nexus Shot',
    );
  });

  it('lote grande lista os primeiros nomes e o total restante', () => {
    const { api, emit } = makeApi();
    initShotIngestToasts(api);

    emit(
      payloadOf(
        Array.from({ length: 5 }, (_, i) => ({
          path: `/Users/op/Pictures/Nexus Shot/frame-${i}.png`,
          name: `frame-${i}.png`,
          size: 1024,
          kind: 'image' as const,
        })),
      ),
    );

    const [toast] = useToastStore.getState().toasts;
    expect(toast.detail).toBe(
      'frame-0.png, frame-1.png, frame-2.png e mais 2',
    );
  });

  it('falha de abertura vira toast de erro com o motivo', async () => {
    const { api, emit, openTerminalPath } = makeApi();
    openTerminalPath.mockResolvedValue({
      ok: false,
      error: 'o caminho não existe mais',
    });
    initShotIngestToasts(api);

    emit(payloadOf([PNG]));
    const [toast] = useToastStore.getState().toasts;
    await toast.action?.onClick();

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    const errorToast = toasts[toasts.length - 1];
    expect(errorToast.kind).toBe('error');
    expect(errorToast.title).toBe('Não deu para abrir o arquivo do Shot');
  });

  it('arquivo vazio não empurra toast', () => {
    const { api, emit } = makeApi();
    initShotIngestToasts(api);

    emit(payloadOf([]));

    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('unsubscribe para as entregas', () => {
    const { api, emit } = makeApi();
    const off = initShotIngestToasts(api);

    off();
    emit(payloadOf([PNG]));

    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('injeta arquivo único no terminal com staging e espaço final (F-613)', async () => {
    const { api, emit } = makeApi();
    const writeToPane = vi.fn((_paneId: string, _data: string) => true);
    const importDroppedUri = vi.fn(async (_uri: string) => ({
      ok: true,
      path: '.nexus/attachments/mission-context/shot-clip.png',
    }));

    api.resolveTargetPaneId = () => 'pane-agent-1';
    api.writeToPane = writeToPane;
    api.getActiveWorkspacePath = () => '/Users/op/workspace';
    api.files = { importDroppedUri };

    initShotIngestToasts(api);
    emit(payloadOf([PNG]));

    await vi.waitFor(() => {
      expect(importDroppedUri).toHaveBeenCalledWith('file:///Users/op/Pictures/Nexus%20Shot/clip.png');
      expect(writeToPane).toHaveBeenCalledWith(
        'pane-agent-1',
        '/Users/op/workspace/.nexus/attachments/mission-context/shot-clip.png ',
      );
    });

    const [toast] = useToastStore.getState().toasts;
    expect(toast.title).toBe('Nexus Shot: clip.png');
    expect(toast.detail).toContain('colado no terminal');
  });

  it('prioriza folha de contato e vídeo em pacote de gravação multi-arquivo (F-613)', async () => {
    const { api, emit } = makeApi();
    const writeToPane = vi.fn((_paneId: string, _data: string) => true);

    api.resolveTargetPaneId = () => 'pane-agent-1';
    api.writeToPane = writeToPane;

    const files: ShotFilesReceivedPayload['files'] = [
      { path: '/Users/op/Movies/Nexus Shot/recording.mp4', name: 'recording.mp4', size: 1024 * 1024, kind: 'video' },
      { path: '/Users/op/Pictures/Nexus Shot/contact-sheet.png', name: 'contact-sheet.png', size: 512, kind: 'image' },
      { path: '/Users/op/Pictures/Nexus Shot/frame-001.png', name: 'frame-001.png', size: 256, kind: 'image' },
      { path: '/Users/op/Pictures/Nexus Shot/frame-002.png', name: 'frame-002.png', size: 256, kind: 'image' },
      { path: '/Users/op/Pictures/Nexus Shot/frame-003.png', name: 'frame-003.png', size: 256, kind: 'image' },
    ];

    initShotIngestToasts(api);
    emit(payloadOf(files));

    await vi.waitFor(() => {
      expect(writeToPane).toHaveBeenCalledTimes(1);
      const call = writeToPane.mock.calls[0];
      expect(call[0]).toBe('pane-agent-1');
      // Contém a folha de contato e o vídeo, citados com aspas por terem espaço no caminho
      expect(call[1]).toContain("'/Users/op/Pictures/Nexus Shot/contact-sheet.png'");
      expect(call[1]).toContain("'/Users/op/Movies/Nexus Shot/recording.mp4'");
      expect(call[1]).toContain("'/Users/op/Pictures/Nexus Shot/frame-001.png'");
      // Não joga todos os frames no prompt
      expect(call[1]).not.toContain('frame-003.png');
      expect(call[1].endsWith(' ')).toBe(true);
    });

    const [toast] = useToastStore.getState().toasts;
    expect(toast.title).toBe('Nexus Shot: 5 arquivos recebidos');
    expect(toast.detail).toContain('3 no terminal, +2 na pasta');
  });

  it('faz fallback para caminho real quando staging falha (F-613)', async () => {
    const { api, emit } = makeApi();
    const writeToPane = vi.fn((_paneId: string, _data: string) => true);
    const importDroppedUri = vi.fn(async () => ({ ok: false, error: 'arquivo muito grande' }));

    api.resolveTargetPaneId = () => 'pane-agent-1';
    api.writeToPane = writeToPane;
    api.files = { importDroppedUri };

    initShotIngestToasts(api);
    emit(payloadOf([PNG]));

    await vi.waitFor(() => {
      expect(writeToPane).toHaveBeenCalledWith(
        'pane-agent-1',
        "'/Users/op/Pictures/Nexus Shot/clip.png' ",
      );
    });
  });
});

describe('helpers do shot-ingest (F-613)', () => {
  it('shellQuote cita caminhos com espaços e caracteres especiais', async () => {
    const { shellQuote } = await import('./shot-ingest');
    expect(shellQuote('/tmp/foto.png')).toBe('/tmp/foto.png');
    expect(shellQuote('/Users/op/Pictures/Nexus Shot/foto.png')).toBe(
      "'/Users/op/Pictures/Nexus Shot/foto.png'",
    );
    expect(shellQuote("/path/with'quote")).toBe("'/path/with'\\''quote'");
  });

  it('selectShotFilesToInject lida com lote vazio e unitário', async () => {
    const { selectShotFilesToInject } = await import('./shot-ingest');
    expect(selectShotFilesToInject([])).toEqual([]);
    expect(selectShotFilesToInject([PNG])).toEqual([PNG]);
  });
});
