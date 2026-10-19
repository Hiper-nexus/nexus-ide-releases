import { describe, expect, it, vi } from 'vitest';
import { effectPolicyForTool, isToolAllowedForReadOnlyContext } from '../mcp-effect-policy';

const mocks = vi.hoisted(() => ({
  render: vi.fn(async (..._args: unknown[]) => ({ ok: false, error: 'stub' })),
  doctor: vi.fn(async (..._args: unknown[]) => ({ ok: true, engine: { name: 'hyperframes', version: '0.8.177' }, checks: [], node: null })),
}));

vi.mock('electron', () => ({ app: { getPath: () => '/user-data', isPackaged: false, getAppPath: () => '/app' } }));
vi.mock('../workspace-path', () => ({ resolveCwdForScope: () => '/workspace' }));
vi.mock('../../path-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../path-resolver')>()),
  getEffectivePath: () => '/bin',
  lookupInPath: () => null,
}));
vi.mock('../../video/video-render', () => ({ renderVideo: mocks.render }));
vi.mock('../../video/video-doctor', () => ({ runVideoDoctor: mocks.doctor }));

import { buildVideoTools } from '../tools-video';

const ctx = { scope: { rootRealPath: '/workspace' }, role: 'worker', missionId: 'm1', sessionId: 's1' } as never;

function tool(name: string) {
  const found = buildVideoTools().find((item) => item.name === name);
  if (!found) throw new Error(name);
  return found;
}

describe('ferramentas de vídeo', () => {
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
});
