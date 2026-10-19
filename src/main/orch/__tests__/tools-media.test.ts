import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMediaTools } from '../tools-media';
import { testProjectScope } from './scope-fixture';

const mocks = vi.hoisted(() => {
  class MediaProviderUnavailableError extends Error {
    requestedKind: string;
    constructor(requestedKind: string, message: string) {
      super(message);
      this.name = 'MediaProviderUnavailableError';
      this.requestedKind = requestedKind;
    }
  }
  return {
    workspaceRoot: vi.fn(() => '/authorized/workspace'),
    generateImage: vi.fn(),
    generateVideo: vi.fn(),
    generateAudio: vi.fn(),
    recordUsage: vi.fn(),
    MediaProviderUnavailableError,
    keyedProviders: [] as string[],
  };
});

vi.mock('../workspace-path', () => ({
  resolveCwdForScope: mocks.workspaceRoot,
}));
vi.mock('../../media/media-generation', () => ({
  generateImage: mocks.generateImage,
  generateVideo: mocks.generateVideo,
  generateAudio: mocks.generateAudio,
  MediaJobTimeoutError: class MediaJobTimeoutError extends Error {
    jobId: string;
    provider: string;
    constructor(provider: string, jobId: string) {
      super(`${provider}: timeout ${jobId}`);
      this.jobId = jobId;
      this.provider = provider;
    }
  },
}));
// F-1598: a lista e os padrões são os reais — o teste trava o formato que o
// agente lê; só a chave e a recusa por falta dela são simuladas.
vi.mock('../../media/media-providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../media/media-providers')>()),
  MediaProviderUnavailableError: mocks.MediaProviderUnavailableError,
  computeMediaTierAlternatives: () => [],
}));
vi.mock('../../media/media-model-aliases', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../media/media-model-aliases')>()),
  listMediaModelAliases: () => ({
    seedream: 'bytedance/seedream-5-pro',
    seedance: 'bytedance/seedance-2.0',
  }),
  listMediaModelAliasesByKind: () => ({
    image: { grok: 'grok-imagine-image-2.0' },
    video: { grok: 'grok-imagine-video-1.5' },
  }),
}));
vi.mock('../../media/media-keys', () => ({
  hasMediaKey: (def: { id: string }) => mocks.keyedProviders.includes(def.id),
  maskedMediaKey: () => 'AIza…mask',
}));
vi.mock('../../usage/media-usage-recorder', () => ({
  recordMediaUsage: mocks.recordUsage,
}));

const result = {
  ok: true,
  path: '/authorized/workspace/generated.png',
  provider: 'google-image',
  model: 'test-model',
  kind: 'image',
  estimatedCostUsd: 0,
  durationMs: 1,
};

describe('media MCP tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspaceRoot.mockReturnValue('/authorized/workspace');
    mocks.generateImage.mockResolvedValue(result);
  });

  it('forces confirmation for every generation tool', () => {
    const tools = buildMediaTools();
    for (const name of [
      'nexus_image_generate',
      'nexus_video_generate',
      'nexus_audio_generate',
    ]) {
      expect(tools.find((tool) => tool.name === name)?.requiresConfirm).toBe(
        true,
      );
    }
  });

  it('F-1599: o Grok Imagine (xai-image/xai-video) é oferecido e "grok" depende da ferramenta', async () => {
    const tools = buildMediaTools();
    const providerEnum = (name: string) =>
      (tools.find((tool) => tool.name === name)!.inputSchema as {
        properties: { provider: { enum: string[] } };
      }).properties.provider.enum;
    expect(providerEnum('nexus_image_generate')).toContain('xai-image');
    expect(providerEnum('nexus_video_generate')).toContain('xai-video');
    const listing = (await tools
      .find((tool) => tool.name === 'nexus_media_providers')!
      .handler({}, fakeCtx())) as { aliasesByKind: Record<string, Record<string, string>> };
    expect(listing.aliasesByKind.video?.grok).toBe('grok-imagine-video-1.5');
    expect(listing.aliasesByKind.image?.grok).toBe('grok-imagine-image-2.0');
  });

  it('binds generation to the canonical active workspace', async () => {
    const image = buildMediaTools().find(
      (tool) => tool.name === 'nexus_image_generate',
    )!;
    await image.handler({ prompt: 'safe prompt' }, fakeCtx());
    expect(mocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ baseDir: '/authorized/workspace' }),
    );
  });

  it('fails closed when no authorized workspace is open', async () => {
    mocks.workspaceRoot.mockImplementation(() => {
      throw new Error('no workspace open');
    });
    const image = buildMediaTools().find(
      (tool) => tool.name === 'nexus_image_generate',
    )!;
    await expect(
      image.handler({ prompt: 'safe prompt' }, fakeCtx()),
    ).rejects.toThrow(/no workspace open/);
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it('does not report generation success when scoped accounting fails', async () => {
    mocks.recordUsage.mockRejectedValueOnce(
      new Error('project runtime is safe read-only'),
    );
    const image = buildMediaTools().find(
      (tool) => tool.name === 'nexus_image_generate',
    )!;
    await expect(
      image.handler({ prompt: 'safe prompt' }, fakeCtx()),
    ).rejects.toThrow(/safe read-only/i);
    expect(mocks.generateImage).toHaveBeenCalledOnce();
    expect(mocks.recordUsage).toHaveBeenCalledWith(
      result,
      fakeCtx(),
      undefined,
    );
  });

  it('does not persist usage when authority is revoked while generation awaits', async () => {
    let current = true;
    mocks.generateImage.mockImplementationOnce(async () => {
      current = false;
      return result;
    });
    const image = buildMediaTools().find(
      (tool) => tool.name === 'nexus_image_generate',
    )!;

    await expect(
      image.handler({ prompt: 'safe prompt' }, fakeCtx(), {
        assertCurrentAuthority: () => {
          if (!current) throw new Error('session_authority_revoked');
        },
      }),
    ).rejects.toThrow('session_authority_revoked');
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });
});

