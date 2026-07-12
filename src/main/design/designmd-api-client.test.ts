import { describe, expect, it, vi } from 'vitest';
import {
  DesignMdApiClient,
  DesignMdApiError,
  DesignMdAuthError,
  parseKitIdentifier,
} from './designmd-api-client';

function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function text(body: string, status = 200, headers?: Record<string, string>) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  });
}

function deps(over: Record<string, unknown> = {}) {
  return {
    baseUrl: 'https://designmd.test/api/v1',
    fetchFn: vi.fn(),
    getApiKey: vi.fn(() => 'key-123'),
    ...over,
  };
}

/** Shape returned by the live designmd.ai list endpoint. */
const liveSummaryFixture = {
  id: 'd649f3b2-abea-456b-ac2f-b01be23025a5',
  slug: 'clean',
  name: 'Clean UI Kit',
  description: 'A clean starter kit.',
  url: 'https://designmd.ai/acme/clean',
  author: {
    username: 'acme',
    display_name: 'Acme',
    avatar_url: 'https://example.com/a.png',
  },
  preview_colors: ['#111111', '#ffffff'],
  tags: ['minimal', 'saas'],
  license: 'mit',
  download_count: 42,
  like_count: 7,
  created_at: '2026-03-23 06:33:20.635',
};

/** Legacy/camelCase shape kept for publish/local fixtures. */
const summaryFixture = {
  slug: 'acme/clean',
  name: 'Clean UI Kit',
  description: 'A clean starter kit.',
  author: 'Acme',
  url: 'https://designmd.ai/acme/clean',
  tags: ['minimal', 'saas'],
  license: 'mit',
  downloadCount: 42,
  likeCount: 7,
};

const detailFixture = {
  ...liveSummaryFixture,
  content_preview: '# DESIGN.md\n\nPreview only.',
  version: 1,
};

describe('parseKitIdentifier', () => {
  it('parses author/slug and full designmd.ai URLs', () => {
    expect(parseKitIdentifier('acme/clean')).toEqual({
      username: 'acme',
      slug: 'clean',
    });
    expect(parseKitIdentifier('https://designmd.ai/acme/clean')).toEqual({
      username: 'acme',
      slug: 'clean',
    });
  });

  it('rejects invalid identifiers', () => {
    expect(() => parseKitIdentifier('')).toThrow(DesignMdApiError);
    expect(() => parseKitIdentifier('only-slug')).toThrow(DesignMdApiError);
    expect(() => parseKitIdentifier('a/../b')).toThrow(DesignMdApiError);
  });
});

