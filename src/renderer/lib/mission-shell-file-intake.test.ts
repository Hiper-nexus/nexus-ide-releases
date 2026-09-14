/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acceptsShellDrag,
  describeShellDrop,
  embeddedImageFromHtml,
  fileFromEmbeddedImage,
  importDroppedUriForMission,
  partitionDroppedMissionFiles,
  resolveDroppedMissionContextPath,
  resolveDropUris,
  shellClaimsMissionFileDrop,
  describeDropWithoutFiles,
  droppedUriRejectionMessage,
  toAbsoluteContextPath,
} from './mission-shell-file-intake';
import { PANE_SKILL_DRAG_TYPE } from './pane-interactions';

function file(name: string, type: string): File {
  return new File(['bytes'], name, { type });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shellClaimsMissionFileDrop', () => {
  it('only the launcher and the setup wizard claim a shell file drop', () => {
    expect(shellClaimsMissionFileDrop('launcher')).toBe(true);
    expect(shellClaimsMissionFileDrop('mission-setup')).toBe(true);
    expect(shellClaimsMissionFileDrop('terminal')).toBe(false);
    expect(shellClaimsMissionFileDrop('mission')).toBe(false);
    expect(shellClaimsMissionFileDrop('project')).toBe(false);
    expect(shellClaimsMissionFileDrop('task-board')).toBe(false);
    expect(shellClaimsMissionFileDrop('settings')).toBe(false);
  });
});

describe('partitionDroppedMissionFiles', () => {
  it('keeps in-project files as context and stages external audio/image/text', () => {
    const pathForFile = vi.fn((candidate: File) => {
      if (candidate.name === 'src.ts') return '/workspace/src/app.ts';
      return '/Users/me/Desktop/cliente.m4a';
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { files: { pathForFile } },
    });

    const split = partitionDroppedMissionFiles('/workspace', [
      file('src.ts', 'text/plain'),
      file('cliente.m4a', 'audio/mp4'),
      file('contrato.pdf', 'application/pdf'),
      file('virus.exe', 'application/x-msdownload'),
    ]);

    expect(split.inProject).toEqual(['src/app.ts']);
    expect(split.toImport.map((item) => item.name)).toEqual([
      'cliente.m4a',
      'contrato.pdf',
    ]);
    expect(split.rejected.map((item) => item.name)).toEqual(['virus.exe']);
  });
});

describe('resolveDroppedMissionContextPath', () => {
  it('returns a relative path for files already in the workspace', async () => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        files: {
          pathForFile: () => '/workspace/src/app.ts',
          importMissionAttachment: vi.fn(),
        },
      },
    });

    await expect(
      resolveDroppedMissionContextPath('/workspace', file('app.ts', 'text/plain')),
    ).resolves.toBe('src/app.ts');
    expect(window.nexus.files.importMissionAttachment).not.toHaveBeenCalled();
  });

  it('copies external audio into .nexus/attachments/mission-context/', async () => {
    const importMissionAttachment = vi.fn(async (name: string) => ({
      ok: true as const,
      path: `.nexus/attachments/mission-context/token-${name}`,
    }));
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        files: {
          pathForFile: () => '/Users/me/Desktop/cliente.m4a',
          importMissionAttachment,
        },
      },
    });

    await expect(
      resolveDroppedMissionContextPath(
        '/workspace',
        file('cliente.m4a', 'audio/mp4'),
      ),
    ).resolves.toBe('.nexus/attachments/mission-context/token-cliente.m4a');
    expect(importMissionAttachment).toHaveBeenCalledTimes(1);
  });

  it('pane aceita QUALQUER arquivo externo — binário desconhecido é copiado', async () => {
    // "pane deve sempre aceitar" (19/08): a cópia de bytes é inofensiva e o
    // agente decide o que fazer. Só o tamanho limita.
    const importMissionAttachment = vi.fn(async (name: string) => ({
      ok: true as const,
      path: `.nexus/attachments/mission-context/token-${name}`,
    }));
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        files: {
          pathForFile: () => '/Users/me/Desktop/dados.bin',
          importMissionAttachment,
        },
      },
    });

    await expect(
      resolveDroppedMissionContextPath(
        '/workspace',
        file('dados.bin', 'application/octet-stream'),
      ),
    ).resolves.toBe('.nexus/attachments/mission-context/token-dados.bin');
    expect(importMissionAttachment).toHaveBeenCalledTimes(1);
  });

  it('arquivo acima de 14 MB não é copiado (cap físico do intake)', async () => {
    const importMissionAttachment = vi.fn();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        files: {
          pathForFile: () => '/Users/me/Desktop/filmes.mov',
          importMissionAttachment,
        },
      },
    });
    const big = file('filmes.mov', 'video/quicktime');
    Object.defineProperty(big, 'size', { value: 15 * 1024 * 1024 });

    await expect(
      resolveDroppedMissionContextPath('/workspace', big),
    ).resolves.toBeNull();
    expect(importMissionAttachment).not.toHaveBeenCalled();
  });
});

