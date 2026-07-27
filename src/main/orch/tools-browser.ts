import {
  assertMcpInvocationCurrent,
  type McpToolDef,
} from './mcp-protocol';
import {
  assertBrowserAtExactUrl,
  captureBrowserScreenshot,
  clickBrowserElement,
  fillBrowserElement,
  hoverBrowserElement,
  inspectBrowserElement,
  loadBrowser,
  pressBrowserKey,
  readBrowserPage,
  scrollBrowserPane,
  waitForBrowser,
} from '../browser/browser-manager';
import { collectPerfSnapshot } from '../perf/perf-ipc';
import { listPreviews, startPreview, stopPreview } from './preview-server';
import { requestBrowserPane, requestPaneClose } from './pane-registry';
import { authorizePaneRef, num, requireStr, str, strArray } from './tool-util';
import { resolveCwdForScope } from './workspace-path';
import { executionScopeFor } from './gate';
import {
  recordAutomatedReviewBrowserInspection,
  resolveAutomatedReviewBrowserAuthority,
  type AutomatedReviewBrowserAuthority,
} from './automated-review-browser-authority';
import type { AgentGateContext } from './gate';
import type { PaneAction } from './pane-authz';

function authorizeBrowserPane(
  ctx: AgentGateContext,
  paneId: string,
  action: PaneAction,
): AutomatedReviewBrowserAuthority | null {
  const reviewAuthority = resolveAutomatedReviewBrowserAuthority(
    ctx,
    paneId,
    action,
  );
  if (reviewAuthority) return reviewAuthority;
  authorizePaneRef(ctx, paneId, action);
  return null;
}

function assertReviewSurfaceCurrent(
  ctx: AgentGateContext,
  authority: AutomatedReviewBrowserAuthority | null,
): void {
  if (!authority) return;
  assertBrowserAtExactUrl(
    authority.surface.paneId,
    ctx.scope,
    authority.surface.url,
  );
}

const previewStartTool: McpToolDef = {
  name: 'nexus_preview_start',
  description:
    'Serve a built static web app inside the active workspace on a Nexus-owned ' +
    '127.0.0.1 preview URL. Returns an opaque {id, url}; idempotent per project, ' +
    'checkout and canonical directory.',
  inputSchema: {
    type: 'object',
    properties: { dir: { type: 'string' } },
    required: ['dir'],
  },
  handler: async (args, ctx, invocation) => {
    const dir = requireStr(args, 'dir');
    const executionScope = executionScopeFor(ctx);
    const workspaceDir = resolveCwdForScope(executionScope, dir);
    try {
      return await startPreview(workspaceDir, executionScope, invocation);
    } catch (err) {
      throw new Error(
        `preview falhou para ${workspaceDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};

const previewStopTool: McpToolDef = {
  name: 'nexus_preview_stop',
  description:
    'Stop a project-scoped preview by its opaque id; omit id to list previews ' +
    'owned by the current project and checkout.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  handler: async (args, ctx) => {
    const id = str(args, 'id');
    if (id) {
      return { stopped: stopPreview(id, executionScopeFor(ctx)) };
    }
    return { running: listPreviews(executionScopeFor(ctx)) };
  },
};

const browserOpenTool: McpToolDef = {
  name: 'nexus_browser_open',
  requiresConfirm: true,
  description:
    'Open an embedded browser pane at a confirmed URL. Nexus preview URLs are ' +
    'the only private targets trusted automatically.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      title: { type: 'string' },
      paneId: {
        type: 'string',
        description:
          'Required only for a main-provisioned automated design-review pane.',
      },
    },
    required: ['url'],
  },
  handler: async (args, ctx, invocation) => {
    if (ctx.role === 'worker') {
      const paneId = requireStr(args, 'paneId');
      const reviewAuthority = resolveAutomatedReviewBrowserAuthority(
        ctx,
        paneId,
        'read',
      );
      if (!reviewAuthority) {
        throw new Error('not authorized: workers cannot open browser panes');
      }
      const url = requireStr(args, 'url');
      if (url !== reviewAuthority.surface.url) {
        throw new Error(
          'not authorized: automated reviewer URL differs from its bound local preview',
        );
      }
      assertMcpInvocationCurrent(invocation);
      const state = await loadBrowser(paneId, reviewAuthority.surface.url, {
        scope: ctx.scope,
        // This is already a process-minted preview. Never convert the review
        // capability into a generic localhost/private-network confirmation.
        privateAccessConfirmed: false,
        signal: invocation?.signal,
        assertCurrentAuthority: invocation?.assertCurrentAuthority,
      });
      assertMcpInvocationCurrent(invocation);
      assertReviewSurfaceCurrent(ctx, reviewAuthority);
      recordAutomatedReviewBrowserInspection(reviewAuthority, 'open');
      return { ok: true, paneId, state };
    }
    const url = requireStr(args, 'url');
    const result = await requestBrowserPane({
      // Main loads the confirmed URL only after the pane id exists so a
      // private-network grant is scoped to this exact pane and host+port.
      url: 'about:blank',
      title: str(args, 'title'),
      missionId: ctx.missionId,
      agentName: ctx.agentName ?? ctx.label,
      ...(ctx.role === 'orchestrator' ? { role: 'orchestrator' as const } : {}),
      scope: ctx.scope,
    });
    if (!result.ok || !result.paneId) {
      throw new Error(result.error ?? 'browser open failed');
    }
    try {
      assertMcpInvocationCurrent(invocation);
      const state = await loadBrowser(result.paneId, url, {
        scope: ctx.scope,
        privateAccessConfirmed: true,
        signal: invocation?.signal,
        assertCurrentAuthority: invocation?.assertCurrentAuthority,
      });
      assertMcpInvocationCurrent(invocation);
      return { ok: true, paneId: result.paneId, state };
    } catch (error) {
      const closed = await requestPaneClose(result.paneId);
      if (!closed) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; ` +
          `browser pane ${result.paneId} could not be closed after authority loss`,
        );
      }
      throw error;
    }
  },
};

