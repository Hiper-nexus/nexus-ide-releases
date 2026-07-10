import { BrowserWindow } from 'electron';
import type { WebContents } from 'electron';
import type {
  AxActionError,
  AxActionKind,
  AxActionRequest,
  AxActionResult,
  AxNode,
} from '../../shared/vision-ipc';

const MAX_AX_NODES = 240;
const MAX_AX_TEXT_CHARS = 20_000;
const MAX_FIELD_CHARS = 500;
const MAX_RENDERER_AX_NODES = 1_500;
const MAX_RENDERER_AX_DEPTH = 12;
const MAX_RENDERER_ARIA_KEYS = 64;
const MAX_ACTION_TEXT_CHARS = 8_192;
const AX_REF_RE = /^u([1-9]\d{0,15})e[1-9]\d{0,7}$/;
const ACTIONS = new Set<AxActionKind>(['click', 'focus', 'fill', 'select']);
const ACTION_ERRORS = new Set<AxActionError>([
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
const AX_NODE_KEYS = new Set(['tag', 'role', 'aria', 'text', 'ref', 'children']);

interface SnapshotBinding {
  webContentsId: number;
  snapshotId: string;
  refs: ReadonlySet<string>;
}

interface ParsedAxTree {
  tree: AxNode;
  snapshotId: string | null;
  refs: ReadonlySet<string>;
}

interface PendingNode {
  raw: Record<string, unknown>;
  parsed: AxNode;
  depth: number;
}

interface NexusWindowCandidate {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    isCrashed(): boolean;
  };
}

let lastSnapshot: SnapshotBinding | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function invalidTree(): never {
  throw new Error('A página atual forneceu uma árvore de acessibilidade inválida.');
}

function parseAxTree(rawRoot: unknown): ParsedAxTree {
  if (!isRecord(rawRoot)) invalidTree();

  let nodeCount = 0;
  let snapshotId: string | null = null;
  const refs = new Set<string>();

  const parseNode = (raw: unknown, depth: number): PendingNode => {
    if (!isRecord(raw) || !hasOnlyKeys(raw, AX_NODE_KEYS)) invalidTree();
    nodeCount += 1;
    if (nodeCount > MAX_RENDERER_AX_NODES || depth > MAX_RENDERER_AX_DEPTH) {
      invalidTree();
    }

    const { tag, role, aria, text, ref, children } = raw;
    if (typeof tag !== 'string' || tag.length === 0 || tag.length > 128) invalidTree();
    if (role !== null && (typeof role !== 'string' || role.length > 128)) invalidTree();
    if (text !== null && (typeof text !== 'string' || text.length > MAX_FIELD_CHARS)) {
      invalidTree();
    }
    if (!isRecord(aria) || !Array.isArray(children)) invalidTree();
    if (
      Object.keys(aria).length > MAX_RENDERER_ARIA_KEYS ||
      children.length > MAX_RENDERER_AX_NODES
    ) {
      invalidTree();
    }

    const parsedAria: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const [key, value] of Object.entries(aria)) {
      if (
        !/^[a-z][a-z0-9-]{0,63}$/.test(key) ||
        typeof value !== 'string' ||
        value.length > MAX_FIELD_CHARS
      ) {
        invalidTree();
      }
      parsedAria[key] = value;
    }

    if (ref !== undefined) {
      if (typeof ref !== 'string') invalidTree();
      const match = AX_REF_RE.exec(ref);
      if (!match || refs.has(ref)) invalidTree();
      if (snapshotId !== null && snapshotId !== match[1]) invalidTree();
      snapshotId = match[1];
      refs.add(ref);
    }

    return {
      raw,
      depth,
      parsed: {
        tag,
        role,
        aria: parsedAria,
        text,
        ...(typeof ref === 'string' ? { ref } : {}),
        children: [],
      },
    };
  };

  const root = parseNode(rawRoot, 0);
  const stack: PendingNode[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const rawChildren = current.raw.children as unknown[];
    for (const rawChild of rawChildren) {
      const child = parseNode(rawChild, current.depth + 1);
      current.parsed.children.push(child.parsed);
      stack.push(child);
    }
  }

  return { tree: root.parsed, snapshotId, refs };
}

function isUsableNexusWindow(
  candidate: NexusWindowCandidate | null | undefined,
): candidate is NexusWindowCandidate {
  if (!candidate || candidate.isDestroyed()) return false;
  const { webContents } = candidate;
  return !webContents.isDestroyed() && !webContents.isCrashed();
}

/**
 * Prefer the currently focused Nexus window. A global Jarvis command can run
 * while another macOS app owns focus, so fall back only when exactly one
 * healthy Nexus window exists. Ambiguous multi-window state fails closed.
 */
export function selectNexusWindow<T extends NexusWindowCandidate>(
  focused: T | null,
  windows: readonly T[],
): T | null {
  if (isUsableNexusWindow(focused)) return focused;
  const candidates = windows.filter(isUsableNexusWindow);
  return candidates.length === 1 ? candidates[0] : null;
}

function focusedWebContents(): WebContents {
  const selected = selectNexusWindow(
    BrowserWindow.getFocusedWindow(),
    BrowserWindow.getAllWindows(),
  );
  if (!selected) {
    throw new Error('Nenhuma janela Nexus ativa para leitura.');
  }
  return selected.webContents;
}