describe('describeDropWithoutFiles', () => {
  const transfer = (
    types: readonly string[],
    data: Record<string, string> = {},
  ) => ({ types, getData: (type: string) => data[type] ?? '' });

  it('names the file-promise case, which is what a native app drag looks like', () => {
    // Arrastar mídia de um app nativo (WhatsApp, Fotos) põe uma PROMESSA de
    // arquivo no pasteboard. Quando o Chromium não a materializa, `files` vem
    // vazia e o drop não fazia absolutamente nada — nem um aviso.
    const message = describeDropWithoutFiles(transfer(['Files']));
    expect(message).toContain('arquivo');
    expect(message).toContain('Finder');
  });

  it('says it got a link when the drag carries only a web address', () => {
    const message = describeDropWithoutFiles(
      transfer(['text/uri-list'], { 'text/uri-list': 'https://example.com/a.png' }),
    );
    expect(message).toContain('https://example.com/a.png');
  });

  it('points at the local file when the drag carries a file:// address', () => {
    const message = describeDropWithoutFiles(
      transfer(['text/uri-list'], { 'text/uri-list': 'file:///Users/ana/a.png' }),
    );
    expect(message).toContain('/Users/ana/a.png');
  });

  it('reports plain text instead of pretending a file arrived', () => {
    const message = describeDropWithoutFiles(
      transfer(['text/plain'], { 'text/plain': 'oi' }),
    );
    expect(message).toContain('texto');
  });

  it('still answers something useful for an empty drag', () => {
    expect(describeDropWithoutFiles(transfer([]))).toMatch(/\S/);
    expect(describeDropWithoutFiles(null)).toMatch(/\S/);
  });
});

describe('resolveDropUris', () => {
  const transfer = (
    types: readonly string[],
    data: Record<string, string> = {},
  ) => ({ types, getData: (type: string) => data[type] ?? '' });

  it('parses every text/uri-list line, skipping comments and blanks, keeping encoding', () => {
    // O main é quem percent-decodifica (fileURLToPath); o renderer entrega o
    // URI intacto para não corromper um caminho com "%25" legítimo.
    const resolved = resolveDropUris(
      transfer(['text/uri-list'], {
        'text/uri-list':
          '# arrastado do Finder\r\nfile:///Users/ana/foto%20de%20perfil.png\r\n\r\nhttps://example.com/a.png\r\n',
      }),
    );

    expect(resolved.accepted).toEqual([
      { kind: 'file', uri: 'file:///Users/ana/foto%20de%20perfil.png' },
      { kind: 'url', uri: 'https://example.com/a.png' },
    ]);
    expect(resolved.rejected).toEqual([]);
  });

  it('accepts http and https only among web schemes', () => {
    const resolved = resolveDropUris(
      transfer(['text/uri-list'], {
        'text/uri-list':
          'http://example.com/a.png\ndata:text/plain;base64,aGk=\njavascript:alert(1)\nblob:https://x/y\nftp://x/a',
      }),
    );

    expect(resolved.accepted).toEqual([{ kind: 'url', uri: 'http://example.com/a.png' }]);
    expect(resolved.rejected).toEqual([
      'data:text/plain;base64,aGk=',
      'javascript:alert(1)',
      'blob:https://x/y',
      'ftp://x/a',
    ]);
  });

  it('falls back to text/plain only when it is exactly one http(s) link', () => {
    expect(
      resolveDropUris(
        transfer(['text/plain'], { 'text/plain': '  https://example.com/foto.jpg\n' }),
      ).accepted,
    ).toEqual([{ kind: 'url', uri: 'https://example.com/foto.jpg' }]);

    expect(
      resolveDropUris(
        transfer(['text/plain'], { 'text/plain': 'olha https://example.com/foto.jpg' }),
      ).accepted,
    ).toEqual([]);
  });

  it('dedupes repeated addresses and tolerates an empty drag', () => {
    expect(
      resolveDropUris(
        transfer(['text/uri-list'], {
          'text/uri-list': 'file:///a.png\nfile:///a.png',
        }),
      ).accepted,
    ).toHaveLength(1);
    expect(resolveDropUris(null)).toEqual({ accepted: [], rejected: [] });
    expect(resolveDropUris(transfer([]))).toEqual({ accepted: [], rejected: [] });
  });
});

