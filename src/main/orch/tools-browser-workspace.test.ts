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
  requestPaneClose: vi.fn(async () => true),
  loadBrowser: vi.fn(async () => ({ url: 'https://example.com' })),
  readBrowserPage: vi.fn(async () => ({
    paneId: 'browser-1',
    url: 'http://127.0.0.1:1234/',
    bodyText: '',
  })),
  readBrowserPageCompact: vi.fn(async () => ({
    paneId: 'browser-1',
    url: 'http://127.0.0.1:1234/',
    outline: '',
  })),
  findBrowserElements: vi.fn(async () => ({
    paneId: 'browser-1',
    matches: [],
    total: 0,
  })),
  extractBrowserFields: vi.fn(async () => ({
    paneId: 'browser-1',
    url: 'http://127.0.0.1:1234/',
    title: '',
    fields: {},
    jev: { calls: 0 },
  })),
  inspectBrowserElement: vi.fn(async () => ({ paneId: 'browser-1', ref: 'r1' })),
  waitForBrowser: vi.fn(async () => ({
    paneId: 'browser-1',
    matched: true as const,
    condition: 'load' as const,
    elapsedMs: 1,
  })),
  captureBrowserScreenshot: vi.fn(async () => ({
    path: '/runtime/shot.png',
    url: 'http://127.0.0.1:1234/',
  })),
  assertBrowserAtExactUrl: vi.fn(),
  resolveReviewAuthority: vi.fn(() => null as {
    reviewSessionId: string;
    reviewerSessionId: string;
    surface: {
      paneId: string;
      previewId: string;
      url: string;
      missionId: string;
      scope: ProjectExecutionScope;
      executionScope: ProjectExecutionScope;
    };
  } | null),
  recordReviewInspection: vi.fn(),
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
  assertBrowserAtExactUrl: stubs.assertBrowserAtExactUrl,
  captureBrowserScreenshot: stubs.captureBrowserScreenshot,
  clickBrowserElement: vi.fn(),
  fillBrowserElement: vi.fn(),
  inspectBrowserElement: vi.fn(),
  loadBrowser: stubs.loadBrowser,
  readBrowserPage: stubs.readBrowserPage,
  readBrowserPageCompact: stubs.readBrowserPageCompact,
  findBrowserElements: stubs.findBrowserElements,
  extractBrowserFields: stubs.extractBrowserFields,
  waitForBrowser: stubs.waitForBrowser,
  scrollBrowserPane: vi.fn(),
  pressBrowserKey: vi.fn(),
  hoverBrowserElement: vi.fn(),
}));
vi.mock('../perf/perf-ipc', () => ({ collectPerfSnapshot: vi.fn() }));
vi.mock('./pane-registry', () => ({
  requestBrowserPane: stubs.requestBrowserPane,
  requestPaneClose: stubs.requestPaneClose,
}));
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
  strArray: () => [],
}));
vi.mock('./automated-review-browser-authority', () => ({
  resolveAutomatedReviewBrowserAuthority: stubs.resolveReviewAuthority,
  recordAutomatedReviewBrowserInspection: stubs.recordReviewInspection,
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
    stubs.requestPaneClose.mockResolvedValue(true);
    stubs.resolveReviewAuthority.mockReturnValue(null);
    stubs.readBrowserPage.mockResolvedValue({
      paneId: 'browser-1',
      url: 'http://127.0.0.1:1234/',
      bodyText: '',
    });
    stubs.captureBrowserScreenshot.mockResolvedValue({
      path: '/runtime/shot.png',
      url: 'http://127.0.0.1:1234/',
    });
  });

  it('serves only the canonical directory resolved inside the captured scope', async () => {
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_preview_start')!;
    await tool.handler({ dir: 'dist' }, context);
    expect(stubs.resolveCwdForScope).toHaveBeenCalledWith(scope, 'dist');
    expect(stubs.startPreview).toHaveBeenCalledWith(
      '/workspace/a/dist',
      scope,
      undefined,
    );
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
    expect(stubs.loadBrowser).toHaveBeenCalledWith(
      'browser-1',
      'https://example.com',
      expect.objectContaining({
        scope,
        privateAccessConfirmed: false,
      }),
    );
  });

  it('does not turn mission approval into silent localhost or private-network approval', async () => {
    stubs.loadBrowser.mockRejectedValueOnce(
      new Error('private-network navigation requires explicit user confirmation'),
    );
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_browser_open')!;

    await expect(
      tool.handler({ url: 'http://127.0.0.1:43111/' }, context),
    ).rejects.toThrow(/private-network/i);

    expect(stubs.loadBrowser).toHaveBeenCalledWith(
      'browser-1',
      'http://127.0.0.1:43111/',
      expect.objectContaining({ privateAccessConfirmed: false }),
    );
    expect(stubs.requestPaneClose).toHaveBeenCalledWith('browser-1');
  });

  it('navigates an owned pane without silently approving private targets', async () => {
    const tool = buildBrowserTools().find(
      (item) => item.name === 'nexus_browser_navigate',
    )!;

    await tool.handler(
      { paneId: 'browser-1', url: 'https://example.com/docs' },
      context,
    );

    expect(stubs.loadBrowser).toHaveBeenCalledWith(
      'browser-1',
      'https://example.com/docs',
      expect.objectContaining({
        scope,
        privateAccessConfirmed: false,
      }),
    );
  });

  it('never opens a new pane for a common worker', async () => {
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_browser_open')!;
    const worker = {
      role: 'worker',
      scope,
      missionId: 'mission-a',
    } as never;

    await expect(
      tool.handler(
        { paneId: 'browser-1', url: 'http://127.0.0.1:1234/' },
        worker,
      ),
    ).rejects.toThrow(/workers cannot open browser panes/i);
    expect(stubs.requestBrowserPane).not.toHaveBeenCalled();
    expect(stubs.loadBrowser).not.toHaveBeenCalled();
  });

  it('lets a verified reviewer reload only its already-bound local pane and URL', async () => {
    const url = 'http://127.0.0.1:1234/';
    const authority = {
      reviewSessionId: '11111111-1111-4111-8111-111111111111',
      reviewerSessionId: 'reviewer-session',
      surface: {
        paneId: 'browser-review',
        previewId: 'preview-review',
        url,
        missionId: 'mission-a',
        scope,
        executionScope: scope,
      },
    };
    stubs.resolveReviewAuthority.mockReturnValue(authority);
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_browser_open')!;
    const worker = {
      role: 'worker',
      scope,
      missionId: 'mission-a',
    } as never;

    await expect(
      tool.handler({ paneId: 'browser-review', url }, worker),
    ).resolves.toMatchObject({ ok: true, paneId: 'browser-review' });
    expect(stubs.requestBrowserPane).not.toHaveBeenCalled();
    expect(stubs.loadBrowser).toHaveBeenCalledWith(
      'browser-review',
      url,
      expect.objectContaining({
        scope,
        privateAccessConfirmed: false,
      }),
    );
    expect(stubs.recordReviewInspection).toHaveBeenCalledWith(
      authority,
      'open',
    );

    stubs.loadBrowser.mockClear();
    await expect(
      tool.handler(
        { paneId: 'browser-review', url: 'https://attacker.example/' },
        worker,
      ),
    ).rejects.toThrow(/differs from its bound local preview/i);
    expect(stubs.loadBrowser).not.toHaveBeenCalled();
  });

  it('does not count a browser read whose document URL diverged from the bound preview', async () => {
    const url = 'http://127.0.0.1:1234/';
    const authority = {
      reviewSessionId: '11111111-1111-4111-8111-111111111111',
      reviewerSessionId: 'reviewer-session',
      surface: {
        paneId: 'browser-review',
        previewId: 'preview-review',
        url,
        missionId: 'mission-a',
        scope,
        executionScope: scope,
      },
    };
    stubs.resolveReviewAuthority.mockReturnValue(authority);
    stubs.readBrowserPage.mockResolvedValueOnce({
      paneId: 'browser-review',
      url: 'https://attacker.example/',
      bodyText: 'not the candidate render',
    });
    const tool = buildBrowserTools().find(
      (item) => item.name === 'nexus_browser_read',
    )!;

    await expect(
      tool.handler(
        { paneId: 'browser-review' },
        {
          role: 'worker',
          scope,
          missionId: 'mission-a',
        } as never,
      ),
    ).rejects.toThrow(/read came from another URL/i);
    expect(stubs.recordReviewInspection).not.toHaveBeenCalled();
  });

  it('records find and extract inspections for a verified reviewer', async () => {
    const url = 'http://127.0.0.1:1234/';
    const authority = {
      reviewSessionId: '11111111-1111-4111-8111-111111111111',
      reviewerSessionId: 'reviewer-session',
      surface: {
        paneId: 'browser-review',
        previewId: 'preview-review',
        url,
        missionId: 'mission-a',
        scope,
        executionScope: scope,
      },
    };
    stubs.resolveReviewAuthority.mockReturnValue(authority);
    const worker = {
      role: 'worker',
      scope,
      missionId: 'mission-a',
    } as never;

    const find = buildBrowserTools().find(
      (item) => item.name === 'nexus_browser_find',
    )!;
    await expect(
      find.handler({ paneId: 'browser-review', text: 'ok' }, worker),
    ).resolves.toMatchObject({ paneId: 'browser-1' });
    expect(stubs.recordReviewInspection).toHaveBeenCalledWith(
      authority,
      'find',
    );

    const extract = buildBrowserTools().find(
      (item) => item.name === 'nexus_browser_extract',
    )!;
    await expect(
      extract.handler(
        {
          paneId: 'browser-review',
          fields: [{ name: 'total', type: 'number' }],
        },
        worker,
      ),
    ).resolves.toMatchObject({ paneId: 'browser-1' });
    expect(stubs.recordReviewInspection).toHaveBeenCalledWith(
      authority,
      'extract',
    );
  });

  it('does not count an extract whose page URL diverged from the bound preview', async () => {
    const url = 'http://127.0.0.1:1234/';
    const authority = {
      reviewSessionId: '11111111-1111-4111-8111-111111111111',
      reviewerSessionId: 'reviewer-session',
      surface: {
        paneId: 'browser-review',
        previewId: 'preview-review',
        url,
        missionId: 'mission-a',
        scope,
        executionScope: scope,
      },
    };
    stubs.resolveReviewAuthority.mockReturnValue(authority);
    stubs.extractBrowserFields.mockResolvedValueOnce({
      paneId: 'browser-review',
      url: 'https://attacker.example/',
      title: '',
      fields: {},
      jev: { calls: 0 },
    });
    const tool = buildBrowserTools().find(
      (item) => item.name === 'nexus_browser_extract',
    )!;

    await expect(
      tool.handler(
        {
          paneId: 'browser-review',
          fields: [{ name: 'total', type: 'number' }],
        },
        {
          role: 'worker',
          scope,
          missionId: 'mission-a',
        } as never,
      ),
    ).rejects.toThrow(/extract came from another URL/i);
    expect(stubs.recordReviewInspection).not.toHaveBeenCalled();
  });

  it('closes a newly created blank pane when caller authority expires before navigation', async () => {
    let resolvePane!: (value: { ok: true; paneId: string }) => void;
    stubs.requestBrowserPane.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePane = resolve;
      }),
    );
    let current = true;
    const tool = buildBrowserTools().find(
      (item) => item.name === 'nexus_browser_open',
    )!;
    const pending = tool.handler(
      { url: 'https://example.com' },
      context,
      {
        assertCurrentAuthority: () => {
          if (!current) throw new Error('session_authority_revoked');
        },
      },
    );
    current = false;
    resolvePane({ ok: true, paneId: 'browser-revoked' });

    await expect(pending).rejects.toThrow('session_authority_revoked');
    expect(stubs.loadBrowser).not.toHaveBeenCalled();
    expect(stubs.requestPaneClose).toHaveBeenCalledWith('browser-revoked');
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
      {
        signal: undefined,
        assertCurrentAuthority: undefined,
      },
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
