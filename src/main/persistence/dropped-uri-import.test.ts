import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DROPPED_ATTACHMENT_MAX_BYTES,
  DROPPED_LOCAL_FILE_MAX_BYTES,
  MISSION_CONTEXT_ATTACHMENT_PREFIX,
} from './dropped-files';
import {
  DROPPED_URL_TIMEOUT_MS,
  downloadedFileName,
  importDroppedUri,
  macPrivacyMessage,
  parseDroppedUri,
  DROPPED_URL_MAX_REDIRECTS,
  isBlockedAddress,
} from './dropped-uri-import';

let tempRoot = '';
let workspace = '';
let sourceDir = '';

beforeEach(() => {
  tempRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dropped-uri-')),
  );
  workspace = path.join(tempRoot, 'workspace');
  sourceDir = path.join(tempRoot, 'source');
  fs.mkdirSync(workspace);
  fs.mkdirSync(sourceDir);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function stagedFiles(): string[] {
  const dir = path.join(workspace, ...MISSION_CONTEXT_ATTACHMENT_PREFIX.split('/'));
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function localFile(name: string, content: string | number): string {
  const file = path.join(sourceDir, name);
  if (typeof content === 'string') {
    fs.writeFileSync(file, content);
  } else {
    fs.writeFileSync(file, '');
    fs.truncateSync(file, content);
  }
  return file;
}

function fetchNever(): typeof fetch {
  return vi.fn(async () => {
    throw new Error('fetch não deveria ser chamado');
  }) as unknown as typeof fetch;
}

function bytesStream(
  chunks: readonly Uint8Array[],
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]!);
      index += 1;
    },
    cancel() {
      onCancel?.();
    },
  });
}

function endlessStream(
  chunkBytes: number,
  onCancel: () => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel() {
      onCancel();
    },
  });
}

function response(init: {
  status?: number;
  headers?: Record<string, string>;
  body?: ReadableStream<Uint8Array> | null;
  url?: string;
}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    url: init.url ?? '',
    headers: new Headers(init.headers ?? {}),
    body: init.body === undefined ? bytesStream([]) : init.body,
  } as unknown as Response;
}

function fetchReturning(reply: Response): ReturnType<typeof vi.fn> {
  return vi.fn(async () => reply);
}

describe('parseDroppedUri', () => {
  it('decodes a percent-encoded file:// address into a local path', () => {
    const local = path.join(sourceDir, 'foto de perfil.png');
    const uri = pathToFileURL(local).href;
    expect(uri).toContain('%20');
    expect(parseDroppedUri(uri)).toEqual({ kind: 'file', path: local });
  });

  it('keeps http and https links as downloads', () => {
    expect(parseDroppedUri('https://example.com/a.png')).toMatchObject({
      kind: 'url',
    });
    expect(parseDroppedUri('http://example.com/a.png')).toMatchObject({
      kind: 'url',
    });
  });

  it.each([
    'data:text/plain;base64,aGk=',
    'blob:https://example.com/3f2a',
    'javascript:alert(1)',
    'ftp://example.com/a.png',
    'não é um endereço',
  ])('refuses %s with a plain message', (uri) => {
    const parsed = parseDroppedUri(uri);
    expect(parsed.kind).toBe('rejected');
    if (parsed.kind === 'rejected') expect(parsed.error).toMatch(/http/i);
  });
});