describe('tier degrade UX — P2-3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('nexus_video_generate retorna ok:false + tierAlternatives quando provider indisponível', async () => {
    mocks.generateVideo.mockRejectedValueOnce(
      new mocks.MediaProviderUnavailableError(
        'video',
        'nenhum provider de video com key configurada — configure em Settings → Mídia',
      ),
    );
    const video = buildMediaTools().find(
      (t) => t.name === 'nexus_video_generate',
    )!;
    const response = await video.handler({ prompt: 'test' }, fakeCtx());
    expect(response).toMatchObject({ ok: false, tierAlternatives: expect.any(Array) });
    expect((response as { error?: unknown }).error).toBeTruthy();
  });

  it('revisão #145: nexus_video_generate aceita pedido só com imagem (xai-video); sem nada, recusa', async () => {
    mocks.generateVideo.mockResolvedValueOnce({ ok: true, path: '/authorized/workspace/v.mp4' });
    const video = buildMediaTools().find((t) => t.name === 'nexus_video_generate')!;
    await video.handler({ provider: 'xai-video', imagePath: 'start.png' }, fakeCtx());
    expect(mocks.generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '', provider: 'xai-video', imagePath: 'start.png' }),
    );
    await expect(video.handler({ provider: 'xai-video' }, fakeCtx())).rejects.toThrow(
      'missing required argument: prompt',
    );
  });

  it('nexus_video_generate NÃO chama generateImage — sem fallback silencioso', async () => {
    mocks.generateVideo.mockRejectedValueOnce(
      new mocks.MediaProviderUnavailableError(
        'video',
        'nenhum provider de video com key configurada — configure em Settings → Mídia',
      ),
    );
    const video = buildMediaTools().find(
      (t) => t.name === 'nexus_video_generate',
    )!;
    await video.handler({ prompt: 'test' }, fakeCtx());
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it('nexus_image_generate retorna ok:false + tierAlternatives quando provider indisponível', async () => {
    mocks.generateImage.mockRejectedValueOnce(
      new mocks.MediaProviderUnavailableError(
        'image',
        'nenhum provider de image com key configurada — configure em Settings → Mídia',
      ),
    );
    const image = buildMediaTools().find(
      (t) => t.name === 'nexus_image_generate',
    )!;
    const response = await image.handler({ prompt: 'test' }, fakeCtx());
    expect(response).toMatchObject({ ok: false, tierAlternatives: expect.any(Array) });
  });

  it('erros não relacionados a provider ainda são relançados', async () => {
    mocks.generateVideo.mockRejectedValueOnce(new Error('network timeout'));
    const video = buildMediaTools().find(
      (t) => t.name === 'nexus_video_generate',
    )!;
    await expect(video.handler({ prompt: 'test' }, fakeCtx())).rejects.toThrow(
      'network timeout',
    );
  });
});

