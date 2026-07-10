import { beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  resolveWorkspaceCwd: vi.fn<(value?: string) => string>(),
  startPreview: vi.fn(async () => ({ url: 'http://127.0.0.1:1234/', port: 1234 })),
}));

vi.mock('./workspace-path', () => ({ resolveWorkspaceCwd: stubs.resolveWorkspaceCwd }));
vi.mock('./preview-server', () => ({
  startPreview: stubs.startPreview,
  stopPreview: vi.fn(),
  listPreviews: vi.fn(() => []),
}));
vi.mock('../browser/browser-manager', () => ({
  captureBrowserScreenshot: vi.fn(),
  clickBrowserElement: vi.fn(),
  fillBrowserElement: vi.fn(),
  inspectBrowserElement: vi.fn(),
  loadBrowser: vi.fn(),
  readBrowserPage: vi.fn(),
  waitForBrowser: vi.fn(),
}));
vi.mock('../perf/perf-ipc', () => ({ collectPerfSnapshot: vi.fn() }));
vi.mock('./pane-registry', () => ({ requestBrowserPane: vi.fn() }));
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

describe('preview tool workspace confinement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubs.resolveWorkspaceCwd.mockReturnValue('/workspace/dist');
  });

  it('serves only the canonical directory resolved inside the active workspace', async () => {
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_preview_start')!;
    await tool.handler({ dir: 'dist' }, { role: 'orchestrator' } as never);
    expect(stubs.resolveWorkspaceCwd).toHaveBeenCalledWith('dist');
    expect(stubs.startPreview).toHaveBeenCalledWith('/workspace/dist');
  });

  it('never starts a preview when the directory escapes the workspace', async () => {
    stubs.resolveWorkspaceCwd.mockImplementation(() => {
      throw new Error('cwd escapes workspace');
    });
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_preview_start')!;
    await expect(
      tool.handler({ dir: '/Users/example' }, { role: 'orchestrator' } as never),
    ).rejects.toThrow(/escapes workspace/);
    expect(stubs.startPreview).not.toHaveBeenCalled();
  });
});
