import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import type { AgentGateContext } from './gate';
import * as visualHandoff from './visual-handoff-gate';

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
  analyzeBrowserResponsive: vi.fn(async () => ({ paneId: 'browser-1', breakpoints: [] as unknown[] })),
  pressBrowserKey: vi.fn(async () => ({ paneId: 'browser-1' })),
  historyBrowserPane: vi.fn(async () => ({ paneId: 'browser-1', navigated: true })),
  selectBrowserOption: vi.fn(async () => ({ paneId: 'browser-1', selected: true })),
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
  analyzeBrowserResponsive: stubs.analyzeBrowserResponsive,
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
  pressBrowserKey: stubs.pressBrowserKey,
  hoverBrowserElement: vi.fn(),
  historyBrowserPane: stubs.historyBrowserPane,
  selectBrowserOption: stubs.selectBrowserOption,
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
// Keep the real invocation checkpoint while excluding unrelated protocol
// dispatch and prompt-assembly side effects from these handler tests.
vi.mock('./mcp-dispatch', () => ({ dispatchToolCall: vi.fn() }));
vi.mock('./operator-delegation-doctrine', () => ({ operatorDelegationInstructions: vi.fn() }));
vi.mock('./maestro-standing-context', () => ({ maestroStandingContext: vi.fn() }));
vi.mock('./operator-business-model', () => ({ operatorBusinessModelContext: vi.fn() }));
vi.mock('../context/business-model/business-model-ensure', () => ({ ensureBusinessModel: vi.fn() }));
vi.mock('./prompt-context-blocks', () => ({ joinPromptContextBlocks: vi.fn() }));
vi.mock('./operator-workspace-memory', () => ({ operatorWorkspaceMemoryContext: vi.fn() }));

import { buildBrowserTools } from './tools-browser';
import { authorizePaneRef } from './tool-util';

const scope: ProjectExecutionScope = {
  version: 1,
  installationId: 'installation-local',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest',
};

const context = { role: 'orchestrator', scope } as never;

describe('nexus_browser_extract MCP schema', () => {
  it('publishes a full JSON Schema for fields items, not a bare array', () => {
    const tool = buildBrowserTools().find(
      (item) => item.name === 'nexus_browser_extract',
    )!;
    const properties = tool.inputSchema.properties as Record<string, unknown>;
    const fields = properties.fields as {
      type: string;
      items?: { type: string; properties?: Record<string, unknown>; required?: string[] };
    };
    expect(fields.items).toBeDefined();
    expect(fields.items!.type).toBe('object');
    expect(fields.items!.required).toEqual(['name', 'type']);
    expect(fields.items!.properties).toHaveProperty('enum');
    expect(fields.items!.properties).toHaveProperty('hint');
    expect(fields.items!.properties).toHaveProperty('description');
  });
});

describe('nexus_browser_responsive', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires write authority on the pane and confirmation, like navigate', async () => {
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_browser_responsive')!;
    expect(tool.requiresConfirm).toBe(true);
    await tool.handler({ paneId: 'browser-1' }, context);
    expect(authorizePaneRef).toHaveBeenCalledWith(context, 'browser-1', 'write');
    expect(stubs.analyzeBrowserResponsive).toHaveBeenCalledWith(
      'browser-1',
      scope,
      expect.objectContaining({ devices: [] }),
    );
  });

  it('F-1326: never records a capture cut to the pane as visual evidence', async () => {
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_browser_responsive')!;
    const worker = { scope, role: 'worker', sessionId: 'worker-session', missionId: 'mission-a',
      visualTask: { since: 1000, id: 'capture-assignment' } } as AgentGateContext;
    const record = vi.spyOn(visualHandoff, 'recordVisualHandoffEvidence').mockReturnValue(true);
    stubs.analyzeBrowserResponsive.mockResolvedValueOnce({ paneId: 'browser-1', breakpoints: [
      { device: 'tablet', audit: {}, screenshot: { artifactId: 'cut', truncated: true } },
      { device: 'desktop', audit: {}, screenshot: { artifactId: 'whole' } },
    ] });
    try {
      await tool.handler({ paneId: 'browser-1' }, worker);
      expect(record.mock.calls.map((call) => call[1])).toEqual(['whole']);
    } finally { record.mockRestore(); }
  });

  it('never runs when the pane is not authorized', async () => {
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_browser_responsive')!;
    vi.mocked(authorizePaneRef).mockImplementationOnce(() => {
      throw new Error('not authorized');
    });
    await expect(tool.handler({ paneId: 'browser-9' }, context)).rejects.toThrow(/not authorized/);
    expect(stubs.analyzeBrowserResponsive).not.toHaveBeenCalled();
  });
});

