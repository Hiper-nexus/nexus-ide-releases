import {
  assertMcpInvocationCurrent,
  type McpToolDef,
} from './mcp-protocol';
import {
  assertBrowserAtExactUrl,
  captureBrowserScreenshot,
  clickBrowserElement,
  extractBrowserFields,
  fillBrowserElement,
  findBrowserElements,
  hoverBrowserElement,
  inspectBrowserElement,
  loadBrowser,
  pressBrowserKey,
  readBrowserPage,
  readBrowserPageCompact,
  scrollBrowserPane,
  waitForBrowser,
  type BrowserInlineRead,
} from '../browser/browser-manager';
import type { BrowserExtractField } from '../../shared/browser-automation';
import { collectPerfSnapshotDetailed } from '../perf/perf-ipc';
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

/** `read: true` or a bounded read-options object → inline page read. */
function inlineReadArg(args: Record<string, unknown>): BrowserInlineRead | undefined {
  if (args.read === true) return true;
  if (args.read && typeof args.read === 'object') {
    return args.read as Exclude<BrowserInlineRead, boolean>;
  }
  return undefined;
}

const READ_ARG_PROP = {
  description:
    'read: true devolve a página resultante na mesma resposta — evita um ' +
    'nexus_browser_read a mais. Também aceita {maxChars, maxElements, format}.',
};
const JUDGE_ARG_PROP = {
  type: 'boolean',
  description:
    'judge: true anexa um julgamento Jev da página (erro visível, ' +
    'bloqueio humano, carregando, tipo) — falha aberta, nunca bloqueia.',
};

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
      // Mission approval permits public research, but never doubles as
      // localhost/private-network consent. Trusted Nexus previews and the
      // native browser flow retain their own narrow confirmation paths.
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
        privateAccessConfirmed: false,
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

const DEVICE_ARG_PROP = {
  type: 'string',
  enum: ['mobile', 'tablet', 'desktop'],
  description:
    'Emulate a device breakpoint before loading (real UA + viewport metrics, ' +
    'reused from the operator\'s responsive-preview toggle) — "mobile"/"tablet" ' +
    'serve the real mobile/tablet layout, "desktop" turns emulation back off. ' +
    'Combine with nexus_browser_screenshot per breakpoint to check responsiveness.',
};