describe('importDroppedUri — file://', () => {
  it('stages a local file addressed by a percent-encoded URI', async () => {
    const local = localFile('foto de perfil.png', 'png-bytes');

    const result = await importDroppedUri(workspace, pathToFileURL(local).href, {
      fetch: fetchNever(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toMatch(
      new RegExp(`^${MISSION_CONTEXT_ATTACHMENT_PREFIX}.+foto_de_perfil\\.png$`),
    );
    expect(fs.readFileSync(path.join(workspace, result.path), 'utf8')).toBe(
      'png-bytes',
    );
  });

  it('stages a local file above 14 MB via the streaming route (F-582)', async () => {
    const local = localFile('filme.mp4', 20 * 1024 * 1024);

    const result = await importDroppedUri(workspace, pathToFileURL(local).href, {
      fetch: fetchNever(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const staged = path.join(workspace, result.path);
    expect(fs.statSync(staged).size).toBe(20 * 1024 * 1024);
  });

  it('refuses a local file above 256 MB without staging anything', async () => {
    const local = localFile('filme-gigante.mov', DROPPED_LOCAL_FILE_MAX_BYTES + 1);

    const result = await importDroppedUri(workspace, pathToFileURL(local).href, {
      fetch: fetchNever(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('256 MB'),
    });
    expect(stagedFiles()).toEqual([]);
  });

  it('refuses a directory and a missing path', async () => {
    const dirResult = await importDroppedUri(
      workspace,
      pathToFileURL(sourceDir).href,
      { fetch: fetchNever() },
    );
    expect(dirResult).toMatchObject({
      ok: false,
      error: expect.stringMatching(/não é um arquivo/i),
    });

    const missing = await importDroppedUri(
      workspace,
      pathToFileURL(path.join(sourceDir, 'nada.txt')).href,
      { fetch: fetchNever() },
    );
    expect(missing).toMatchObject({
      ok: false,
      error: expect.stringMatching(/não encontrado/i),
    });
    expect(stagedFiles()).toEqual([]);
  });

  it('resolves a symlink to a regular file but refuses one to a directory', async () => {
    const target = localFile('real.txt', 'conteúdo real');
    const fileLink = path.join(sourceDir, 'atalho.txt');
    const dirLink = path.join(sourceDir, 'pasta-link');
    fs.symlinkSync(target, fileLink);
    fs.symlinkSync(workspace, dirLink);

    const viaLink = await importDroppedUri(workspace, pathToFileURL(fileLink).href, {
      fetch: fetchNever(),
    });
    expect(viaLink.ok).toBe(true);
    if (viaLink.ok) {
      expect(fs.readFileSync(path.join(workspace, viaLink.path), 'utf8')).toBe(
        'conteúdo real',
      );
    }

    const viaDirLink = await importDroppedUri(workspace, pathToFileURL(dirLink).href, {
      fetch: fetchNever(),
    });
    expect(viaDirLink).toMatchObject({
      ok: false,
      error: expect.stringMatching(/não é um arquivo/i),
    });
  });
});

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [
  { address: '93.184.216.34', family: 4 },
  { address: '10.0.0.9', family: 4 },
];
function fetchSequence(replies: Response[]): ReturnType<typeof vi.fn> {
  const queue = [...replies];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('fetch chamado além das respostas previstas');
    return next;
  });
}
function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

describe('isBlockedAddress — faixas locais e privadas', () => {
  it.each([
    '127.0.0.1', '127.9.9.9', '0.0.0.0', '10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::3',
    '[::1]', '::ffff:127.0.0.1', '::ffff:10.1.2.3', 'ff02::1',
  ])('bloqueia %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });
  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'deixa passar o público %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
  it('trata lixo como bloqueado — nunca falha aberto', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('999.1.1.1')).toBe(true);
  });
});

describe('importDroppedUri — alvos locais e privados (SSRF)', () => {
  it.each([
    'http://127.0.0.1:62061/mcp',
    'http://localhost:9235/json',
    'http://foo.localhost/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/admin',
    'http://192.168.1.1/',
    'http://[::1]:8080/',
    'http://0.0.0.0/',
  ])('recusa %s sem tocar a rede', async (uri) => {
    const fetchImpl = fetchNever();
    const result = await importDroppedUri(workspace, uri, { fetch: fetchImpl, lookup: publicLookup });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/local ou de rede privada/i) });
  });

  it('recusa um nome que resolve para endereço privado, mesmo com um público junto', async () => {
    const fetchImpl = fetchNever();
    const result = await importDroppedUri(workspace, 'https://intranet.example.com/x.png', {
      fetch: fetchImpl,
      lookup: privateLookup,
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/local ou de rede privada/i) });
  });

  it('revalida cada redirecionamento: público → loopback é recusado sem baixar', async () => {
    const fetchImpl = fetchSequence([redirectTo('http://127.0.0.1:62061/mcp')]);
    const result = await importDroppedUri(workspace, 'https://files.example.com/a', {
      fetch: fetchImpl as unknown as typeof fetch,
      lookup: publicLookup,
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/local ou de rede privada/i) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('segue um redirecionamento público (Location relativo inclusive) e baixa', async () => {
    const fetchImpl = fetchSequence([
      redirectTo('/final/relatorio.pdf', 301),
      new Response(new TextEncoder().encode('pdf-bytes'), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
    ]);
    const result = await importDroppedUri(workspace, 'https://files.example.com/a', {
      fetch: fetchImpl as unknown as typeof fetch,
      lookup: publicLookup,
    });
    expect(result).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://files.example.com/final/relatorio.pdf',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('desiste de uma cadeia de redirecionamentos acima do teto', async () => {
    const replies = Array.from({ length: DROPPED_URL_MAX_REDIRECTS + 2 }, (_, i) =>
      redirectTo(`https://files.example.com/hop-${i}`),
    );
    const fetchImpl = fetchSequence(replies);
    const result = await importDroppedUri(workspace, 'https://files.example.com/start', {
      fetch: fetchImpl as unknown as typeof fetch,
      lookup: publicLookup,
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/redirecionou mais de/i) });
  });

  it('recusa Location para fora de http(s)', async () => {
    const fetchImpl = fetchSequence([redirectTo('file:///etc/passwd')]);
    const result = await importDroppedUri(workspace, 'https://files.example.com/a', {
      fetch: fetchImpl as unknown as typeof fetch,
      lookup: publicLookup,
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/fora de http/i) });
  });
});

describe('importDroppedUri — http(s)', () => {
  it('downloads with an AbortSignal and names the file from Content-Disposition', async () => {
    const fetchImpl = fetchReturning(
      response({
        headers: {
          'content-disposition': 'attachment; filename="relatório final.pdf"',
          'content-type': 'application/pdf',
        },
        body: bytesStream([new TextEncoder().encode('pdf-bytes')]),
      }),
    );

    const result = await importDroppedUri(
      workspace,
      'https://files.example.com/download?id=42',
      { fetch: fetchImpl as unknown as typeof fetch, lookup: publicLookup },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toMatch(/relat_rio_final\.pdf$/);
    expect(fs.readFileSync(path.join(workspace, result.path), 'utf8')).toBe(
      'pdf-bytes',
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://files.example.com/download?id=42',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('aborts a body that grows past 14 MB and stages nothing', async () => {
    let cancelled = false;
    const fetchImpl = fetchReturning(
      response({
        headers: { 'content-type': 'video/mp4' },
        body: endlessStream(1024 * 1024, () => {
          cancelled = true;
        }),
      }),
    );

    const result = await importDroppedUri(workspace, 'https://example.com/big.mp4', {
      fetch: fetchImpl as unknown as typeof fetch, lookup: publicLookup,
    });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('14 MB') });
    expect(cancelled).toBe(true);
    expect(stagedFiles()).toEqual([]);
  });

  it('refuses a declared Content-Length above the limit before reading the body', async () => {
    let pulled = false;
    const fetchImpl = fetchReturning(
      response({
        headers: { 'content-length': String(DROPPED_ATTACHMENT_MAX_BYTES + 1) },
        // highWaterMark 0: sem leitor, o stream não puxa sozinho — assim
        // "pull" só dispara se o import de fato começar a ler o corpo.
        body: new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulled = true;
              controller.enqueue(new Uint8Array(8));
            },
          },
          { highWaterMark: 0 },
        ),
      }),
    );

    const result = await importDroppedUri(workspace, 'https://example.com/big.zip', {
      fetch: fetchImpl as unknown as typeof fetch, lookup: publicLookup,
    });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('14 MB') });
    expect(pulled).toBe(false);
    expect(stagedFiles()).toEqual([]);
  });

  it('names the file from the last URL segment when there is no Content-Disposition', async () => {
    const fetchImpl = fetchReturning(
      response({ body: bytesStream([new Uint8Array([1, 2, 3])]) }),
    );

    const result = await importDroppedUri(
      workspace,
      'https://cdn.example.com/media/foto%20final.jpg?w=800',
      { fetch: fetchImpl as unknown as typeof fetch, lookup: publicLookup },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toMatch(/foto_final\.jpg$/);
  });

  it('falls back to download-<timestamp>.<ext> from the content type', async () => {
    const fetchImpl = fetchReturning(
      response({
        headers: { 'content-type': 'image/png; charset=binary' },
        body: bytesStream([new Uint8Array([9])]),
      }),
    );

    const result = await importDroppedUri(workspace, 'https://example.com/', {
      fetch: fetchImpl as unknown as typeof fetch, lookup: publicLookup,
      now: () => Date.UTC(2026, 8, 9, 12, 30, 0),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toMatch(/download-2026-09-09T12-30-00\.png$/);
  });

  it('reports the HTTP status of a failed download', async () => {
    const fetchImpl = fetchReturning(response({ status: 404, body: null }));

    const result = await importDroppedUri(workspace, 'https://example.com/x.png', {
      fetch: fetchImpl as unknown as typeof fetch, lookup: publicLookup,
    });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('404') });
    expect(stagedFiles()).toEqual([]);
  });

  it('refuses a redirect whose Location leaves http(s) without staging anything', async () => {
    // Com redirecionamento MANUAL o salto para `file:` é recusado antes de
    // qualquer byte; nunca há um 200 "final" fora de http(s).
    const fetchImpl = fetchSequence([redirectTo('file:///etc/passwd')]);

    const result = await importDroppedUri(workspace, 'https://example.com/redirect', {
      fetch: fetchImpl as unknown as typeof fetch, lookup: publicLookup,
    });

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/http/i) });
    expect(stagedFiles()).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up after the 20 s deadline', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );

    const pending = importDroppedUri(workspace, 'https://example.com/slow.bin', {
      fetch: fetchImpl as unknown as typeof fetch, lookup: publicLookup,
    });
    await vi.advanceTimersByTimeAsync(DROPPED_URL_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('20 s'),
    });
    expect(stagedFiles()).toEqual([]);
  });
});