describe('julgamento automático pós-ação (judge default-on)', () => {
  beforeEach(() => vi.clearAllMocks());

  const tool = (name: string) =>
    buildBrowserTools().find((item) => item.name === name)!;

  it('navigate judges by default and judge:false opts out', async () => {
    await tool('nexus_browser_navigate').handler(
      { paneId: 'browser-1', url: 'https://example.test/' },
      context,
    );
    expect(stubs.loadBrowser).toHaveBeenCalledWith(
      'browser-1',
      'https://example.test/',
      expect.objectContaining({ judge: true }),
    );
    await tool('nexus_browser_navigate').handler(
      { paneId: 'browser-1', url: 'https://example.test/', judge: false },
      context,
    );
    expect(stubs.loadBrowser).toHaveBeenLastCalledWith(
      'browser-1',
      'https://example.test/',
      expect.objectContaining({ judge: false }),
    );
  });

  it('click, fill and press judge by default; scroll and hover stay opt-in', async () => {
    const manager = await import('../browser/browser-manager');
    await tool('nexus_browser_click').handler({ paneId: 'browser-1', ref: 'e1' }, context);
    expect(vi.mocked(manager.clickBrowserElement)).toHaveBeenCalledWith(
      'browser-1',
      scope,
      'e1',
      expect.objectContaining({ judge: true }),
    );
    await tool('nexus_browser_fill').handler(
      { paneId: 'browser-1', ref: 'e1', text: 'x' },
      context,
    );
    expect(vi.mocked(manager.fillBrowserElement)).toHaveBeenCalledWith(
      'browser-1',
      scope,
      'e1',
      'x',
      expect.objectContaining({ judge: true }),
    );
    await tool('nexus_browser_press').handler({ paneId: 'browser-1', key: 'Enter' }, context);
    expect(stubs.pressBrowserKey).toHaveBeenCalledWith(
      'browser-1',
      scope,
      expect.objectContaining({ judge: true }),
    );
    await tool('nexus_browser_fill').handler(
      { paneId: 'browser-1', ref: 'e1', text: 'x', judge: false },
      context,
    );
    expect(vi.mocked(manager.fillBrowserElement)).toHaveBeenLastCalledWith(
      'browser-1',
      scope,
      'e1',
      'x',
      expect.objectContaining({ judge: false }),
    );
    await tool('nexus_browser_scroll').handler({ paneId: 'browser-1', dy: 100 }, context);
    expect(vi.mocked(manager.scrollBrowserPane)).toHaveBeenCalledWith(
      'browser-1',
      scope,
      expect.objectContaining({ judge: false }),
    );
    await tool('nexus_browser_hover').handler({ paneId: 'browser-1', ref: 'e1' }, context);
    expect(vi.mocked(manager.hoverBrowserElement)).toHaveBeenCalledWith(
      'browser-1',
      scope,
      'e1',
      expect.objectContaining({ judge: false }),
    );
  });
});