const browserNavigateTool: McpToolDef = {
  name: 'nexus_browser_navigate',
  requiresConfirm: true,
  description:
    'Navigate an owned browser pane to a confirmed URL. Redirects and DNS are ' +
    'revalidated independently.',
  inputSchema: {
    type: 'object',
    properties: { paneId: { type: 'string' }, url: { type: 'string' } },
    required: ['paneId', 'url'],
  },
  handler: async (args, ctx, invocation) => {
    const paneId = requireStr(args, 'paneId');
    authorizePaneRef(ctx, paneId, 'write');
    return loadBrowser(paneId, requireStr(args, 'url'), {
      scope: ctx.scope,
      privateAccessConfirmed: true,
      signal: invocation?.signal,
      assertCurrentAuthority: invocation?.assertCurrentAuthority,
    });
  },
};

const browserScreenshotTool: McpToolDef = {
  name: 'nexus_browser_screenshot',
  description: 'Capture an owned browser pane as a PNG with redacted URL metadata.',
  inputSchema: {
    type: 'object',
    properties: { paneId: { type: 'string' } },
    required: ['paneId'],
  },
  handler: async (args, ctx, invocation) => {
    const paneId = requireStr(args, 'paneId');
    const reviewAuthority = authorizeBrowserPane(ctx, paneId, 'read');
    assertReviewSurfaceCurrent(ctx, reviewAuthority);
    const result = await captureBrowserScreenshot(
      paneId,
      ctx.scope,
      ctx.missionId,
      {
        signal: invocation?.signal,
        assertCurrentAuthority: invocation?.assertCurrentAuthority,
      },
    );
    if (reviewAuthority) {
      assertReviewSurfaceCurrent(ctx, reviewAuthority);
      if (result.url !== reviewAuthority.surface.url) {
        throw new Error(
          'automated design-review screenshot came from another URL',
        );
      }
      recordAutomatedReviewBrowserInspection(reviewAuthority, 'screenshot');
    }
    return result;
  },
};