describe('droppedUriRejectionMessage', () => {
  it('names a link and a file differently', () => {
    expect(droppedUriRejectionMessage({ kind: 'url', uri: 'https://x/y.png' })).toMatch(/link/i);
    expect(droppedUriRejectionMessage({ kind: 'file', uri: 'file:///a.png' })).toMatch(/arquivo/i);
  });
});

describe('acceptsShellDrag', () => {
  it('aceita arquivo e lista de endereços', () => {
    expect(acceptsShellDrag(['Files'])).toBe(true);
    expect(acceptsShellDrag(['text/plain', 'Files'])).toBe(true);
    expect(acceptsShellDrag(['text/uri-list'])).toBe(true);
  });

  it('recusa o arraste interno de skill — senão o overlay global acende ao arrastar uma skill', () => {
    expect(acceptsShellDrag([PANE_SKILL_DRAG_TYPE])).toBe(false);
    expect(acceptsShellDrag([PANE_SKILL_DRAG_TYPE, 'text/plain'])).toBe(false);
  });

  it('recusa texto solto — arrastar texto para dentro de uma textarea é gesto legítimo', () => {
    expect(acceptsShellDrag(['text/plain'])).toBe(false);
    expect(acceptsShellDrag(['text/plain', 'text/html'])).toBe(false);
    expect(acceptsShellDrag([])).toBe(false);
  });
});

describe('describeShellDrop', () => {
  const transfer = (
    types: readonly string[],
    data: Record<string, string> = {},
  ) => ({ types, getData: (type: string) => data[type] ?? '' });

  const carriedFile = (name = 'cliente.m4a', type = 'audio/mp4') => {
    const file = new File(['bytes'], name, { type });
    return { types: ['Files'], files: [file], getData: () => '' };
  };

  it('entrega os arquivos crus quando o arraste trouxe arquivo', () => {
    expect(describeShellDrop(carriedFile()).action).toBe('files');
  });

  it('promessa de arquivo sem materialização vira endereço utilizável, não silêncio', () => {
    // Arrastar mídia do WhatsApp/Fotos põe a PROMESSA no pasteboard: `files`
    // vem vazia, mas o `text/uri-list` costuma vir. O shell ignorava isso.
    const plan = describeShellDrop(
      transfer(['Files', 'text/uri-list'], {
        'text/uri-list': 'file:///Users/ana/foto.png',
      }),
    );
    expect(plan.action).toBe('uris');
    expect(plan.action === 'uris' && plan.uris).toEqual([
      { kind: 'file', uri: 'file:///Users/ana/foto.png' },
    ]);
  });

  it('explica o que chegou quando não há arquivo nem endereço aproveitável', () => {
    const plan = describeShellDrop(transfer(['Files']));
    expect(plan.action).toBe('warn');
    expect(plan.action === 'warn' && plan.message).toContain('Finder');
  });

  it('no wizard não baixa link http — vira aviso honesto, sem download', () => {
    const plan = describeShellDrop(
      transfer(['text/uri-list'], { 'text/uri-list': 'https://example.com/a.png' }),
      { allowUrlDownload: false },
    );
    expect(plan.action).toBe('warn');
    expect(plan.action === 'warn' && plan.message).toContain('https://example.com/a.png');
  });

  it('entrega o link http quando o destino permite baixar (pane)', () => {
    const plan = describeShellDrop(
      transfer(['text/uri-list'], { 'text/uri-list': 'https://example.com/a.png' }),
      { allowUrlDownload: true },
    );
    expect(plan.action).toBe('uris');
    expect(plan.action === 'uris' && plan.uris).toEqual([
      { kind: 'url', uri: 'https://example.com/a.png' },
    ]);
  });

  it('não reivindica texto puro nem arraste interno de skill', () => {
    expect(describeShellDrop(transfer(['text/plain'], { 'text/plain': 'um parágrafo' })).action).toBe(
      'ignore',
    );
    expect(describeShellDrop(transfer([PANE_SKILL_DRAG_TYPE])).action).toBe('ignore');
    expect(describeShellDrop(null).action).toBe('ignore');
  });
});

