import { describe, expect, it, vi } from 'vitest';
import { judgeBrowserVisual, type BrowserVisualDeps } from './browser-visual-judgment';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { BrowserVisualRefusal } from './browser-visual-refusal';

const scope = testProjectScope({ rootRealPath: '/tmp/visual-test' });
function fixture(): BrowserVisualDeps {
  return { available: () => true, configurationKey: () => 'epoch-1', capture: vi.fn(async () => ({
    image: { content_type: 'image/png' as const, base64: 'synthetic-masked-image' }, assertCurrent: vi.fn(),
  })), judge: vi.fn(async () => ({ model: 'clef', answers: Object.fromEntries(
    ['visibleError', 'goalAchieved', 'loading', 'humanBlocker', 'layoutProblem'].map(id => [id, { type: 'noul' as const, noul: 0.8 }])),
    usage: { input_tokens: 10, output_tokens: 0 } })), record: vi.fn() };
}
describe('scoped visual judgments', () => {
  it('performs no capture or inference when vision, mode or credentials disallow it', async () => {
    const deps = fixture(); deps.available = () => false;
    expect(await judgeBrowserVisual({ paneId: 'pane', goal: 'Verify success', scope }, deps)).toMatchObject({ status: 'unavailable' });
    expect(deps.capture).not.toHaveBeenCalled(); expect(deps.judge).not.toHaveBeenCalled();
  });
  it('fails closed on scope mismatch and sends only masked embedded bytes', async () => {
    const deps = fixture();
    await judgeBrowserVisual({ paneId: 'pane', goal: 'Verify success', scope }, deps);
    expect(deps.capture).toHaveBeenCalledWith('pane', scope, expect.any(Object));
    expect(deps.judge).toHaveBeenCalledWith(expect.objectContaining({ images: [{ content_type: 'image/png', base64: 'synthetic-masked-image' }] }));
    deps.capture = vi.fn(async () => { throw new Error('scope mismatch'); });
    vi.mocked(deps.judge).mockClear();
    expect(await judgeBrowserVisual({ paneId: 'alien', goal: 'Verify success', scope }, deps)).toMatchObject({ status: 'unavailable' });
    expect(deps.judge).not.toHaveBeenCalled();
  });
  it('explains a categorical refusal to the agent without calling any model', async () => {
    for (const code of ['personal_profile', 'mostly_masked', 'unverifiable_geometry'] as const) {
      const deps = fixture();
      deps.capture = vi.fn(async () => { throw new BrowserVisualRefusal(code); });
      const result = await judgeBrowserVisual({ paneId: 'pane', goal: 'Verify success', scope }, deps);
      expect(result).toMatchObject({ status: 'unavailable', reason: code, message: expect.stringContaining('nada foi') });
      expect(deps.judge).not.toHaveBeenCalled(); expect(deps.record).not.toHaveBeenCalled();
    }
    const deps = fixture(); deps.capture = vi.fn(async () => { throw new Error('private page detail'); });
    const generic = await judgeBrowserVisual({ paneId: 'pane', goal: 'Verify success', scope }, deps);
    expect(generic).toEqual({ status: 'unavailable' });
  });
  it('stops egress after navigation, configuration change or abort and discards stale answers', async () => {
    for (const cause of ['navigation', 'configuration', 'abort']) {
      const deps = fixture(); const controller = new AbortController(); let key = 'epoch-1';
      deps.configurationKey = () => key;
      deps.capture = vi.fn(async () => {
        if (cause === 'configuration') key = 'epoch-2';
        if (cause === 'abort') controller.abort();
        return { image: { content_type: 'image/png' as const, base64: 'masked' },
          assertCurrent: () => { if (cause === 'navigation') throw new Error('stale'); } };
      });
      expect(await judgeBrowserVisual({ paneId: 'pane', goal: 'Verify success', scope, signal: controller.signal }, deps)).toMatchObject({ status: 'unavailable' });
      expect(deps.judge).not.toHaveBeenCalled();
    }
    const deps = fixture(); const assertCurrent = vi.fn();
    deps.capture = vi.fn(async () => ({ image: { content_type: 'image/png' as const, base64: 'masked' }, assertCurrent }));
    const originalJudge = deps.judge;
    deps.judge = async input => { const result = await originalJudge(input); assertCurrent.mockImplementation(() => { throw new Error('disposed'); }); return result; };
    expect(await judgeBrowserVisual({ paneId: 'pane', goal: 'Verify success', scope }, deps)).toMatchObject({ status: 'unavailable' });
    expect(deps.record).not.toHaveBeenCalled();
  });
});
