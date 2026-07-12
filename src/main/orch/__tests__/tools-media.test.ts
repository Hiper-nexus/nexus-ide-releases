import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMediaTools } from '../tools-media';
import { testProjectScope } from './scope-fixture';

const mocks = vi.hoisted(() => ({
  workspaceRoot: vi.fn(() => '/authorized/workspace'),
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
  generateAudio: vi.fn(),
  recordUsage: vi.fn(),
}));

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
      expect(tools.find((tool) => tool.name === name)?.requiresConfirm).toBe(true);
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
    expect(mocks.recordUsage).toHaveBeenCalledWith(result, fakeCtx());
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