const browserReadTool: McpToolDef = {
  name: 'nexus_browser_read',
  description:
    'Read bounded visible page text and accessible interactive elements. ' +
    'Returns opaque refs for click/fill/inspect; never input values or storage.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      maxChars: { type: 'number', description: 'Visible text cap; max 20000' },
      maxElements: { type: 'number', description: 'Element cap; max 200' },
    },
    required: ['paneId'],
  },
  handler: async (args, ctx) => {
    const paneId = requireStr(args, 'paneId');
    const reviewAuthority = authorizeBrowserPane(ctx, paneId, 'read');
    assertReviewSurfaceCurrent(ctx, reviewAuthority);
    const result = await readBrowserPage(paneId, ctx.scope, {
      maxChars: num(args, 'maxChars'),
      maxElements: num(args, 'maxElements'),
    });
    if (reviewAuthority) {
      assertReviewSurfaceCurrent(ctx, reviewAuthority);
      if (result.url !== reviewAuthority.surface.url) {
        throw new Error('automated design-review read came from another URL');
      }
      recordAutomatedReviewBrowserInspection(reviewAuthority, 'read');
    }
    return result;
  },
};

const browserInspectTool: McpToolDef = {
  name: 'nexus_browser_inspect',
  description:
    'Inspect one opaque element ref without reading its value or browser storage.',
  inputSchema: {
    type: 'object',
    properties: { paneId: { type: 'string' }, ref: { type: 'string' } },
    required: ['paneId', 'ref'],
  },
  handler: async (args, ctx) => {
    const paneId = requireStr(args, 'paneId');
    const reviewAuthority = authorizeBrowserPane(ctx, paneId, 'read');
    assertReviewSurfaceCurrent(ctx, reviewAuthority);
    const result = await inspectBrowserElement(
      paneId,
      ctx.scope,
      requireStr(args, 'ref'),
    );
    if (reviewAuthority) {
      assertReviewSurfaceCurrent(ctx, reviewAuthority);
      recordAutomatedReviewBrowserInspection(reviewAuthority, 'inspect');
    }
    return result;
  },
};

const browserClickTool: McpToolDef = {
  name: 'nexus_browser_click',
  requiresConfirm: true,
  description:
    'Click a visible opaque ref from browser_read. CSS selectors and JavaScript ' +
    'are not accepted; the click requires user confirmation.',
  inputSchema: {
    type: 'object',
    properties: { paneId: { type: 'string' }, ref: { type: 'string' } },
    required: ['paneId', 'ref'],
  },
  handler: async (args, ctx) => {
    const paneId = requireStr(args, 'paneId');
    authorizePaneRef(ctx, paneId, 'write');
    return clickBrowserElement(paneId, ctx.scope, requireStr(args, 'ref'));
  },
};

const browserFillTool: McpToolDef = {
  name: 'nexus_browser_fill',
  requiresConfirm: true,
  description:
    'Fill or clear a visible text field by opaque ref. Password, payment, ' +
    'token, file, hidden and other sensitive fields are refused.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      ref: { type: 'string' },
      text: { type: 'string' },
    },
    required: ['paneId', 'ref', 'text'],
  },
  handler: async (args, ctx) => {
    const paneId = requireStr(args, 'paneId');
    authorizePaneRef(ctx, paneId, 'write');
    if (typeof args.text !== 'string') throw new Error('missing required argument: text');
    return fillBrowserElement(
      paneId,
      ctx.scope,
      requireStr(args, 'ref'),
      args.text,
    );
  },
};

const browserWaitTool: McpToolDef = {
  name: 'nexus_browser_wait',
  description:
    'Wait up to 15 seconds for load, visible text, or a previously read ref. ' +
    'No page-provided or model-provided code is executed.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      condition: { type: 'string', enum: ['load', 'text', 'ref'] },
      value: { type: 'string' },
      ref: { type: 'string' },
      timeoutMs: { type: 'number' },
    },
    required: ['paneId', 'condition'],
  },
  handler: async (args, ctx) => {
    const paneId = requireStr(args, 'paneId');
    const reviewAuthority = authorizeBrowserPane(ctx, paneId, 'wait');
    assertReviewSurfaceCurrent(ctx, reviewAuthority);
    const condition = args.condition;
    if (condition !== 'load' && condition !== 'text' && condition !== 'ref') {
      throw new Error('invalid browser wait condition');
    }
    const result = await waitForBrowser(paneId, ctx.scope, {
      condition,
      value: str(args, 'value'),
      ref: str(args, 'ref'),
      timeoutMs: num(args, 'timeoutMs'),
    });
    if (reviewAuthority) {
      assertReviewSurfaceCurrent(ctx, reviewAuthority);
      recordAutomatedReviewBrowserInspection(reviewAuthority, 'wait');
    }
    return result;
  },
};