describe('importDroppedUri — esquemas recusados', () => {
  it.each(['data:text/plain;base64,aGk=', 'blob:https://x/y', 'javascript:alert(1)'])(
    'never fetches or stages %s',
    async (uri) => {
      const fetchImpl = fetchNever();

      const result = await importDroppedUri(workspace, uri, { fetch: fetchImpl });

      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/http/i) });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(stagedFiles()).toEqual([]);
    },
  );
});

describe('downloadedFileName', () => {
  const url = new URL('https://example.com/path/arquivo.bin');

  it('prefers the RFC 5987 filename* form and decodes it', () => {
    expect(
      downloadedFileName(
        "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''relat%C3%B3rio.pdf",
        url,
        null,
        0,
      ),
    ).toBe('relatório.pdf');
  });

  it('keeps only the basename of a Content-Disposition path', () => {
    expect(
      downloadedFileName('attachment; filename="../../evil.sh"', url, null, 0),
    ).toBe('evil.sh');
  });

  it('uses the URL segment, then the content-type fallback', () => {
    expect(downloadedFileName(null, url, 'text/plain', 0)).toBe('arquivo.bin');
    expect(
      downloadedFileName(null, new URL('https://example.com/'), 'application/pdf', 0),
    ).toMatch(/^download-.+\.pdf$/);
    expect(
      downloadedFileName(null, new URL('https://example.com/'), null, 0),
    ).toMatch(/^download-.+\.bin$/);
  });
});

