/** @vitest-environment jsdom */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeicConvertResult } from '../../../shared/files-types';
import { useWorkspaceStore } from '../../state/workspace-store';
import { MissionAttachmentPicker } from './MissionAttachmentPicker';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ImportResult = { ok: boolean; path?: string; error?: string };

const api = {
  importMissionAttachment: vi.fn<(name: string, base64: string) => Promise<ImportResult>>(),
  convertHeicToJpeg: vi.fn<(bytes: Uint8Array) => Promise<HeicConvertResult>>(),
};

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const WORKSPACE_A = { path: '/Users/ana/projeto-a', name: 'projeto-a', lastOpenedAt: 1 };
const WORKSPACE_B = { path: '/Users/ana/projeto-b', name: 'projeto-b', lastOpenedAt: 2 };
const initialWorkspaceState = useWorkspaceStore.getState();
const roots = new Set<Root>();

function heicFile(name = 'IMG_0001.HEIC', type = '', width = 4032, height = 3024): File {
  const encoder = new TextEncoder();
  const box = (kind: string, ...contents: Uint8Array[]) => {
    const bytes = new Uint8Array(8 + contents.reduce((size, item) => size + item.length, 0));
    new DataView(bytes.buffer).setUint32(0, bytes.length);
    bytes.set(encoder.encode(kind), 4);
    let offset = 8;
    for (const item of contents) {
      bytes.set(item, offset);
      offset += item.length;
    }
    return bytes;
  };
  const dimensions = new Uint8Array(12);
  new DataView(dimensions.buffer).setUint32(4, width);
  new DataView(dimensions.buffer).setUint32(8, height);
  return new File(
    [
      box('ftyp', encoder.encode('heic'), new Uint8Array(4)),
      box('meta', new Uint8Array(4), box('iprp', box('ipco', box('ispe', dimensions)))),
    ],
    name,
    { type },
  );
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function Harness({ onChange }: { onChange: (paths: readonly string[]) => void }) {
  const [paths, setPaths] = useState<readonly string[]>([]);
  return (
    <MissionAttachmentPicker
      contextPaths={paths}
      disabled={false}
      onContextPathsChange={(next) => {
        onChange(next);
        setPaths(next);
      }}
    />
  );
}

function render(onChange = vi.fn()): { host: HTMLElement; onChange: typeof onChange } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.add(root);
  act(() => root.render(<Harness onChange={onChange} />));
  return { host, onChange };
}

function paste(host: HTMLElement, files: File[]): void {
  const zone = host.querySelector<HTMLElement>('.mission-attachment-picker__drop');
  if (!zone) throw new Error('drop zone missing');
  zone.dispatchEvent(
    Object.assign(new Event('paste', { bubbles: true, cancelable: true }), {
      clipboardData: {
        items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
        files: [],
      },
    }),
  );
}

/**
 * Assert outside `act` (it holds renders until it exits), but spend almost
 * all the waiting inside short `act` windows so async state lands wrapped.
 */
async function until(assertion: () => void): Promise<void> {
  await vi.waitFor(
    async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      assertion();
    },
    { timeout: 4_000, interval: 1 },
  );
}

function text(host: HTMLElement, role: 'alert' | 'status'): string {
  return host.querySelector(`[role="${role}"]`)?.textContent ?? '';
}

beforeEach(() => {
  api.importMissionAttachment.mockReset().mockImplementation(async (name) => ({
    ok: true,
    path: `.nexus/attachments/mission-context/token-${name}`,
  }));
  api.convertHeicToJpeg.mockReset().mockResolvedValue({ ok: true, bytes: JPEG });
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      files: {
        importMissionAttachment: api.importMissionAttachment,
        convertHeicToJpeg: api.convertHeicToJpeg,
        importDroppedUri: vi.fn(),
        pathForFile: () => '',
      },
    } as unknown as Window['nexus'],
  });
  useWorkspaceStore.setState({ ...initialWorkspaceState, current: WORKSPACE_A });
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.clear();
  document.body.innerHTML = '';
  useWorkspaceStore.setState(initialWorkspaceState, true);
  vi.unstubAllGlobals();
});