describe('DesignMdApiClient', () => {
  it('searchKits calls the public endpoint without an API key', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
      json({ data: [liveSummaryFixture] }),
    );

    const client = new DesignMdApiClient(d);
    const result = await client.searchKits({ query: 'clean', limit: 10 });

    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('acme/clean');
    expect(result[0].author).toBe('acme');
    expect(result[0].downloadCount).toBe(42);
    expect(result[0].likeCount).toBe(7);
    expect(d.getApiKey).not.toHaveBeenCalled();
    const call = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://designmd.test/api/v1/kits?q=clean&limit=10');
    expect((call[1].headers as Headers).get('authorization')).toBeNull();
  });

  it('searchKits sends tags as a comma-separated query param', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(json({ data: [] }));

    await new DesignMdApiClient(d).searchKits({ tags: ['minimal', 'saas'] });

    const call = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://designmd.test/api/v1/kits?tags=minimal%2Csaas');
  });

  it('normalizes snake_case live API kits including extra keys', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
      json({ data: [liveSummaryFixture] }),
    );

    const [kit] = await new DesignMdApiClient(d).searchKits();

    expect(kit).toEqual({
      slug: 'acme/clean',
      name: 'Clean UI Kit',
      description: 'A clean starter kit.',
      author: 'acme',
      url: 'https://designmd.ai/acme/clean',
      tags: ['minimal', 'saas'],
      license: 'mit',
      downloadCount: 42,
      likeCount: 7,
    });
  });

  it('listPopularKits uses /kits?sort=popular', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
      json({ data: [liveSummaryFixture] }),
    );

    const result = await new DesignMdApiClient(d).listPopularKits(5);

    expect(result[0].license).toBe('mit');
    expect((d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0])
      .toBe('https://designmd.test/api/v1/kits?sort=popular&limit=5');
  });

  it('listTags accepts string tags and {name,slug,count} objects', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
      json({
        data: [
          'minimal',
          { name: 'SaaS', slug: 'saas', count: 12 },
          { name: 'Dark', count: 3 },
        ],
      }),
    );

    const result = await new DesignMdApiClient(d).listTags();

    expect(result).toEqual(['minimal', 'saas', 'Dark']);
  });

  it('getKit fetches metadata + authenticated /raw content', async () => {
    const d = deps();
    const fetchFn = d.fetchFn as ReturnType<typeof vi.fn>;
    fetchFn.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/raw')) {
        return text('# DESIGN.md\n\nUse a 4pt grid.');
      }
      return json(detailFixture);
    });

    const result = await new DesignMdApiClient(d).getKit('acme/clean');

    expect(result.content).toBe('# DESIGN.md\n\nUse a 4pt grid.');
    expect(result.slug).toBe('acme/clean');
    expect(result.author).toBe('acme');
    expect(d.getApiKey).toHaveBeenCalled();
    const urls = fetchFn.mock.calls.map((call) => call[0] as string).sort();
    expect(urls).toEqual([
      'https://designmd.test/api/v1/kits/acme/clean',
      'https://designmd.test/api/v1/kits/acme/clean/raw',
    ]);
    const rawCall = fetchFn.mock.calls.find((call) => String(call[0]).endsWith('/raw'));
    expect((rawCall![1].headers as Headers).get('authorization')).toBe('Bearer key-123');
  });

  it('getKit accepts a full designmd.ai URL and normalizes it', async () => {
    const d = deps();
    const fetchFn = d.fetchFn as ReturnType<typeof vi.fn>;
    fetchFn.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/raw')) return text('# content');
      return json(detailFixture);
    });

    await new DesignMdApiClient(d).getKit('https://designmd.ai/acme/clean');

    const urls = fetchFn.mock.calls.map((call) => call[0] as string);
    expect(urls).toContain('https://designmd.test/api/v1/kits/acme/clean');
    expect(urls).toContain('https://designmd.test/api/v1/kits/acme/clean/raw');
  });

  it('getKit fails closed when the API key is missing', async () => {
    const d = deps({ getApiKey: () => null });
    const fetchFn = d.fetchFn as ReturnType<typeof vi.fn>;
    fetchFn.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/raw')) {
        throw new Error('should not fetch raw without key');
      }
      return json(detailFixture);
    });

    await expect(new DesignMdApiClient(d).getKit('acme/clean')).rejects.toThrow(
      DesignMdAuthError,
    );
  });

  it('throws DesignMdAuthError on 401/403', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(json({}, 401));

    await expect(new DesignMdApiClient(d).getKit('acme/clean')).rejects.toThrow(
      DesignMdAuthError,
    );
  });

  it('throws DesignMdApiError on other HTTP errors', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(json({}, 500));

    await expect(new DesignMdApiClient(d).searchKits()).rejects.toThrow(
      DesignMdApiError,
    );
  });

  it('throws DesignMdApiError on malformed JSON', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    await expect(new DesignMdApiClient(d).searchKits()).rejects.toThrow(
      DesignMdApiError,
    );
  });

  it('throws DesignMdApiError when response exceeds byte budget', async () => {
    const d = deps();
    const big = 'x'.repeat(512);
    (d.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
      json({ data: [{ ...liveSummaryFixture, description: big }] }, 200, {
        'content-length': '1500000',
      }),
    );

    await expect(new DesignMdApiClient(d).searchKits({ limit: 1 })).rejects.toThrow(
      /exceeds byte budget/,
    );
  });

  it('rejects invalid kit identifiers', async () => {
    const d = deps();

    await expect(new DesignMdApiClient(d).getKit('')).rejects.toThrow(DesignMdApiError);
    await expect(new DesignMdApiClient(d).getKit('a/../b')).rejects.toThrow(DesignMdApiError);
  });

  it('publishKit posts a new kit with the API key', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
      json({ ...summaryFixture, content: '# DESIGN.md\n\nUse a 4pt grid.' }),
    );

    const result = await new DesignMdApiClient(d).publishKit({
      slug: 'acme/clean',
      name: 'Clean UI Kit',
      content: '# DESIGN.md\n\nUse a 4pt grid.',
      license: 'mit',
      tags: ['minimal'],
    });

    expect(result.slug).toBe('acme/clean');
    expect(result.content).toBe('# DESIGN.md\n\nUse a 4pt grid.');
    const call = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://designmd.test/api/v1/kits');
    expect((call[1] as RequestInit).method).toBe('POST');
    const headers = call[1].headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer key-123');
    expect(headers.get('content-type')).toBe('application/json');
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.slug).toBe('acme/clean');
    expect(body.content).toBe('# DESIGN.md\n\nUse a 4pt grid.');
  });
});
