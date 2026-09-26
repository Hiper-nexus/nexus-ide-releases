import { BrowserWindow, type WebContents } from 'electron';
import type { McpToolDef } from './mcp-protocol';
import type { ProjectExecutionScope } from '../../shared/types';
import type {
  AxActionError,
  AxActionKind,
  AxActionRequest,
} from '../../shared/vision-ipc';
import {
  performNexusAxAction,
  readNexusAxTree,
  selectNexusWindow,
  summarizeAxTree,
} from '../vision/ax-tree-reader';
import { getRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';

const UI_ACTIONS = new Set<AxActionKind>(['click', 'focus', 'fill', 'select']);
const UI_ACTION_ERRORS = new Set<AxActionError>([
  'invalid_request',
  'invalid_ref',
  'stale_ref',
  'unknown_ref',
  'detached_control',
  'hidden_control',
  'disabled_control',
  'readonly_control',
  'sensitive_control',
  'unsupported_action',
  'option_not_found',
]);
const UI_REF_RE = /^u[1-9]\d{0,15}e[1-9]\d{0,7}$/;
const MAX_UI_ACTION_TEXT_CHARS = 8_192;

function hasExactScope(
  expected: Readonly<ProjectExecutionScope>,
  actual: Readonly<ProjectExecutionScope> | null,
): boolean {
  return (
    actual !== null &&
    actual.installationId === expected.installationId &&
    actual.projectId === expected.projectId &&
    actual.checkoutId === expected.checkoutId &&
    actual.rootRealPath === expected.rootRealPath
  );
}

function resolveAuthorizedWebContents(
  scope: Readonly<ProjectExecutionScope>,
): WebContents {
  const candidates = BrowserWindow.getAllWindows().filter((win) =>
    !win.isDestroyed() &&
    !win.webContents.isDestroyed() &&
    !win.webContents.isCrashed() &&
    hasExactScope(scope, getRendererWorkspaceScope(win.webContents)),
  );
  const focused = BrowserWindow.getFocusedWindow();
  const selected = selectNexusWindow(
    focused && candidates.includes(focused) ? focused : null,
    candidates,
  );
  if (!selected) {
    throw new Error('No healthy authorized Nexus window is available.');
  }
  assertAuthorizedWebContents(scope, selected.webContents);
  return selected.webContents;
}

function assertAuthorizedWebContents(
  scope: Readonly<ProjectExecutionScope>,
  webContents: WebContents,
): void {
  if (
    webContents.isDestroyed() ||
    webContents.isCrashed() ||
    !hasExactScope(scope, getRendererWorkspaceScope(webContents))
  ) {
    throw new Error('Nexus window is not bound to the authorized project scope.');
  }
}

const uiReadTool: McpToolDef = {
  name: 'nexus_ui_read',
  description:
    'Read the currently visible NexusIDE page/dialog/settings surface through ' +
    'its accessibility tree. Returns bounded visible labels and state. For ' +
    'terminal output use nexus_pane_read; for embedded web-page content use ' +
    'the nexus_browser_* inspection tools.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => {
    const webContents = resolveAuthorizedWebContents(ctx.scope);
    const tree = await readNexusAxTree(webContents);
    assertAuthorizedWebContents(ctx.scope, webContents);
    const summary = summarizeAxTree(tree);
    return {
      surface: 'nexus-ui',
      ...summary,
    };
  },
};

function actionRequest(args: Record<string, unknown>): AxActionRequest {
  const { action, ref, text } = args;
  const needsText = action === 'fill' || action === 'select';
  if (
    Object.keys(args).some((key) => key !== 'action' && key !== 'ref' && key !== 'text') ||
    typeof action !== 'string' ||
    !UI_ACTIONS.has(action as AxActionKind) ||
    typeof ref !== 'string' ||
    !UI_REF_RE.test(ref) ||
    (needsText && typeof text !== 'string') ||
    (!needsText && text !== undefined) ||
    (typeof text === 'string' && text.length > MAX_UI_ACTION_TEXT_CHARS)
  ) {
    throw new Error('Invalid Nexus UI action arguments.');
  }
  return {
    action: action as AxActionKind,
    ref,
    ...(typeof text === 'string' ? { text } : {}),
  };
}

function hasExactResultKeys(
  result: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(result).length === expected.length &&
    expected.every((key) => Object.hasOwn(result, key))
  );
}

const uiActionTool: McpToolDef = {
  name: 'nexus_ui_action',
  description:
    'Read-then-act tool for the NexusIDE interface. Call nexus_ui_read ' +
    'immediately before every action, then use only an opaque [ref=...] from ' +
    'that latest snapshot. Refs expire on the next read and cannot be CSS ' +
    'selectors or JavaScript. Supports click, focus, safe text fill, and ' +
    'existing-option select; disabled, hidden, detached, password, file, ' +
    'secret, and payment controls are refused. Filled text is never returned.',
  requiresConfirm: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'ref'],
    properties: {
      action: { type: 'string', enum: ['click', 'focus', 'fill', 'select'] },
      ref: { type: 'string', pattern: '^u[1-9]\\d{0,15}e[1-9]\\d{0,7}$' },
      text: { type: 'string', maxLength: 8192 },
    },
  },
  handler: async (args, ctx) => {
    const request = actionRequest(args);
    const webContents = resolveAuthorizedWebContents(ctx.scope);
    const rawResult: unknown = await performNexusAxAction(webContents, request);
    assertAuthorizedWebContents(ctx.scope, webContents);
    if (
      !rawResult ||
      typeof rawResult !== 'object' ||
      Array.isArray(rawResult)
    ) {
      throw new Error('Nexus UI renderer returned an invalid action result.');
    }
    const result = rawResult as Record<string, unknown>;
    if (
      result.action !== request.action ||
      result.ref !== request.ref ||
      (result.ok !== true && result.ok !== false) ||
      (result.ok === true
        ? !hasExactResultKeys(result, ['ok', 'action', 'ref'])
        : !hasExactResultKeys(result, ['ok', 'action', 'ref', 'error']) ||
          typeof result.error !== 'string' ||
          !UI_ACTION_ERRORS.has(result.error as AxActionError))
    ) {
      throw new Error('Nexus UI renderer returned an invalid action result.');
    }
    if (result.ok === false) {
      throw new Error(`Nexus UI action refused: ${result.error}`);
    }
    return { ok: true, action: request.action, ref: request.ref };
  },
};

export function buildVisionTools(): McpToolDef[] {
  return [uiReadTool, uiActionTool];
}