const browserNavigateTool: McpToolDef = {
  name: 'nexus_browser_navigate',
  requiresConfirm: true,
  description:
    'Navigate an owned browser pane to a confirmed URL. Redirects and DNS are ' +
    'revalidated independently. Every result carries after/changed and the ' +
    'errors observed since the previous action.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      url: { type: 'string' },
      read: READ_ARG_PROP,
      judge: JUDGE_ARG_PROP,
      device: DEVICE_ARG_PROP,
    },
    required: ['paneId', 'url'],
  },
  handler: async (args, ctx, invocation) => {
    const paneId = requireStr(args, 'paneId');
    authorizePaneRef(ctx, paneId, 'write');
    const device = str(args, 'device');
    return loadBrowser(paneId, requireStr(args, 'url'), {
      scope: ctx.scope,
      privateAccessConfirmed: false,
      signal: invocation?.signal,
      assertCurrentAuthority: invocation?.assertCurrentAuthority,
      read: inlineReadArg(args),
      judge: args.judge === true,
      sessionId: ctx.sessionId,
      missionId: ctx.missionId,
      ...(device === 'mobile' || device === 'tablet' || device === 'desktop'
        ? { device }
        : {}),
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
    'Read bounded visible page text, alerts and accessible interactive ' +
    'elements. Returns opaque refs for click/fill/inspect; never input ' +
    'values or storage. `format: "compact"` devolve um outline LLM-friendly ' +
    'em vez do JSON completo. `errors` traz os erros vistos desde a última ' +
    'ação. Julgamento Jev por padrão (auto-on, fail-open): "isso respondeu? ' +
    'tem erro visível? precisa de humano?". `judge: false` desliga.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      maxChars: { type: 'number', description: 'Visible text cap; max 20000' },
      maxElements: { type: 'number', description: 'Element cap; max 200' },
      format: { type: 'string', enum: ['json', 'compact'] },
      judge: JUDGE_ARG_PROP,
    },
    required: ['paneId'],
  },
  handler: async (args, ctx) => {
    const paneId = requireStr(args, 'paneId');
    const reviewAuthority = authorizeBrowserPane(ctx, paneId, 'read');
    assertReviewSurfaceCurrent(ctx, reviewAuthority);
    const options = {
      maxChars: num(args, 'maxChars'),
      maxElements: num(args, 'maxElements'),
      // Auto-on: julgar a página é o que o Jev faz de melhor (decisão) e o
      // agente não precisa lembrar do flag. Opt-out explícito com judge: false.
      judge: args.judge !== false,
      sessionId: ctx.sessionId,
      missionId: ctx.missionId,
    };
    const result =
      str(args, 'format') === 'compact'
        ? await readBrowserPageCompact(paneId, ctx.scope, options)
        : await readBrowserPage(paneId, ctx.scope, options);
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

const browserFindTool: McpToolDef = {
  name: 'nexus_browser_find',
  description:
    'Find visible interactive elements by accessible name (case- and ' +
    'diacritics-insensitive) and/or implicit role. The query is scored ' +
    'against names and link paths — it never becomes a CSS selector. ' +
    'Returns scored matches with opaque refs for click/fill. When 2–5 ' +
    'top matches are score-tied, a Jev choice (auto-on, fail-open) picks ' +
    'one via `picked` at confidence ≥ 0.7; otherwise the lexical ranking ' +
    'and candidates stand. `judge: false` disables the tie-break.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      text: { type: 'string', description: 'Accessible name text; max 200' },
      role: { type: 'string', description: 'Filter by implicit role' },
      limit: { type: 'number', description: 'Max matches; default 10, max 25' },
      judge: JUDGE_ARG_PROP,
    },
    required: ['paneId'],
  },
  handler: async (args, ctx) => {
    const paneId = requireStr(args, 'paneId');
    const reviewAuthority = authorizeBrowserPane(ctx, paneId, 'read');
    assertReviewSurfaceCurrent(ctx, reviewAuthority);
    const result = await findBrowserElements(paneId, ctx.scope, {
      text: str(args, 'text'),
      role: str(args, 'role'),
      limit: num(args, 'limit'),
      // Auto-on: o desempate Jev é a superfície `browserTool` em modo
      // só-injeção de escolha (nunca age). Opt-out com judge: false.
      judge: args.judge !== false,
      sessionId: ctx.sessionId,
      missionId: ctx.missionId,
    });
    if (reviewAuthority) {
      assertReviewSurfaceCurrent(ctx, reviewAuthority);
      recordAutomatedReviewBrowserInspection(reviewAuthority, 'find');
    }
    return result;
  },
};

const browserExtractTool: McpToolDef = {
  name: 'nexus_browser_extract',
  description:
    'Extrai campos tipados da página visível: o código levanta candidatos ' +
    '(JSON-LD, tabelas, label→valor, números/datas/e-mails) e o Jev escolhe ' +
    'o candidato certo por campo com confiança; nunca inventa valor — null ' +
    'quando não há candidato confiável — e nunca lê valores digitados em ' +
    'campos. Sem CSS/JS.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      fields: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Field key; ≤64 chars.' },
            type: {
              type: 'string',
              enum: ['string', 'number', 'boolean', 'date', 'enum'],
            },
            enum: {
              type: 'array',
              items: { type: 'string' },
              description: 'Required options when type is "enum".',
            },
            hint: {
              type: 'string',
              description:
                'Short disambiguation hint (also accepted as `description`).',
            },
            description: {
              type: 'string',
              description: 'Synonym for `hint`.',
            },
          },
          required: ['name', 'type'],
          additionalProperties: false,
        },
      },
    },
    required: ['paneId', 'fields'],
  },
  handler: async (args, ctx) => {
    const paneId = requireStr(args, 'paneId');
    const reviewAuthority = authorizeBrowserPane(ctx, paneId, 'read');
    assertReviewSurfaceCurrent(ctx, reviewAuthority);
    const result = await extractBrowserFields(
      paneId,
      ctx.scope,
      args.fields as BrowserExtractField[],
      { sessionId: ctx.sessionId, missionId: ctx.missionId },
    );
    if (reviewAuthority) {
      assertReviewSurfaceCurrent(ctx, reviewAuthority);
      if (result.url !== reviewAuthority.surface.url) {
        throw new Error(
          'automated design-review extract came from another URL',
        );
      }
      recordAutomatedReviewBrowserInspection(reviewAuthority, 'extract');
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
    'Click a visible element by opaque `ref` from browser_read/find — or by ' +
    'plain `text` (accessible name, never a CSS selector or JavaScript). ' +
    'With text, a clear winner is clicked; when ambiguous the response ' +
    'carries `candidates` and nothing is clicked (Jev only breaks ties ' +
    'with ≥ 0.7 confidence). The click requires user confirmation.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      ref: { type: 'string' },
      text: {
        type: 'string',
        description: 'Accessible name to click instead of a ref',
      },
      read: READ_ARG_PROP,
      judge: JUDGE_ARG_PROP,
    },
    required: ['paneId'],
  },
  handler: async (args, ctx) => {
    const paneId = requireStr(args, 'paneId');
    authorizePaneRef(ctx, paneId, 'write');
    const target =
      str(args, 'ref') ??
      (typeof args.text === 'string' ? { text: args.text } : null);
    if (!target) throw new Error('missing required argument: ref or text');
    return clickBrowserElement(paneId, ctx.scope, target, {
      read: inlineReadArg(args),
      judge: args.judge === true,
      sessionId: ctx.sessionId,
      missionId: ctx.missionId,
    });
  },
};