describe('macPrivacyMessage — TCC do macOS (F-582)', () => {
  const home = '/Users/ana';
  const deps = { platform: 'darwin' as const, homeDir: home };
  const errno = (code: string) =>
    Object.assign(new Error('boom'), { code }) as NodeJS.ErrnoException;

  it('EPERM em ~/Downloads aponta Ajustes › Arquivos e Pastas', () => {
    const message = macPrivacyMessage(
      '/Users/ana/Downloads/WhatsApp Video.mp4',
      errno('EPERM'),
      deps,
    );
    expect(message).toContain('WhatsApp Video.mp4');
    expect(message).toContain('Ajustes do Sistema');
    expect(message).toContain('Arquivos e Pastas');
    expect(message).toContain('Downloads');
  });

  it('EACCES em ~/Desktop e ~/Documents também dá a dica com a pasta certa', () => {
    expect(
      macPrivacyMessage('/Users/ana/Desktop/a.png', errno('EACCES'), deps),
    ).toContain('Desktop');
    expect(
      macPrivacyMessage(
        '/Users/ana/Documents/b.pdf',
        errno('EACCES'),
        deps,
      ),
    ).toContain('Documentos');
  });

  it('fora das pastas protegidas, ou fora do darwin, não dá dica', () => {
    expect(
      macPrivacyMessage('/tmp/a.png', errno('EPERM'), deps),
    ).toBeNull();
    expect(
      macPrivacyMessage('/Users/ana/Downloads/a.png', errno('EPERM'), {
        platform: 'linux',
        homeDir: home,
      }),
    ).toBeNull();
    expect(
      macPrivacyMessage(
        '/Users/ana/Downloads/a.png',
        errno('ENOENT'),
        deps,
      ),
    ).toBeNull();
  });
});
