import type { McpToolDef } from './mcp-protocol';
import {
  captureBrowserScreenshot,
  clickBrowserElement,
  fillBrowserElement,
  inspectBrowserElement,
  loadBrowser,
  readBrowserPage,
  waitForBrowser,
} from '../browser/browser-manager';
import { collectPerfSnapshot } from '../perf/perf-ipc';
import { listPreviews, startPreview, stopPreview } from './preview-server';
import { requestBrowserPane } from './pane-registry';
import { authorizePaneRef, num, requireStr, str } from './tool-util';
import { resolveWorkspaceCwd } from './workspace-path';

const previewStartTool: McpToolDef = {
  name: 'nexus_preview_start',
  description:
    'Serve a built static web app inside the active workspace on a Nexus-owned ' +
    '127.0.0.1 preview URL. Returns {url}; idempotent per canonical directory.',
  inputSchema: {
    type: 'object',
    properties: { dir: { type: 'string' } },
    required: ['dir'],
  },
  handler: async (args) => {
    const dir = requireStr(args, 'dir');
    const workspaceDir = resolveWorkspaceCwd(dir);
    try {
      return await startPreview(workspaceDir);
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
    'Stop a preview by its original directory; omit dir to list running previews.',
  inputSchema: { type: 'object', properties: { dir: { type: 'string' } } },
  handler: async (args) => {
    const dir = str(args, 'dir');
    return dir ? { stopped: stopPreview(dir) } : { running: listPreviews() };
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
    properties: { url: { type: 'string' }, title: { type: 'string' } },
    required: ['url'],
  },
  handler: async (args, ctx) => {
    if (ctx.role === 'worker') {
      throw new Error('not authorized: workers cannot open browser panes');
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
    });
    if (!result.ok || !result.paneId) {
      throw new Error(result.error ?? 'browser open failed');
    }
    const state = await loadBrowser(result.paneId, url, {
      privateAccessConfirmed: true,
    });
    return { ok: true, paneId: result.paneId, state };
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
  handler: async (args, ctx) => {
    const paneId = requireStr(args, 'paneId');
    authorizePaneRef(ctx, paneId, 'write');
    return loadBrowser(paneId, requireStr(args, 'url'), {
      privateAccessConfirmed: true,
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
  handler: async (args, ctx) => {
    const paneId = requireStr(args, 'paneId');
    authorizePaneRef(ctx, paneId, 'read');
    return captureBrowserScreenshot(paneId);
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
    authorizePaneRef(ctx, paneId, 'read');
    return readBrowserPage(paneId, {
      maxChars: num(args, 'maxChars'),
      maxElements: num(args, 'maxElements'),
    });
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
    authorizePaneRef(ctx, paneId, 'read');
    return inspectBrowserElement(paneId, requireStr(args, 'ref'));
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
    return clickBrowserElement(paneId, requireStr(args, 'ref'));
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
    return fillBrowserElement(paneId, requireStr(args, 'ref'), args.text);
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
    authorizePaneRef(ctx, paneId, 'wait');
    const condition = args.condition;
    if (condition !== 'load' && condition !== 'text' && condition !== 'ref') {
      throw new Error('invalid browser wait condition');
    }
    return waitForBrowser(paneId, {
      condition,
      value: str(args, 'value'),
      ref: str(args, 'ref'),
      timeoutMs: num(args, 'timeoutMs'),
    });
  },
};

const perfSnapshotTool: McpToolDef = {
  name: 'nexus_perf_snapshot',
  description:
    'Return process memory, Electron metrics, live PTY count and browser view count.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => collectPerfSnapshot(),
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
    perfSnapshotTool,
  ];
}
