import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';

const stubs = vi.hoisted(() => ({
  resolveCwdForScope:
    vi.fn<(_scope: ProjectExecutionScope, value?: string) => string>(),
  startPreview: vi.fn(async () => ({
    id: 'preview-opaque',
    url: 'http://127.0.0.1:1234/',
    port: 1234,
  })),
  stopPreview: vi.fn(() => true),
  listPreviews: vi.fn(
    (): Array<{ id: string; dir: string; url: string }> => [],
  ),
  requestBrowserPane: vi.fn(async () => ({ ok: true, paneId: 'browser-1' })),
  loadBrowser: vi.fn(async () => ({ url: 'https://example.com' })),
  captureBrowserScreenshot: vi.fn(async () => ({ path: '/runtime/shot.png' })),
}));

vi.mock('./workspace-path', () => ({
  isInsidePath: vi.fn(() => true),
  resolveCwdForScope: stubs.resolveCwdForScope,
}));
vi.mock('./preview-server', () => ({
  startPreview: stubs.startPreview,
  stopPreview: stubs.stopPreview,
  listPreviews: stubs.listPreviews,
}));
vi.mock('../browser/browser-manager', () => ({
  captureBrowserScreenshot: stubs.captureBrowserScreenshot,
  clickBrowserElement: vi.fn(),
  fillBrowserElement: vi.fn(),
  inspectBrowserElement: vi.fn(),
  loadBrowser: stubs.loadBrowser,
  readBrowserPage: vi.fn(),
  waitForBrowser: vi.fn(),
}));
vi.mock('../perf/perf-ipc', () => ({ collectPerfSnapshot: vi.fn() }));
vi.mock('./pane-registry', () => ({ requestBrowserPane: stubs.requestBrowserPane }));
vi.mock('./tool-util', () => ({
  authorizePaneRef: vi.fn(),
  num: (args: Record<string, unknown>, key: string) =>
    typeof args[key] === 'number' ? args[key] : undefined,
  str: (args: Record<string, unknown>, key: string) =>
    typeof args[key] === 'string' ? args[key] : undefined,
  requireStr: (args: Record<string, unknown>, key: string) => {
    if (typeof args[key] !== 'string' || !args[key]) throw new Error(`missing ${key}`);
    return args[key] as string;
  },
}));

import { buildBrowserTools } from './tools-browser';

const scope: ProjectExecutionScope = {
  version: 1,
  installationId: 'installation-local',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest',
};

const context = { role: 'orchestrator', scope } as never;

describe('preview tool workspace confinement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubs.resolveCwdForScope.mockReturnValue('/workspace/a/dist');
    stubs.requestBrowserPane.mockResolvedValue({ ok: true, paneId: 'browser-1' });
  });

  it('serves only the canonical directory resolved inside the captured scope', async () => {
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_preview_start')!;
    await tool.handler({ dir: 'dist' }, context);
    expect(stubs.resolveCwdForScope).toHaveBeenCalledWith(scope, 'dist');
    expect(stubs.startPreview).toHaveBeenCalledWith('/workspace/a/dist', scope);
  });

  it('never starts a preview when the directory escapes the workspace', async () => {
    stubs.resolveCwdForScope.mockImplementation(() => {
      throw new Error('cwd escapes workspace');
    });
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_preview_start')!;
    await expect(
      tool.handler({ dir: '/Users/example' }, context),
    ).rejects.toThrow(/escapes workspace/);
    expect(stubs.startPreview).not.toHaveBeenCalled();
  });

  it('propagates the captured project scope when opening a browser pane', async () => {
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_browser_open')!;

    await tool.handler({ url: 'https://example.com' }, context);

    expect(stubs.requestBrowserPane).toHaveBeenCalledWith(
      expect.objectContaining({ scope }),
    );
  });

  it('binds screenshot artifacts to the caller project and mission', async () => {
    const tool = buildBrowserTools().find(
      (item) => item.name === 'nexus_browser_screenshot',
    )!;
    const missionContext = {
      role: 'orchestrator',
      scope,
      missionId: 'mission-a',
    } as never;
    await tool.handler({ paneId: 'browser-1' }, missionContext);

    expect(stubs.captureBrowserScreenshot).toHaveBeenCalledWith(
      'browser-1',
      scope,
      'mission-a',
    );
  });

  it('stops by opaque id and captured scope without resolving the deleted directory', async () => {
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_preview_stop')!;

    await expect(tool.handler({ id: 'preview-opaque' }, context)).resolves.toEqual({
      stopped: true,
    });

    expect(stubs.stopPreview).toHaveBeenCalledWith('preview-opaque', scope);
    expect(stubs.resolveCwdForScope).not.toHaveBeenCalled();
  });

  it('lists only previews bound to the captured project and checkout', async () => {
    stubs.listPreviews.mockReturnValue([
      { id: 'preview-opaque', dir: '/deleted/dist', url: 'http://127.0.0.1:1234/' },
    ]);
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_preview_stop')!;

    await expect(tool.handler({}, context)).resolves.toEqual({
      running: [
        {
          id: 'preview-opaque',
          dir: '/deleted/dist',
          url: 'http://127.0.0.1:1234/',
        },
      ],
    });

    expect(stubs.listPreviews).toHaveBeenCalledWith(scope);
    expect(stubs.resolveCwdForScope).not.toHaveBeenCalled();
  });
});
