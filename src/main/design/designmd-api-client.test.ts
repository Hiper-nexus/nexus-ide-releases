import { describe, expect, it, vi } from 'vitest';
import {
  DesignMdApiClient,
  DesignMdApiError,
  DesignMdAuthError,
} from './designmd-api-client';

function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
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
  ...summaryFixture,
  content: '# DESIGN.md\n\nUse a 4pt grid.',
};

describe('DesignMdApiClient', () => {
  it('searchKits calls the public endpoint without an API key', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
      json({ data: [summaryFixture] }),
    );

    const client = new DesignMdApiClient(d);
    const result = await client.searchKits({ query: 'clean', limit: 10 });

    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('acme/clean');
    expect(d.getApiKey).not.toHaveBeenCalled();
    const call = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://designmd.test/api/v1/kits?q=clean&limit=10');
    expect((call[1].headers as Headers).get('authorization')).toBeNull();
  });

  it('listPopularKits returns parsed summaries', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
      json({ data: [summaryFixture] }),
    );

    const result = await new DesignMdApiClient(d).listPopularKits(5);

    expect(result[0].license).toBe('mit');
    expect((d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0])
      .toBe('https://designmd.test/api/v1/kits/popular?limit=5');
  });

  it('listTags returns string tags', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
      json({ data: ['minimal', 'saas'] }),
    );

    const result = await new DesignMdApiClient(d).listTags();

    expect(result).toEqual(['minimal', 'saas']);
  });

  it('getKit requires and sends the API key', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(json(detailFixture));

    const result = await new DesignMdApiClient(d).getKit('acme/clean');

    expect(result.content).toBe('# DESIGN.md\n\nUse a 4pt grid.');
    expect(d.getApiKey).toHaveBeenCalled();
    const call = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://designmd.test/api/v1/kits/acme%2Fclean');
    expect((call[1].headers as Headers).get('authorization')).toBe('Bearer key-123');
  });

  it('getKit accepts a full designmd.ai URL and normalizes it', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(json(detailFixture));

    await new DesignMdApiClient(d).getKit('https://designmd.ai/acme/clean');

    const call = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://designmd.test/api/v1/kits/acme%2Fclean');
  });

  it('getKit fails closed when the API key is missing', async () => {
    const d = deps({ getApiKey: () => null });

    await expect(new DesignMdApiClient(d).getKit('acme/clean')).rejects.toThrow(
      DesignMdAuthError,
    );
    expect(d.fetchFn).not.toHaveBeenCalled();
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
      json({ data: [{ ...summaryFixture, description: big }] }, 200, {
        'content-length': '300000',
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
    (d.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(json(detailFixture));

    const result = await new DesignMdApiClient(d).publishKit({
      slug: 'acme/clean',
      name: 'Clean UI Kit',
      content: '# DESIGN.md\n\nUse a 4pt grid.',
      license: 'mit',
      tags: ['minimal'],
    });

    expect(result.slug).toBe('acme/clean');
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