const perfSnapshotTool: McpToolDef = {
  name: 'nexus_perf_snapshot',
  description:
    'Return process memory, Electron metrics, live PTY count and browser view count.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => collectPerfSnapshot(),
};

const browserScrollTool: McpToolDef = {
  name: 'nexus_browser_scroll',
  description:
    'Scroll a browser pane. With `ref`, scrolls that element into view (centered). ' +
    'Without `ref`, scrolls the page: use `dx`/`dy` for relative offsets or ' +
    '`x`/`y` for absolute positions. `behavior` can be "auto" (default) or "smooth".',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      ref: { type: 'string' },
      dx: { type: 'number' },
      dy: { type: 'number' },
      x: { type: 'number' },
      y: { type: 'number' },
      behavior: { type: 'string', enum: ['auto', 'smooth'] },
    },
    required: ['paneId'],
  },
  handler: async (args, ctx) => {
    const paneId = requireStr(args, 'paneId');
    authorizePaneRef(ctx, paneId, 'write');
    return scrollBrowserPane(paneId, ctx.scope, {
      ref: str(args, 'ref'),
      dx: num(args, 'dx'),
      dy: num(args, 'dy'),
      x: num(args, 'x'),
      y: num(args, 'y'),
      behavior: str(args, 'behavior') === 'smooth' ? 'smooth' : undefined,
    });
  },
};

const browserPressTool: McpToolDef = {
  name: 'nexus_browser_press',
  description:
    'Press a keyboard key on the focused element, or on a `ref` when given ' +
    '(the element is focused first). Accepts named keys (Enter, Tab, Escape, ' +
    'ArrowUp/Down/Left/Right, Backspace, Delete, F1-F12, ...) or a single ' +
    'printable character. Modifiers: Shift, Control, Alt, Meta.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      ref: { type: 'string' },
      key: { type: 'string' },
      modifiers: {
        type: 'array',
        items: { type: 'string', enum: ['Shift', 'Control', 'Alt', 'Meta'] },
      },
    },
    required: ['paneId', 'key'],
  },
  handler: async (args, ctx) => {
    const paneId = requireStr(args, 'paneId');
    authorizePaneRef(ctx, paneId, 'write');
    return pressBrowserKey(paneId, ctx.scope, {
      key: requireStr(args, 'key'),
      ref: str(args, 'ref'),
      modifiers: strArray(args, 'modifiers'),
    });
  },
};

const browserHoverTool: McpToolDef = {
  name: 'nexus_browser_hover',
  description:
    'Hover a visible element by opaque ref (dispatches the pointer + mouse ' +
    'over/enter sequence and focuses it). Useful for triggering tooltips, ' +
    'dropdown menus, and :hover-driven UI.',
  inputSchema: {
    type: 'object',
    properties: { paneId: { type: 'string' }, ref: { type: 'string' } },
    required: ['paneId', 'ref'],
  },
  handler: async (args, ctx) => {
    const paneId = requireStr(args, 'paneId');
    authorizePaneRef(ctx, paneId, 'write');
    return hoverBrowserElement(paneId, ctx.scope, requireStr(args, 'ref'));
  },
};

export function buildBrowserTools(): McpToolDef[] {
  return [
    previewStartTool,
    previewStopTool,
    browserOpenTool,
    browserNavigateTool,
    browserScreenshotTool,
    browserReadTool,
    browserInspectTool,
    browserClickTool,
    browserFillTool,
    browserWaitTool,
    browserScrollTool,
    browserPressTool,
    browserHoverTool,
    perfSnapshotTool,
  ];
}
