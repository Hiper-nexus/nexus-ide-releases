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
vi.mock('../../media/media-providers', () => ({
  listMediaProviders: () => [],
  MediaProviderUnavailableError: mocks.MediaProviderUnavailableError,
  computeMediaTierAlternatives: () => [],
}));
vi.mock('../../media/media-model-aliases', () => ({
  listMediaModelAliases: () => ({
    seedream: 'bytedance/seedream-5-pro',
    seedance: 'bytedance/seedance-2.0',
  }),
}));
vi.mock('../../media/media-keys', () => ({
  hasMediaKey: () => false,
  maskedMediaKey: () => null,
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

describe('teto de gasto de mídia nas ferramentas (F-1606)', () => {
  let dir: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.workspaceRoot.mockReturnValue('/authorized/workspace');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tools-media-budget-'));
  });

  async function withBudget(limits: { perDayUsd: number | null; perMissionUsd: number | null }, run: (budget: import('../../media/media-budget').MediaBudget) => Promise<void>) {
    const { MediaBudget, configureMediaBudget } = await import('../../media/media-budget');
    const budget = new MediaBudget(dir);
    budget.setLimits(limits);
    configureMediaBudget(budget);
    try {
      await run(budget);
    } finally {
      configureMediaBudget(null);
      (await import('node:fs')).rmSync(dir, { recursive: true, force: true });
    }
  }

  it('com teto ligado e custo que não dá para estimar, recusa sem chamar o provedor', async () => {
    await withBudget({ perDayUsd: 5, perMissionUsd: null }, async () => {
      const image = buildMediaTools().find((tool) => tool.name === 'nexus_image_generate')!;
      const refused = await image.handler({ prompt: 'logo' }, fakeCtx());
      expect(refused).toMatchObject({ ok: false, budget: { limit: 'unknown-cost' } });
      expect(mocks.generateImage).not.toHaveBeenCalled();
    });
  });

  it('falha do provedor devolve a reserva: nada fica contado', async () => {
    await withBudget({ perDayUsd: null, perMissionUsd: null }, async (budget) => {
      mocks.generateVideo.mockRejectedValue(new Error('HTTP 500'));
      const video = buildMediaTools().find((tool) => tool.name === 'nexus_video_generate')!;
      await expect(video.handler({ prompt: 'b-roll' }, fakeCtx())).rejects.toThrow('HTTP 500');
      expect(budget.spentToday()).toBe(0);
    });
  });
});
