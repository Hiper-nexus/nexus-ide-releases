import { describe, expect, it, vi } from 'vitest';
import { effectPolicyForTool, isToolAllowedForReadOnlyContext } from '../mcp-effect-policy';

const mocks = vi.hoisted(() => ({
  render: vi.fn(async (..._args: unknown[]) => ({ ok: false, error: 'stub' })),
  exportVideo: vi.fn(async (request: { preset: string }) => ({ ok: true, files: { video: `${request.preset}.mp4` } })),
  doctor: vi.fn(async (..._args: unknown[]) => ({ ok: true, engine: { name: 'hyperframes', version: '0.8.177' }, checks: [], node: null })),
}));

vi.mock('electron', () => ({ app: { getPath: () => '/user-data', isPackaged: false, getAppPath: () => '/app' } }));
vi.mock('../workspace-path', () => ({ resolveCwdForScope: () => '/workspace' }));
vi.mock('../../path-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../path-resolver')>()),
  getEffectivePath: () => '/bin',
  lookupInPath: () => null,
}));
vi.mock('../../video/video-render', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../video/video-render')>()),
  renderVideo: mocks.render,
}));
vi.mock('../../video/video-export', () => ({ exportVideo: mocks.exportVideo }));
vi.mock('../../video/video-doctor', () => ({ runVideoDoctor: mocks.doctor }));

import { buildVideoTools } from '../tools-video';
import { buildVoiceTools } from '../tools-voice';
import { FEATURE_FLAG_IDS } from '../../../shared/feature-flags';
import { getFeatureFlagRegistry, resetFeatureFlagRegistryForTests } from '../../feature-flags/feature-flag-registry';

const ctx = { scope: { rootRealPath: '/workspace' }, role: 'worker', missionId: 'm1', sessionId: 's1' } as never;

function tool(name: string) {
  const found = buildVideoTools().find((item) => item.name === name);
  if (!found) throw new Error(name);
  return found;
}

describe('ferramentas de vídeo', () => {
  it('voz, música e vídeo só aparecem com o estúdio ligado (F-1600)', () => {
    resetFeatureFlagRegistryForTests();
    try {
      const tools = [...buildVoiceTools(), ...buildVideoTools()];
      expect(tools.map((item) => item.name).sort()).toEqual([
        'nexus_music_generate',
        'nexus_video_capture',
        'nexus_video_doctor',
        'nexus_video_export',
        'nexus_video_preview_start',
        'nexus_video_preview_stop',
        'nexus_video_render',
        'nexus_voice_list',
        'nexus_voiceover_align',
        'nexus_voiceover_generate',
      ]);
      for (const item of tools) {
        expect(item.available?.(), item.name).toBe(false);
        expect(item.unavailableReason, item.name).toMatch(/Ajustes → Experimental/u);
      }
      getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.mediaVideoStudio, true);
      for (const item of tools) expect(item.available?.(), item.name).toBe(true);
    } finally {
      resetFeatureFlagRegistryForTests();
    }
  });

  it('diagnóstico é leitura; render é efeito de execução com confirmação', () => {
    expect(effectPolicyForTool('nexus_video_doctor')).toBe('read-only');
    expect(isToolAllowedForReadOnlyContext('nexus_video_doctor')).toBe(true);
    expect(effectPolicyForTool('nexus_video_render')).toBe('execution-effect');
    expect(isToolAllowedForReadOnlyContext('nexus_video_render')).toBe(false);
    expect(tool('nexus_video_render').requiresConfirm).toBe(true);
  });

  it('o render recebe o workspace, a missão e a sessão do chamador, nunca do argumento', async () => {
    await tool('nexus_video_render').handler({ projectDir: 'promo', quality: 'draft', missionId: 'outra' }, ctx);
    const [request, deps] = mocks.render.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(request).toMatchObject({ projectDir: 'promo', quality: 'draft', baseDir: '/workspace', missionId: 'm1', sessionId: 's1' });
    expect(deps).toMatchObject({ userData: '/user-data', pathValue: '/bin' });
  });

  it('o diagnóstico devolve o relatório sem o caminho do Node interno', async () => {
    const report = await tool('nexus_video_doctor').handler({}, ctx);
    expect(report).toEqual({ ok: true, engine: { name: 'hyperframes', version: '0.8.177' }, checks: [] });
    expect(mocks.doctor.mock.calls[0][0]).toMatchObject({ workspaceDir: '/workspace', userData: '/user-data' });
  });

  it('render repassa composição, variáveis e variantes; export aceita a lista de redes (F-1605)', async () => {
    mocks.render.mockClear();
    await tool('nexus_video_render').handler(
      {
        projectDir: 'promo',
        variants: [{ name: 'vertical-pt', variables: { lang: 'pt' } }, { name: 'wide-pt', composition: 'compositions/wide.html' }],
      },
      ctx,
    );
    expect(mocks.render.mock.calls[0][0]).toMatchObject({
      variants: [{ name: 'vertical-pt', variables: { lang: 'pt' } }, { name: 'wide-pt', composition: 'compositions/wide.html' }],
    });
    await expect(tool('nexus_video_render').handler({ projectDir: 'promo', variants: 'x' }, ctx)).rejects.toThrow(/lista/u);
    await expect(tool('nexus_video_render').handler({ projectDir: 'promo', variables: [1] }, ctx)).rejects.toThrow(/objeto/u);

    const many = (await tool('nexus_video_export').handler(
      { input: 'promo/renders/a.mp4', presets: ['vertical-9x16', 'youtube-16x9', 'vertical-9x16'] },
      ctx,
    )) as { ok: boolean; exports: Array<{ preset: string }> };
    expect(many.ok).toBe(true);
    expect(many.exports.map((item) => item.preset)).toEqual(['vertical-9x16', 'youtube-16x9']);
    const single = await tool('nexus_video_export').handler({ input: 'promo/renders/a.mp4', preset: 'square-1x1' }, ctx);
    expect(single).toEqual({ ok: true, files: { video: 'square-1x1.mp4' } });
    await expect(tool('nexus_video_export').handler({ input: 'a.mp4', presets: ['tiktok'] }, ctx)).rejects.toThrow(/desconhecido/u);
    await expect(tool('nexus_video_export').handler({ input: 'a.mp4' }, ctx)).rejects.toThrow(/preset ou presets/u);
  });
});