describe('MissionAttachmentPicker — HEIC/HEIF e compressão (WEB-03)', () => {
  it('HEIC do iPhone com MIME vazio vira JPEG, é anexado e o usuário vê a conversão', async () => {
    const { host, onChange } = render();
    const photo = heicFile('IMG_0001.HEIC', '');

    act(() => paste(host, [photo]));
    await until(() => expect(onChange).toHaveBeenCalled());

    expect(api.convertHeicToJpeg).toHaveBeenCalledOnce();
    expect([...api.convertHeicToJpeg.mock.calls[0]![0]]).toEqual([
      ...new Uint8Array(await photo.arrayBuffer()),
    ]);
    expect(api.importMissionAttachment).toHaveBeenCalledWith('IMG_0001.jpg', base64(JPEG));
    expect(onChange).toHaveBeenLastCalledWith([
      '.nexus/attachments/mission-context/token-IMG_0001.jpg',
    ]);
    expect(text(host, 'status')).toContain('IMG_0001.HEIC foi convertida para JPEG');
    expect(text(host, 'status')).toContain('IMG_0001.jpg');
    expect(text(host, 'alert')).toBe('');
  });

  it('HEIF com MIME vazio também entra (antes era recusado)', async () => {
    const { host, onChange } = render();

    act(() => paste(host, [heicFile('retrato.heif', '')]));
    await until(() => expect(onChange).toHaveBeenCalled());

    expect(api.importMissionAttachment).toHaveBeenCalledWith('retrato.jpg', base64(JPEG));
  });

  it('o mesmo HEIC colado em dobro e depois de novo é convertido e importado uma vez', async () => {
    const { host, onChange } = render();
    const photo = heicFile('IMG_0002.HEIC', 'image/heic');

    act(() => {
      paste(host, [photo]);
      paste(host, [photo]);
    });
    await until(() => expect(onChange).toHaveBeenCalled());
    act(() => paste(host, [heicFile('IMG_0002.HEIC', 'image/heic')]));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(api.convertHeicToJpeg).toHaveBeenCalledOnce();
    expect(api.importMissionAttachment).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('PNG pequeno passa intacto: sem conversão, sem aviso, bytes originais', async () => {
    const { host, onChange } = render();
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9])], 'erro.png', {
      type: 'image/png',
    });

    act(() => paste(host, [png]));
    await until(() => expect(onChange).toHaveBeenCalled());

    expect(api.convertHeicToJpeg).not.toHaveBeenCalled();
    expect(api.importMissionAttachment).toHaveBeenCalledWith(
      'erro.png',
      base64(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9])),
    );
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('sem decoder no sistema o HEIC falha legível e não derruba o PNG do mesmo lote', async () => {
    api.convertHeicToJpeg.mockResolvedValue({
      ok: false,
      reason: 'unsupported',
      error: 'HEIC não suportado neste sistema.',
    });
    const { host, onChange } = render();
    const png = new File([new Uint8Array([1, 2, 3])], 'log.png', { type: 'image/png' });

    act(() => paste(host, [heicFile('IMG_0003.HEIC', ''), png]));
    await until(() => expect(onChange).toHaveBeenCalled());

    expect(text(host, 'alert')).toBe('IMG_0003.HEIC: HEIC não suportado neste sistema.');
    expect(api.importMissionAttachment).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenLastCalledWith(['.nexus/attachments/mission-context/token-log.png']);
  });

  it('HEIC corrompido falha visível antes de chamar o conversor', async () => {
    const { host } = render();
    const broken = new File([new Uint8Array([1, 2, 3])], 'quebrada.heic', { type: '' });

    act(() => paste(host, [broken]));
    await until(() => expect(text(host, 'alert')).not.toBe(''));

    expect(text(host, 'alert')).toBe('quebrada.heic não pôde ser lido como imagem.');
    expect(api.convertHeicToJpeg).not.toHaveBeenCalled();
    expect(api.importMissionAttachment).not.toHaveBeenCalled();
  });

  it('trocar de projeto durante a conversão não anexa nada no projeto novo', async () => {
    const conversion = deferred<HeicConvertResult>();
    api.convertHeicToJpeg.mockReturnValueOnce(conversion.promise);
    const { host, onChange } = render();

    act(() => paste(host, [heicFile('IMG_0004.HEIC', '')]));
    await until(() => expect(api.convertHeicToJpeg).toHaveBeenCalled());
    act(() => useWorkspaceStore.setState({ current: WORKSPACE_B }));
    conversion.resolve({ ok: true, bytes: JPEG });
    await until(() => expect(text(host, 'alert')).toContain('A pasta do projeto mudou'));

    expect(api.importMissionAttachment).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('trocar de projeto durante a cópia descarta o caminho do projeto antigo', async () => {
    const staging = deferred<ImportResult>();
    api.importMissionAttachment.mockReturnValueOnce(staging.promise);
    const { host, onChange } = render();

    act(() =>
      paste(host, [new File([new Uint8Array([7, 7])], 'tela.png', { type: 'image/png' })]),
    );
    await until(() => expect(api.importMissionAttachment).toHaveBeenCalled());
    act(() => useWorkspaceStore.setState({ current: WORKSPACE_B }));
    staging.resolve({ ok: true, path: '.nexus/attachments/mission-context/token-tela.png' });
    await until(() => expect(text(host, 'alert')).toContain('A pasta do projeto mudou'));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('imagem acima de 14 MB é comprimida antes da validação e o aviso diz o formato novo', async () => {
    const close = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 4000, height: 3000, close })),
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
        }
        async convertToBlob({ type }: { type: string }) {
          return new Blob([new Uint8Array(200_000)], { type });
        }
      },
    );
    const { host, onChange } = render();
    const big = new File([new Uint8Array(15 * 1024 * 1024).fill(3)], 'captura.png', {
      type: 'image/png',
    });

    act(() => paste(host, [big]));
    await until(() => expect(onChange).toHaveBeenCalled());

    expect(api.importMissionAttachment).toHaveBeenCalledOnce();
    expect(api.importMissionAttachment.mock.calls[0]![0]).toBe('captura.webp');
    expect(text(host, 'status')).toContain('captura.png foi comprimida para WebP');
    expect(text(host, 'alert')).toBe('');
    expect(close).toHaveBeenCalled();
  });
});