describe('F-1598: nexus_media_providers dá ao agente o que escolher', () => {
  const providersTool = () => buildMediaTools().find((t) => t.name === 'nexus_media_providers')!;

  interface ProvidersResponse {
    providers: Array<Record<string, unknown> & { id: string; kind: string; models: string[] }>;
    defaults: Record<string, unknown>;
    aliases: Record<string, string>;
  }

  async function listAt(iso: string): Promise<ProvidersResponse> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
    try {
      return (await providersTool().handler({}, fakeCtx())) as ProvidersResponse;
    } finally {
      vi.useRealTimers();
    }
  }

  beforeEach(() => {
    mocks.keyedProviders = ['openai-image', 'replicate-image', 'replicate-video', 'google-video'];
  });

  it('cada modelo de vídeo traz regras, preço e desligamento estruturados', async () => {
    const response = await listAt('2026-10-19T12:00:00Z');
    const google = response.providers.find((p) => p.id === 'google-video')!;
    expect(google).toMatchObject({ hasKey: true, defaultModel: 'gemini-omni-1.1-flash' });
    expect(google.videoModels).toMatchObject({
      'gemini-omni-1.1-flash': {
        durationsSeconds: null,
        resolutions: ['360p', '720p', '1080p', '4k'],
        aspectRatios: ['16:9', '9:16'],
        requiresImage: false,
        price: {
          unit: 'usd-per-second',
          default: 0.1,
          byResolution: { '360p': 0.03, '720p': 0.1, '1080p': 0.15, '4k': 0.3 },
          billedByTokensUsdPerMillion: { input: 1.5, textOutput: 9, videoOutput: 17.5 },
        },
        defaultRequestCostUsd: null,
        retiresOn: null,
        retired: false,
      },
      'veo-3.1-generate-preview': {
        durationsSeconds: [4, 6, 8],
        durationsByResolution: { '1080p': [8], '4k': [8] },
        retiresOn: '2026-10-22',
        retired: false,
        replacement: expect.stringContaining('gemini-omni-1.1-flash'),
      },
    });
    const replicate = response.providers.find((p) => p.id === 'replicate-video')!;
    expect(replicate.videoModels).toMatchObject({
      'bytedance/seedance-2.0': {
        durationsSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        defaultDurationSeconds: 5,
        defaultResolution: '720p',
        price: { unit: 'usd-per-second', default: 0.18 },
        defaultRequestCostUsd: 0.9,
      },
      'minimax/hailuo-2.3': {
        price: { unit: 'usd-per-video', byResolution: { '768p': { 6: 0.28, 10: 0.56 }, '1080p': { 6: 0.49 } } },
      },
      'wan-video/wan-2.5-i2v': { requiresImage: true, aspectRatios: [] },
    });
    for (const provider of response.providers.filter((p) => p.kind === 'video')) {
      expect(Object.keys(provider.videoModels as object)).toEqual(provider.models);
    }
  });

  it('o Veo preview aparece desligado a partir de 22/10/2026', async () => {
    const response = await listAt('2026-10-22T00:00:00Z');
    const google = response.providers.find((p) => p.id === 'google-video')!;
    expect((google.videoModels as Record<string, { retired: boolean }>)['veo-3.1-generate-preview'].retired).toBe(true);
    expect((google.videoModels as Record<string, { retired: boolean }>)['gemini-omni-1.1-flash'].retired).toBe(false);
  });

  it('imagem traz o preço por modelo; ninguém recebe a chave mascarada', async () => {
    const response = await listAt('2026-10-19T12:00:00Z');
    expect(response.providers.find((p) => p.id === 'replicate-image')).toMatchObject({
      imageCostUsd: { 'bytedance/seedream-5-pro': 0.04 },
    });
    for (const provider of response.providers) {
      expect(provider, provider.id).not.toHaveProperty('maskedKey');
      if (provider.kind !== 'video') expect(provider, provider.id).not.toHaveProperty('videoModels');
    }
    expect(JSON.stringify(response)).not.toContain('AIza');
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
  });

  it('defaults diz o que roda sem provider nem modelo (menor preço de lista)', async () => {
    const response = await listAt('2026-10-19T12:00:00Z');
    expect(response.defaults).toEqual({
      image: { provider: 'replicate-image', model: 'bytedance/seedream-5-pro', listCostUsd: 0.04 },
      video: { provider: 'replicate-video', model: 'bytedance/seedance-2.0', listCostUsd: 0.9 },
      audio: null,
    });
  });

  it('as descrições ensinam a escolher pelos campos, sem prometer qualidade', () => {
    const tools = buildMediaTools();
    const descriptionOf = (name: string) => tools.find((t) => t.name === name)!.description;
    expect(descriptionOf('nexus_media_providers')).toMatch(/videoModels/);
    expect(descriptionOf('nexus_media_providers')).toMatch(/not quality/);
    const video = descriptionOf('nexus_video_generate');
    expect(video).toMatch(/nexus_media_providers → videoModels/);
    expect(video).toMatch(/omit\s+durationSeconds/);
    expect(video).toMatch(/bills tokens/);
    expect(video).toMatch(/retire on 2026-10-22/);
    expect(descriptionOf('nexus_image_generate')).toMatch(/imageCostUsd/);
    for (const name of ['nexus_image_generate', 'nexus_video_generate']) {
      expect(descriptionOf(name), name).not.toMatch(/\b(best|highest quality|default\/cheap)\b/i);
    }
  });
});

function fakeCtx() {
  return {
    token: 'test',
    label: 'test',
    role: 'user' as const,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
    scope: testProjectScope({ rootRealPath: '/authorized/workspace' }),
  };
}
