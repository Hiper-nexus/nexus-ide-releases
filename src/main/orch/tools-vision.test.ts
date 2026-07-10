import { beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  read: vi.fn(),
  action: vi.fn(),
}));

vi.mock('../vision/ax-tree-reader', () => ({
  readFocusedNexusAxTree: stubs.read,
  summarizeAxTree: vi.fn(() => ({ text: 'button [ref=u1e1]: Start', nodeCount: 2, truncated: false })),
  performFocusedNexusAxAction: stubs.action,
}));

import { buildVisionTools } from './tools-vision';

describe('Nexus UI MCP tools', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes a confirmed opaque-ref action tool', async () => {
    stubs.action.mockResolvedValue({ ok: true, action: 'click', ref: 'u1e1' });
    const tool = buildVisionTools().find((item) => item.name === 'nexus_ui_action')!;

    expect(tool.requiresConfirm).toBe(true);
    expect(tool.description).toMatch(/read-then-act/i);
    await expect(
      tool.handler({ action: 'click', ref: 'u1e1' }, { role: 'orchestrator' } as never),
    ).resolves.toMatchObject({ ok: true, action: 'click', ref: 'u1e1' });
  });

  it('turns stale or refused renderer actions into MCP errors', async () => {
    stubs.action.mockResolvedValue({
      ok: false,
      action: 'fill',
      ref: 'u1e1',
      error: 'stale_ref',
    });
    const tool = buildVisionTools().find((item) => item.name === 'nexus_ui_action')!;

    await expect(
      tool.handler(
        { action: 'fill', ref: 'u1e1', text: 'hidden from audit' },
        { role: 'orchestrator' } as never,
      ),
    ).rejects.toThrow(/stale_ref/);
  });

  it('rejects a renderer success payload that tries to return filled text', async () => {
    stubs.action.mockResolvedValue({
      ok: true,
      action: 'fill',
      ref: 'u1e1',
      text: 'must not cross the boundary',
    });
    const tool = buildVisionTools().find((item) => item.name === 'nexus_ui_action')!;

    await expect(
      tool.handler(
        { action: 'fill', ref: 'u1e1', text: 'private input' },
        { role: 'orchestrator' } as never,
      ),
    ).rejects.toThrow(/invalid action result/i);
  });
});
