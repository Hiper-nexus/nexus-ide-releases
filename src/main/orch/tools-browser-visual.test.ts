import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';
const h = vi.hoisted(() => ({ authorize: vi.fn(), judge: vi.fn(async () => ({ status: 'answered' })) }));
vi.mock('./tool-util', async original => ({ ...await original<object>(), authorizePaneRef: h.authorize }));
vi.mock('../browser/browser-visual-judgment', () => ({ judgeBrowserVisual: h.judge, canJudgeBrowserVisual: () => true }));
import { buildBrowserVisualTools } from './tools-browser-visual';
import { effectPolicyForTool } from './mcp-effect-policy';
const ctx = { scope: testProjectScope({ rootRealPath: '/tmp/tool-visual' }), sessionId: 'session' } as AgentGateContext;
describe('visual browser MCP authority', () => {
  beforeEach(() => vi.clearAllMocks());
  it('authorizes pane reads before inference and cannot accept arbitrary image paths', async () => {
    const tool = buildBrowserVisualTools()[0];
    await tool.handler({ paneId: 'pane', goal: 'Verify success' }, ctx);
    expect(h.authorize).toHaveBeenCalledWith(ctx, 'pane', 'read');
    expect(effectPolicyForTool(tool.name)).toBe('read-only');
    await expect(tool.handler({ paneId: 'pane', goal: 'Verify', imagePath: '/private/file' }, ctx)).rejects.toThrow();
    h.authorize.mockImplementationOnce(() => { throw new Error('wrong workspace'); });
    h.judge.mockClear();
    await expect(tool.handler({ paneId: 'alien', goal: 'Verify' }, ctx)).rejects.toThrow('wrong workspace');
    expect(h.judge).not.toHaveBeenCalled();
  });
});