export async function readFocusedNexusAxTree(): Promise<AxNode> {
  lastSnapshot = null;
  const webContents = focusedWebContents();
  let rawTree: unknown;
  try {
    rawTree = await webContents.executeJavaScript(
      'window.nexus?.vision?.getAxTree()',
    );
  } catch {
    throw new Error('A página atual não forneceu uma árvore de acessibilidade.');
  }
  const parsed = parseAxTree(rawTree);
  if (parsed.snapshotId !== null) {
    lastSnapshot = {
      webContentsId: webContents.id,
      snapshotId: parsed.snapshotId,
      refs: parsed.refs,
    };
  }
  return parsed.tree;
}

function parseActionRequest(raw: AxActionRequest): AxActionRequest {
  if (!isRecord(raw)) throw new Error('Ação de interface inválida.');
  const allowedKeys = new Set(['action', 'ref', 'text']);
  if (!hasOnlyKeys(raw, allowedKeys)) throw new Error('Ação de interface inválida.');
  const { action, ref, text } = raw;
  if (
    typeof action !== 'string' ||
    !ACTIONS.has(action as AxActionKind) ||
    typeof ref !== 'string' ||
    !AX_REF_RE.test(ref)
  ) {
    throw new Error('Ação de interface inválida.');
  }
  const needsText = action === 'fill' || action === 'select';
  if (
    (needsText && typeof text !== 'string') ||
    (!needsText && text !== undefined) ||
    (typeof text === 'string' && text.length > MAX_ACTION_TEXT_CHARS)
  ) {
    throw new Error('Ação de interface inválida.');
  }
  return {
    action: action as AxActionKind,
    ref,
    ...(typeof text === 'string' ? { text } : {}),
  };
}

function serializeForRenderer(request: AxActionRequest): string {
  return JSON.stringify(request)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function invalidRendererActionResult(): never {
  throw new Error('A página atual retornou um resultado de ação inválido.');
}

function parseRendererActionResult(
  raw: unknown,
  request: AxActionRequest,
): AxActionResult {
  if (!isRecord(raw)) invalidRendererActionResult();
  const expectedKeys =
    raw.ok === true
      ? new Set(['ok', 'action', 'ref'])
      : new Set(['ok', 'action', 'ref', 'error']);
  if (
    !hasOnlyKeys(raw, expectedKeys) ||
    (raw.ok !== true && raw.ok !== false) ||
    raw.action !== request.action ||
    raw.ref !== request.ref
  ) {
    invalidRendererActionResult();
  }
  if (raw.ok === true) {
    return { ok: true, action: request.action, ref: request.ref };
  }
  if (typeof raw.error !== 'string' || !ACTION_ERRORS.has(raw.error as AxActionError)) {
    invalidRendererActionResult();
  }
  return {
    ok: false,
    action: request.action,
    ref: request.ref,
    error: raw.error as AxActionError,
  };
}

export async function performFocusedNexusAxAction(
  rawRequest: AxActionRequest,
): Promise<AxActionResult> {
  const request = parseActionRequest(rawRequest);
  const webContents = focusedWebContents();
  const match = AX_REF_RE.exec(request.ref)!;
  if (
    !lastSnapshot ||
    lastSnapshot.webContentsId !== webContents.id ||
    lastSnapshot.snapshotId !== match[1] ||
    !lastSnapshot.refs.has(request.ref)
  ) {
    return {
      ok: false,
      action: request.action,
      ref: request.ref,
      error: 'stale_ref',
    };
  }

  let rawResult: unknown;
  try {
    rawResult = await webContents.executeJavaScript(
      `window.nexus?.vision?.performAxAction(${serializeForRenderer(request)})`,
    );
  } catch {
    throw new Error('A página atual não conseguiu executar a ação solicitada.');
  }
  return parseRendererActionResult(rawResult, request);
}

function clean(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, MAX_FIELD_CHARS) : null;
}

export interface AxTreeSummary {
  text: string;
  nodeCount: number;
  truncated: boolean;
}

/** Compact, bounded, model-readable representation of the visible Nexus DOM. */
export function summarizeAxTree(root: AxNode): AxTreeSummary {
  const lines: string[] = [];
  const stack: Array<{ node: AxNode; depth: number }> = [{ node: root, depth: 0 }];
  let characters = 0;
  let visited = 0;
  let truncated = false;

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited >= MAX_AX_NODES || characters >= MAX_AX_TEXT_CHARS) {
      truncated = true;
      break;
    }
    visited += 1;
    const label = clean(
      current.node.aria.label ??
        current.node.aria.labelledby ??
        current.node.aria.valuetext ??
        current.node.text,
    );
    const state = ['selected', 'checked', 'expanded', 'disabled', 'current']
      .map((key) => (current.node.aria[key] ? `${key}=${current.node.aria[key]}` : ''))
      .filter(Boolean)
      .join(' ');
    if (label || state || current.node.role || current.node.ref) {
      const line = `${'  '.repeat(Math.min(current.depth, 8))}${current.node.tag}${
        current.node.ref ? ` [ref=${current.node.ref}]` : ''
      }${current.node.role ? ` role=${current.node.role}` : ''}${
        state ? ` ${state}` : ''
      }${label ? `: ${label}` : ''}`;
      const remaining = MAX_AX_TEXT_CHARS - characters;
      lines.push(line.slice(0, remaining));
      characters += Math.min(line.length, remaining) + 1;
    }
    for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: current.node.children[index], depth: current.depth + 1 });
    }
  }

  if (stack.length > 0) truncated = true;
  return { text: lines.join('\n'), nodeCount: visited, truncated };
}