describe('importDroppedUriForMission', () => {
  it('devolve o caminho quando o main aceita o endereço', async () => {
    const importDroppedUri = vi.fn(async () => ({
      ok: true,
      path: '.nexus/attachments/mission-context/token-foto.png',
    }));
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { files: { importDroppedUri } },
    });

    await expect(
      importDroppedUriForMission('file:///Users/ana/foto.png'),
    ).resolves.toEqual({
      ok: true,
      path: '.nexus/attachments/mission-context/token-foto.png',
    });
    expect(importDroppedUri).toHaveBeenCalledWith('file:///Users/ana/foto.png');
  });

  it('traduz a recusa do main em mensagem, sem engolir o erro', async () => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { files: { importDroppedUri: vi.fn(async () => ({ ok: false })) } },
    });
    await expect(
      importDroppedUriForMission('file:///Users/ana/foto.png'),
    ).resolves.toEqual({ ok: false, message: expect.stringMatching(/arquivo/i) });
  });
});

describe('toAbsoluteContextPath', () => {
  it('combina baseDir com caminho relativo do mission-context', () => {
    expect(
      toAbsoluteContextPath(
        '/Users/ana/project',
        '.nexus/attachments/mission-context/token-print.png',
      ),
    ).toBe(
      '/Users/ana/project/.nexus/attachments/mission-context/token-print.png',
    );
  });

  it('normaliza barras invertidas e barras finais do baseDir', () => {
    expect(
      toAbsoluteContextPath(
        'C:\\Users\\ana\\project\\',
        '.nexus/attachments/mission-context/token-print.png',
      ),
    ).toBe(
      'C:/Users/ana/project/.nexus/attachments/mission-context/token-print.png',
    );
  });

  it('preserva caminhos que já são absolutos (POSIX ou Windows)', () => {
    expect(
      toAbsoluteContextPath('/Users/ana/project', '/tmp/upload.png'),
    ).toBe('/tmp/upload.png');
    expect(
      toAbsoluteContextPath('C:/project', 'C:\\Windows\\temp\\file.txt'),
    ).toBe('C:\\Windows\\temp\\file.txt');
  });

  it('retorna o caminho original se baseDir for nulo ou vazio', () => {
    expect(
      toAbsoluteContextPath(null, '.nexus/attachments/mission-context/print.png'),
    ).toBe('.nexus/attachments/mission-context/print.png');
    expect(
      toAbsoluteContextPath('', '.nexus/attachments/mission-context/print.png'),
    ).toBe('.nexus/attachments/mission-context/print.png');
  });
});


// ── F-526: mídia embutida em HTML (WhatsApp e apps Electron) ─────────────────

describe('embeddedImageFromHtml / fileFromEmbeddedImage', () => {
  const WA_HTML =
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">' +
    '<img src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAA" alt="IMG-20260914-WA0001.jpg" size="204304">';

  it('extrai o data:URI de imagem do HTML do WhatsApp', () => {
    const image = embeddedImageFromHtml(WA_HTML);
    expect(image).not.toBeNull();
    expect(image?.mime).toBe('image/jpeg');
    expect(image?.base64).toBe('/9j/4AAQSkZJRgABAQAA');
  });

  it('ignora HTML sem imagem embutida e blob: URLs', () => {
    expect(embeddedImageFromHtml('<p>texto</p>')).toBeNull();
    expect(
      embeddedImageFromHtml('<img src="blob:https://web.whatsapp.com/xyz">'),
    ).toBeNull();
    expect(embeddedImageFromHtml(null)).toBeNull();
  });

  it('materializa um File nomeado com a extensão certa', () => {
    const image = embeddedImageFromHtml(WA_HTML)!;
    const file = fileFromEmbeddedImage(image, Date.parse('2026-09-14T12:00:00Z'));
    expect(file).not.toBeNull();
    expect(file!.type).toBe('image/jpeg');
    expect(file!.name).toMatch(/^imagem-colada-.*\.jpg$/);
    expect(file!.size).toBeGreaterThan(0);
  });

  it('acceptsShellDrag aceita html-only (WhatsApp) e recusa texto formatado', () => {
    expect(acceptsShellDrag(['text/html'])).toBe(true);
    // Página arrastada (html+plain) continua fora do intake.
    expect(acceptsShellDrag(['text/html', 'text/plain'])).toBe(false);
    expect(acceptsShellDrag(['Files'])).toBe(true);
    expect(acceptsShellDrag(['text/plain'])).toBe(false);
  });

  it('describeShellDrop planeja files para a imagem embutida em HTML', () => {
    const transfer = {
      types: ['text/html'],
      getData: (type: string) => (type === 'text/html' ? WA_HTML : ''),
      files: { length: 0 },
    };
    expect(describeShellDrop(transfer)).toEqual({ action: 'files' });
  });
});