describe('nexus_browser_press', () => {
  beforeEach(() => vi.clearAllMocks());

  it('publishes bounded hold duration and forwards caller cancellation and authority', async () => {
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_browser_press')!;
    expect((tool.inputSchema.properties as Record<string, unknown>).holdMs)
      .toEqual({ type: 'integer', minimum: 0, maximum: 1000 });
    const signal = new AbortController().signal;
    const assertCurrentAuthority = vi.fn();
    await tool.handler({ paneId: 'browser-1', key: 'ArrowRight', holdMs: 500 }, context,
      { signal, assertCurrentAuthority });
    expect(authorizePaneRef).toHaveBeenCalledWith(context, 'browser-1', 'write');
    expect(stubs.pressBrowserKey).toHaveBeenCalledWith('browser-1', scope,
      expect.objectContaining({ key: 'ArrowRight', holdMs: 500, signal, assertCurrentAuthority }));
  });
});

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

  it('screenshot returns the image as MCP content and forwards fullPage/ref/theme', async () => {
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_browser_screenshot')!;
    stubs.captureBrowserScreenshot.mockResolvedValueOnce({
      path: '/runtime/shot.png', url: 'http://127.0.0.1:1234/',
      image: { data: 'aW1n', mimeType: 'image/png', width: 10, height: 5 },
    } as never);
    const result = await tool.handler({ paneId: 'browser-1', fullPage: true, theme: 'dark', ref: 'e3' }, context);
    expect(stubs.captureBrowserScreenshot).toHaveBeenLastCalledWith('browser-1', scope, undefined,
      expect.objectContaining({ fullPage: true, theme: 'dark', ref: 'e3', includeImage: true }));
    expect(result).toMatchObject({ path: '/runtime/shot.png', inlineImage: { width: 10, height: 5 } });
    expect(JSON.stringify(result)).not.toContain('aW1n');
    const symbols = Object.getOwnPropertySymbols(result as object);
    expect(symbols).toHaveLength(1);
  });

  it('select needs write authority and confirmation and passes the label target and the option', async () => {
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_browser_select')!;
    expect(tool.requiresConfirm).toBe(true);
    await tool.handler({ paneId: 'browser-1', label: 'Estado', option: 'São Paulo' }, context);
    expect(authorizePaneRef).toHaveBeenLastCalledWith(context, 'browser-1', 'write');
    expect(stubs.selectBrowserOption).toHaveBeenCalledWith('browser-1', scope, { text: 'Estado' },
      { option: 'São Paulo' }, expect.objectContaining({ judge: true }));
    await expect(tool.handler({ paneId: 'browser-1', ref: 'e1' }, context)).rejects.toThrow(/option, value or index/);
  });

  it('navigate walks the history (back/forward/reload) instead of a url', async () => {
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_browser_navigate')!;
    expect(tool.inputSchema.required).toEqual(['paneId']);
    await tool.handler({ paneId: 'browser-1', history: 'back' }, context);
    expect(authorizePaneRef).toHaveBeenLastCalledWith(context, 'browser-1', 'write');
    expect(stubs.historyBrowserPane).toHaveBeenCalledWith('browser-1', scope, 'back',
      expect.objectContaining({ judge: true }));
    expect(stubs.loadBrowser).not.toHaveBeenCalled();
    await expect(tool.handler({ paneId: 'browser-1' }, context)).rejects.toThrow(/url or history/);
  });

  it('opens with the same read/judge/device options as navigate', async () => {
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_browser_open')!;
    const properties = tool.inputSchema.properties as Record<string, unknown>;
    expect(properties).toHaveProperty('read');
    expect(properties).toHaveProperty('judge');
    expect(properties).toHaveProperty('device');

    await tool.handler({ url: 'https://example.com', read: { format: 'compact' }, device: 'mobile' }, context);
    expect(stubs.loadBrowser).toHaveBeenLastCalledWith('browser-1', 'https://example.com',
      expect.objectContaining({ read: { format: 'compact' }, judge: true, device: 'mobile', privateAccessConfirmed: false }));

    await tool.handler({ url: 'https://example.com', judge: false }, context);
    expect(stubs.loadBrowser).toHaveBeenLastCalledWith('browser-1', 'https://example.com',
      expect.objectContaining({ judge: false }));
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

  it('opens a new browser for a worker through its Main-owned caller context', async () => {
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_browser_open')!;
    const worker = {
      role: 'worker',
      scope,
      missionId: 'mission-a',
      sessionId: 'worker-session',
    } as never;

    await expect(
      tool.handler({ url: 'https://example.com' }, worker),
    ).resolves.toMatchObject({ ok: true, paneId: 'browser-1' });
    expect(stubs.requestBrowserPane).toHaveBeenCalledWith(expect.objectContaining({
      caller: worker, role: 'worker', scope,
    }));
    expect(stubs.loadBrowser).toHaveBeenCalledWith('browser-1', 'https://example.com',
      expect.objectContaining({ scope, privateAccessConfirmed: false }));
  });

  it('does not fall back to generic open when an internal review binding expired', async () => {
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_browser_open')!;
    const worker = { role: 'worker', scope, missionId: 'mission-a',
      internalPrevcReviewerAuthority: { kind: 'automated-review' } } as never;
    await expect(tool.handler({ paneId: 'browser-review', url: 'https://example.com' }, worker))
      .rejects.toThrow(/reviewer browser surface is not current/);
    expect(stubs.requestBrowserPane).not.toHaveBeenCalled();
    expect(stubs.loadBrowser).not.toHaveBeenCalled();
  });

  it('does not read an unrelated tab when an internal review binding expired', async () => {
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_browser_read')!;
    const worker = { role: 'worker', scope, missionId: 'mission-a',
      internalPrevcReviewerAuthority: { kind: 'automated-review' } } as never;
    await expect(tool.handler({ paneId: 'browser-other' }, worker))
      .rejects.toThrow(/reviewer browser surface is not current/);
    expect(stubs.readBrowserPage).not.toHaveBeenCalled();
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
        includeImage: true,
      },
    );
  });

  it('records capture provenance for the worker and refuses attribution after reassignment', async () => {
    const tool = buildBrowserTools().find(item => item.name === 'nexus_browser_screenshot')!;
    const worker = { scope, role: 'worker', sessionId: 'worker-session', missionId: 'mission-a',
      visualTask: { since: 1000, id: 'capture-assignment' } } as AgentGateContext;
    const record = vi.spyOn(visualHandoff, 'recordVisualHandoffEvidence').mockReturnValue(true);
    const image = { artifactId: 'browser-proof', path: '/runtime/shot.png', url: 'http://127.0.0.1:1234/' };
    stubs.captureBrowserScreenshot.mockResolvedValueOnce(image);
    try {
      await tool.handler({ paneId: 'browser-1' }, worker);
      expect(record).toHaveBeenCalledWith(worker, image.artifactId);
      record.mockClear();
      stubs.captureBrowserScreenshot.mockImplementationOnce(async () => {
        worker.visualTask = { since: 2000, id: 'next-assignment' };
        return image;
      });
      await tool.handler({ paneId: 'browser-1' }, worker);
      expect(record).not.toHaveBeenCalled();
    } finally { record.mockRestore(); }
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

describe('F-797: nexus_browser_open sem aba possível devolve erro acionável', () => {
  it('sem janela do Nexus para este pane: o erro aponta o curl e o registro no handoff', async () => {
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_browser_open')!;
    const worker = { role: 'worker', scope, missionId: 'mission-a', sessionId: 'worker-session' } as never;
    stubs.requestBrowserPane.mockResolvedValueOnce({
      requestId: '', ok: false, error: 'no renderer window available',
    } as never);
    await expect(tool.handler({ url: 'https://docs.example.com' }, worker)).rejects.toThrow(
      /no renderer window available — .*curl -sL <url>.*registre no handoff/,
    );
    expect(stubs.loadBrowser).not.toHaveBeenCalled();
  });

  it('projeto fora da tela: a mensagem original continua, com a dica do curl', async () => {
    const tool = buildBrowserTools().find((item) => item.name === 'nexus_browser_open')!;
    const worker = { role: 'worker', scope, missionId: 'mission-a', sessionId: 'worker-session' } as never;
    stubs.requestBrowserPane.mockResolvedValueOnce({
      requestId: '', ok: false,
      error: 'the Nexus window is showing another project right now, so a new browser pane cannot open',
    } as never);
    await expect(tool.handler({ url: 'https://docs.example.com' }, worker)).rejects.toThrow(
      /showing another project right now.*navegador do Nexus não está disponível.*curl -sL/,
    );
  });
});
