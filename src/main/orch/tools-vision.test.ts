import { beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  read: vi.fn(),
  action: vi.fn(),
  selectWindow: vi.fn(),
  getScope: vi.fn(),
  focusedWindow: vi.fn(),
  allWindows: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: stubs.focusedWindow,
    getAllWindows: stubs.allWindows,
  },
}));

vi.mock('../persistence/renderer-workspace-scope', () => ({
  getRendererWorkspaceScope: stubs.getScope,
}));

vi.mock('../vision/ax-tree-reader', () => ({
  readNexusAxTree: stubs.read,
  summarizeAxTree: vi.fn(() => ({ text: 'button [ref=u1e1]: Start', nodeCount: 2, truncated: false })),
  performNexusAxAction: stubs.action,
  selectNexusWindow: stubs.selectWindow,
}));

import { buildVisionTools } from './tools-vision';

const scope = Object.freeze({
  installationId: 'installation-a',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/project-a',
});

function gateContext(scopeOverride = scope) {
  return { role: 'orchestrator', scope: scopeOverride } as never;
}

function nexusWindow(id = 7) {
  return {
    isDestroyed: () => false,
    webContents: {
      id,
      isDestroyed: () => false,
      isCrashed: () => false,
    },
  };
}

describe('Nexus UI MCP tools', () => {
  beforeEach(() => {
    for (const stub of Object.values(stubs)) stub.mockReset();
    stubs.focusedWindow.mockReturnValue(null);
    stubs.allWindows.mockReturnValue([]);
  });

  it('reads only from a healthy Nexus renderer bound to the exact MCP scope', async () => {
    const owner = nexusWindow();
    stubs.selectWindow.mockReturnValue(owner);
    stubs.getScope.mockReturnValue(scope);
    stubs.read.mockResolvedValue({ tag: 'body', role: null, aria: {}, text: null, children: [] });
    const tool = buildVisionTools().find((item) => item.name === 'nexus_ui_read')!;

    await expect(tool.handler({}, gateContext())).resolves.toMatchObject({
      surface: 'nexus-ui',
    });
    expect(stubs.read).toHaveBeenCalledWith(owner.webContents);
  });

  it.each(['other-project', 'unbound'])(
    'reads its project window when the focused window is %s',
    async (focusedState) => {
      const { selectNexusWindow } = await vi.importActual<typeof import('../vision/ax-tree-reader')>('../vision/ax-tree-reader');
      stubs.selectWindow.mockImplementation(selectNexusWindow);
      const owner = nexusWindow(7);
      const unrelated = nexusWindow(8);
      stubs.focusedWindow.mockReturnValue(unrelated);
      stubs.allWindows.mockReturnValue([owner, unrelated]);
      stubs.getScope.mockImplementation((contents) => contents.id === owner.webContents.id
        ? scope
        : focusedState === 'unbound' ? null : { ...scope, projectId: 'project-b' });
      stubs.read.mockResolvedValue({ tag: 'body', role: null, aria: {}, text: null, children: [] });
      const tool = buildVisionTools().find((item) => item.name === 'nexus_ui_read')!;

      await expect(tool.handler({}, gateContext())).resolves.toMatchObject({ surface: 'nexus-ui' });
      expect(stubs.read).toHaveBeenCalledWith(owner.webContents);
      expect(stubs.read).not.toHaveBeenCalledWith(unrelated.webContents);
    },
  );

  it.each([
    ['installationId', 'installation-b'],
    ['projectId', 'project-b'],
    ['checkoutId', 'checkout-b'],
    ['rootRealPath', '/workspace/project-b'],
  ] as const)(
    'fails closed when the renderer %s differs from the MCP authority',
    async (key, value) => {
      const owner = nexusWindow();
      stubs.selectWindow.mockReturnValue(owner);
      stubs.getScope.mockReturnValue({ ...scope, [key]: value });
      const tool = buildVisionTools().find((item) => item.name === 'nexus_ui_read')!;

      await expect(tool.handler({}, gateContext())).rejects.toThrow(/authorized project scope/i);
      expect(stubs.read).not.toHaveBeenCalled();
    },
  );

  it('fails closed when no healthy unambiguous Nexus renderer is available', async () => {
    stubs.selectWindow.mockReturnValue(null);
    const tool = buildVisionTools().find((item) => item.name === 'nexus_ui_read')!;

    await expect(tool.handler({}, gateContext())).rejects.toThrow(/authorized Nexus window/i);
    expect(stubs.getScope).not.toHaveBeenCalled();
    expect(stubs.read).not.toHaveBeenCalled();
  });

  it('fails closed when the selected renderer has no main-owned scope', async () => {
    stubs.selectWindow.mockReturnValue(nexusWindow());
    stubs.getScope.mockReturnValue(null);
    const tool = buildVisionTools().find((item) => item.name === 'nexus_ui_read')!;

    await expect(tool.handler({}, gateContext())).rejects.toThrow(/authorized project scope/i);
    expect(stubs.read).not.toHaveBeenCalled();
  });

  it('discards an AX read when the renderer scope changes in flight', async () => {
    const owner = nexusWindow();
    stubs.selectWindow.mockReturnValue(owner);
    stubs.getScope
      .mockReturnValueOnce(scope)
      .mockReturnValueOnce({ ...scope, projectId: 'project-b' });
    stubs.read.mockResolvedValue({ tag: 'body', role: null, aria: {}, text: 'Project B', children: [] });
    const tool = buildVisionTools().find((item) => item.name === 'nexus_ui_read')!;

    await expect(tool.handler({}, gateContext())).rejects.toThrow(/authorized project scope/i);
  });

  it('exposes a confirmed opaque-ref action tool', async () => {
    const owner = nexusWindow();
    stubs.selectWindow.mockReturnValue(owner);
    stubs.getScope.mockReturnValue(scope);
    stubs.action.mockResolvedValue({ ok: true, action: 'click', ref: 'u1e1' });
    const tool = buildVisionTools().find((item) => item.name === 'nexus_ui_action')!;

    expect(tool.requiresConfirm).toBe(true);
    expect(tool.description).toMatch(/read-then-act/i);
    await expect(
      tool.handler({ action: 'click', ref: 'u1e1' }, gateContext()),
    ).resolves.toMatchObject({ ok: true, action: 'click', ref: 'u1e1' });
    expect(stubs.action).toHaveBeenCalledWith(owner.webContents, {
      action: 'click',
      ref: 'u1e1',
    });
  });

  it('turns stale or refused renderer actions into MCP errors', async () => {
    stubs.selectWindow.mockReturnValue(nexusWindow());
    stubs.getScope.mockReturnValue(scope);
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
        gateContext(),
      ),
    ).rejects.toThrow(/stale_ref/);
  });

  it('rejects a renderer success payload that tries to return filled text', async () => {
    stubs.selectWindow.mockReturnValue(nexusWindow());
    stubs.getScope.mockReturnValue(scope);
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
        gateContext(),
      ),
    ).rejects.toThrow(/invalid action result/i);
  });
});
