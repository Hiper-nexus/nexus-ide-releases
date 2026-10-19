import https from 'node:https';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  downloadAuthenticatedProviderAsset,
  downloadProviderAsset,
  fetchPinnedProviderAsset,
} from './media-download';

const PUBLIC_IP = '93.184.216.34';

function deps(fetchFn: typeof fetch, addresses = [PUBLIC_IP]) {
  return {
    fetchFn,
    resolveHostname: vi.fn(async () => addresses),
  };
}

describe('provider media downloads', () => {
  it('downloads an allowlisted HTTPS provider URL with a bounded body', async () => {
    const fetchFn = vi.fn(
      async () => new Response('video'),
    ) as unknown as typeof fetch;
    const input = deps(fetchFn);
    await expect(
      downloadProviderAsset(
        'https://replicate.delivery/output/video.mp4',
        'replicate-video',
        input,
        { maxBytes: 16, timeoutMs: 100 },
      ),
    ).resolves.toEqual(Buffer.from('video'));
    expect(input.resolveHostname).toHaveBeenCalledWith('replicate.delivery');
    expect(fetchFn).toHaveBeenCalledWith(
      'https://replicate.delivery/output/video.mp4',
      expect.objectContaining({
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('pins the download transport to the DNS addresses it just approved', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const fetchPinned = vi.fn(async () => new Response('video'));
    const input = {
      fetchFn,
      fetchPinned,
      resolveHostname: vi.fn(async () => [PUBLIC_IP]),
    };

    await expect(
      downloadProviderAsset(
        'https://replicate.delivery/output/video.mp4',
        'replicate-video',
        input,
        { maxBytes: 16, timeoutMs: 100 },
      ),
    ).resolves.toEqual(Buffer.from('video'));

    expect(fetchPinned).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'replicate.delivery' }),
      [PUBLIC_IP],
      expect.objectContaining({
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects non-HTTPS and non-provider hosts before making a request', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const input = deps(fetchFn);

    await expect(
      downloadProviderAsset(
        'http://replicate.delivery/output.mp4',
        'replicate-video',
        input,
      ),
    ).rejects.toThrow(/HTTPS/);
    await expect(
      downloadProviderAsset(
        'https://attacker.example/output.mp4',
        'replicate-video',
        input,
      ),
    ).rejects.toThrow(/domínio não permitido/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects allowlisted hosts when any DNS answer is not public', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const input = deps(fetchFn, [PUBLIC_IP, '127.0.0.1']);
    await expect(
      downloadProviderAsset(
        'https://replicate.delivery/output.mp4',
        'replicate-video',
        input,
      ),
    ).rejects.toThrow(/rede pública/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('revalidates every redirect target', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example/payload.mp4' },
        }),
    ) as unknown as typeof fetch;
    const input = deps(fetchFn);
    await expect(
      downloadProviderAsset(
        'https://replicate.delivery/output.mp4',
        'replicate-video',
        input,
      ),
    ).rejects.toThrow(/domínio não permitido/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('revalidates DNS after a redirect between allowlisted provider hosts', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://files.replicate.delivery/payload.mp4' },
        }),
    ) as unknown as typeof fetch;
    const input = {
      fetchFn,
      resolveHostname: vi.fn(async (hostname: string) =>
        hostname === 'replicate.delivery' ? [PUBLIC_IP] : ['127.0.0.1'],
      ),
    };

    await expect(
      downloadProviderAsset(
        'https://replicate.delivery/output.mp4',
        'replicate-video',
        input,
      ),
    ).rejects.toThrow(/rede pública/);
    expect(input.resolveHostname).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('aborts downloads that exceed the body limit', async () => {
    const fetchFn = vi.fn(
      async () => new Response('too-large'),
    ) as unknown as typeof fetch;
    await expect(
      downloadProviderAsset(
        'https://oaidalleapiprodscus.blob.core.windows.net/private/image.png',
        'openai-image',
        deps(fetchFn),
        { maxBytes: 4, timeoutMs: 100 },
      ),
    ).rejects.toThrow(/limite de 4 bytes/);
  });

  it('aborts downloads after the configured timeout', async () => {
    const fetchFn = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    ) as unknown as typeof fetch;

    await expect(
      downloadProviderAsset(
        'https://replicate.delivery/output.mp4',
        'replicate-video',
        deps(fetchFn),
        { maxBytes: 16, timeoutMs: 10 },
      ),
    ).rejects.toThrow(/timeout/);
  });

  it('composes caller revocation into the pinned download transport', async () => {
    const caller = new AbortController();
    const observed: { signal?: AbortSignal } = {};
    const fetchPinned = vi.fn(
      async (_url: URL, _addresses: readonly string[], init: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          observed.signal = init.signal ?? undefined;
          const onAbort = () => reject(new Error('caller revoked'));
          if (init.signal?.aborted) {
            onAbort();
            return;
          }
          init.signal?.addEventListener('abort', onAbort, { once: true });
          queueMicrotask(() => caller.abort('session_authority_revoked'));
        }),
    );

    await expect(
      downloadProviderAsset(
        'https://replicate.delivery/output.mp4',
        'replicate-video',
        {
          fetchFn: vi.fn() as unknown as typeof fetch,
          fetchPinned,
          resolveHostname: vi.fn(async () => [PUBLIC_IP]),
        },
        { maxBytes: 16, timeoutMs: 1_000 },
        caller.signal,
      ),
    ).rejects.toThrow(/caller revoked/);
    expect(fetchPinned).toHaveBeenCalledOnce();
    expect(observed.signal?.aborted).toBe(true);
  });

  it('times out DNS resolution before any HTTP request', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    await expect(
      downloadProviderAsset(
        'https://replicate.delivery/output.mp4',
        'replicate-video',
        {
          fetchFn,
          resolveHostname: async () => await new Promise<string[]>(() => {}),
        },
        { maxBytes: 16, timeoutMs: 10 },
      ),
    ).rejects.toThrow(/timeout no DNS/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('F-1599: o vídeo do Grok Imagine só baixa de vidgen.x.ai', async () => {
    const fetchFn = vi.fn(async () => new Response('mp4')) as unknown as typeof fetch;
    await expect(
      downloadProviderAsset(
        'https://vidgen.x.ai/xai-vidgen-bucket/xai-video-abc.mp4',
        'xai-video',
        deps(fetchFn),
      ),
    ).resolves.toEqual(Buffer.from('mp4'));
    for (const url of [
      'https://api.x.ai/v1/files/abc.mp4',
      'https://x.ai/video.mp4',
      'https://imgen.x.ai/xai-imgen/abc.mp4',
      'https://vidgen.x.ai.evil.example/abc.mp4',
      'https://evilvidgen.x.ai/abc.mp4',
    ]) {
      await expect(downloadProviderAsset(url, 'xai-video', deps(fetchFn))).rejects.toThrow(
        'xai-video: domínio não permitido para download',
      );
    }
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  describe('F-1587: download autenticado da Files API do Gemini', () => {
    const FILE_URL =
      'https://generativelanguage.googleapis.com/v1beta/files/abc123:download?alt=media';
    const credential = {
      host: 'generativelanguage.googleapis.com',
      headers: { 'x-goog-api-key': 'gemini-key' },
    };

    it('manda a chave no primeiro salto e nunca no redirect', async () => {
      const seen: Array<{ url: string; init?: RequestInit }> = [];
      const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
        seen.push({ url, init });
        return seen.length === 1
          ? new Response(null, {
              status: 302,
              headers: { location: 'https://video-downloads.googleusercontent.com/v.mp4' },
            })
          : new Response('omni-mp4');
      }) as unknown as typeof fetch;
      await expect(
        downloadAuthenticatedProviderAsset(FILE_URL, 'google-video', credential, deps(fetchFn)),
      ).resolves.toEqual(Buffer.from('omni-mp4'));
      expect(seen[0]?.url).toBe(FILE_URL);
      expect(new Headers(seen[0]?.init?.headers).get('x-goog-api-key')).toBe('gemini-key');
      expect(seen[1]?.url).toBe('https://video-downloads.googleusercontent.com/v.mp4');
      expect(new Headers(seen[1]?.init?.headers).get('x-goog-api-key')).toBeNull();
    });

    it('recusa mandar a chave para outro host, mesmo da lista do Google', async () => {
      const fetchFn = vi.fn() as unknown as typeof fetch;
      await expect(
        downloadAuthenticatedProviderAsset(
          'https://storage.googleapis.com/bucket/v.mp4',
          'google-video',
          credential,
          deps(fetchFn),
        ),
      ).rejects.toThrow('google-video: credencial só vai para generativelanguage.googleapis.com');
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('o transporte fixado no IP leva os cabeçalhos do pedido junto do Host', async () => {
      let options: https.RequestOptions | undefined;
      const spy = vi.spyOn(https, 'request').mockImplementation(((
        opts: https.RequestOptions,
        onResponse: (res: EventEmitter & { statusCode: number; headers: object }) => void,
      ) => {
        options = opts;
        const req = Object.assign(new EventEmitter(), {
          end: () => {
            const res = Object.assign(new EventEmitter(), { statusCode: 204, headers: {} });
            onResponse(res);
          },
          destroy: () => {},
        });
        return req;
      }) as unknown as typeof https.request);
      try {
        const response = await fetchPinnedProviderAsset(new URL(FILE_URL), [PUBLIC_IP], {
          headers: { 'x-goog-api-key': 'gemini-key' },
        });
        expect(response.status).toBe(204);
      } finally {
        spy.mockRestore();
      }
      expect(options?.host).toBe(PUBLIC_IP);
      expect(options?.headers).toEqual({
        'x-goog-api-key': 'gemini-key',
        Host: 'generativelanguage.googleapis.com',
      });
    });
  });
});