const browserFillTool: McpToolDef = {
  name: 'nexus_browser_fill',
  requiresConfirm: true,
  description:
    'Fill or clear a visible text field by opaque `ref` — or by `label` ' +
    '(accessible name/label text, never a selector). With label, a clear ' +
    'winner is filled; when ambiguous the response carries `candidates` and ' +
    'nothing is filled. Password, payment, token, file, hidden and other ' +
    'sensitive fields are refused.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      ref: { type: 'string' },
      label: {
        type: 'string',
        description: 'Accessible field name to fill instead of a ref',
      },
      text: { type: 'string' },
      read: READ_ARG_PROP,
      judge: JUDGE_ARG_PROP,
    },
    required: ['paneId', 'text'],
  },
  handler: async (args, ctx) => {
    const paneId = requireStr(args, 'paneId');
    authorizePaneRef(ctx, paneId, 'write');
    if (typeof args.text !== 'string') throw new Error('missing required argument: text');
    const target =
      str(args, 'ref') ??
      (typeof args.label === 'string' ? { text: args.label } : null);
    if (!target) throw new Error('missing required argument: ref or label');
    return fillBrowserElement(paneId, ctx.scope, target, args.text, {
      read: inlineReadArg(args),
      judge: args.judge === true,
      sessionId: ctx.sessionId,
      missionId: ctx.missionId,
    });
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
    'Return process memory, Electron metrics, live PTY count, browser view count, ' +
    'per-pane process-tree RSS (CLI + MCP children), system free memory/swap and ' +
    'the pane admission limits (F-572).',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => collectPerfSnapshotDetailed(),
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
      read: READ_ARG_PROP,
      judge: JUDGE_ARG_PROP,
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
      read: inlineReadArg(args),
      judge: args.judge === true,
      sessionId: ctx.sessionId,
      missionId: ctx.missionId,
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
      read: READ_ARG_PROP,
      judge: JUDGE_ARG_PROP,
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
      read: inlineReadArg(args),
      judge: args.judge === true,
      sessionId: ctx.sessionId,
      missionId: ctx.missionId,
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
    properties: {
      paneId: { type: 'string' },
      ref: { type: 'string' },
      read: READ_ARG_PROP,
      judge: JUDGE_ARG_PROP,
    },
    required: ['paneId', 'ref'],
  },
  handler: async (args, ctx) => {
    const paneId = requireStr(args, 'paneId');
    authorizePaneRef(ctx, paneId, 'write');
    return hoverBrowserElement(paneId, ctx.scope, requireStr(args, 'ref'), {
      read: inlineReadArg(args),
      judge: args.judge === true,
      sessionId: ctx.sessionId,
      missionId: ctx.missionId,
    });
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
    browserFindTool,
    browserExtractTool,
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
