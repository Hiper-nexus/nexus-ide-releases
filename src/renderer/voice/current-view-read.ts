import type { AxNode, VisionContext } from '../../shared/vision-ipc';
import { redactVisibleSecrets } from '../../shared/vision-ipc';
import { sanitizeMcpResultOutput } from './mcp-result-output';

const MAX_AX_ITEMS = 60;
const MAX_AX_CHARS = 4_800;
const MAX_OCR_CHARS = 4_800;
const MAX_ACTION_TARGETS = 24;

const TEXTUAL_TAGS = new Set([
  'a',
  'button',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'input',
  'label',
  'li',
  'option',
  'p',
  'select',
  'textarea',
]);

const TEXTUAL_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'heading',
  'link',
  'menuitem',
  'option',
  'radio',
  'switch',
  'tab',
  'textbox',
]);

const SENSITIVE_LABEL_RE =
  /(password|passcode|secret|token|api[-_ ]?key|credential|private[-_ ]?key|payment|credit[-_ ]?card|cvv|cvc|iban|account[-_ ]?number)/i;

function cleanText(value: string | null | undefined, maxChars = 500): string {
  const normalized = value
    ? redactVisibleSecrets(value).replace(/\s+/g, ' ').trim()
    : '';
  if (!normalized) return '';
  return normalized.slice(0, maxChars);
}

function nodeLabel(node: AxNode): string {
  // Prefer semantic labels; never prefer valuetext for form-like controls
  // (values are omitted at AX extract, and redacted here as defense-in-depth).
  return cleanText(
    node.aria.label ??
      node.aria.labelledby ??
      node.aria.valuetext ??
      node.text,
  );
}

function shouldIncludeNode(node: AxNode): boolean {
  if (TEXTUAL_TAGS.has(node.tag)) return true;
  if (node.role && TEXTUAL_ROLES.has(node.role.toLowerCase())) return true;
  // A leaf text node without a semantic HTML tag is still useful, whereas a
  // container's text repeats the complete contents of all its descendants.
  return node.children.length === 0 && Boolean(nodeLabel(node));
}

function screenState(node: AxNode): string {
  return ['selected', 'checked', 'expanded', 'disabled', 'current']
    .map((key) => {
      const value = node.aria[key];
      return value ? `${key}=${value}` : '';
    })
    .filter(Boolean)
    .join(' ');
}

function axSummary(root: AxNode | null): { text: string; items: number; truncated: boolean } {
  if (!root) return { text: '', items: 0, truncated: false };

  const lines: string[] = [];
  const seen = new Set<string>();
  const stack: AxNode[] = [root];
  let chars = 0;
  let truncated = false;

  while (stack.length > 0) {
    const node = stack.pop()!;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]);
    }

    if (!shouldIncludeNode(node)) continue;
    const label = nodeLabel(node);
    const state = screenState(node);
    if (!label && !state) continue;
    const line = `${node.tag}${node.role ? ` (${node.role})` : ''}${
      state ? ` [${state}]` : ''
    }${label ? `: ${label}` : ''}`;
    const canonical = line.toLowerCase();
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    if (lines.length >= MAX_AX_ITEMS || chars + line.length + 1 > MAX_AX_CHARS) {
      truncated = true;
      break;
    }
    lines.push(line);
    chars += line.length + 1;
  }

  return { text: lines.join('\n'), items: lines.length, truncated };
}

function boundedOcr(text: string | null): string | null {
  const normalized = text
    ? redactVisibleSecrets(text).replace(/\s+/g, ' ').trim()
    : '';
  if (!normalized) return null;
  return normalized.length <= MAX_OCR_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_OCR_CHARS)}… [TRUNCATED]`;
}

function currentViewHighlights(root: AxNode | null): string[] {
  if (!root) return [];
  const highlights: string[] = [];
  const seen = new Set<string>();
  const stack: AxNode[] = [root];
  while (stack.length > 0 && highlights.length < 4) {
    const node = stack.pop()!;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]);
    }
    const isPriority = /^h[1-6]$/.test(node.tag) || node.tag === 'button' || node.role === 'tab';
    if (!isPriority) continue;
    const label = nodeLabel(node);
    const key = label.toLocaleLowerCase('pt-BR');
    if (!label || seen.has(key)) continue;
    seen.add(key);
    highlights.push(label);
  }
  return highlights;
}

function axActionKinds(node: AxNode): Array<'click' | 'focus' | 'fill' | 'select'> {
  if (node.tag === 'select' || node.role === 'combobox') return ['focus', 'select'];
  if (node.tag === 'input' || node.tag === 'textarea' || node.role === 'textbox') {
    return ['focus', 'fill'];
  }
  return ['click', 'focus'];
}

function currentViewActionTargets(root: AxNode | null): Array<{
  ref: string;
  label: string;
  allowed: Array<'click' | 'focus' | 'fill' | 'select'>;
}> {
  if (!root) return [];
  const targets: Array<{
    ref: string;
    label: string;
    allowed: Array<'click' | 'focus' | 'fill' | 'select'>;
  }> = [];
  const stack: AxNode[] = [root];
  while (stack.length > 0 && targets.length < MAX_ACTION_TARGETS) {
    const node = stack.pop()!;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]);
    }
    const label = nodeLabel(node);
    if (!node.ref || !label || SENSITIVE_LABEL_RE.test(label)) continue;
    if (node.aria.disabled === 'true') continue;
    targets.push({ ref: node.ref, label, allowed: axActionKinds(node) });
  }
  return targets;
}

/** A short Classic fallback while Live uses the richer structured tool result. */
export function currentViewNarration(context: VisionContext): string {
  const highlights = currentViewHighlights(context.ax.tree);
  const source =
    highlights.length > 0
      ? `Na tela atual, vejo ${highlights.join(', ')}.`
      : context.ocr.text
        ? `O texto visível começa com: ${boundedOcr(context.ocr.text)?.slice(0, 260) ?? ''}.`
        : 'Li a tela atual, mas não encontrei texto visível para narrar.';
  const sanitized = sanitizeMcpResultOutput(source);
  return typeof sanitized === 'string' ? sanitized : 'Li a tela atual.';
}

/**
 * Turns the existing local Vision subsystem into a bounded tool result for
 * Jarvis. The screenshot never leaves main; only AX labels and locally-run OCR
 * text can reach the voice provider, after the same secret redaction used for
 * MCP results.
 */
export function currentViewToolOutput(context: VisionContext): unknown {
  const ax = axSummary(context.ax.tree);
  const output = {
    capturedAt: context.capturedAt,
    accessibility: {
      status: context.ax.status,
      itemCount: ax.items,
      truncated: ax.truncated,
      text: ax.text || null,
      ...(context.ax.error ? { error: context.ax.error } : {}),
    },
    actions: currentViewActionTargets(context.ax.tree),
    ocr: {
      status: context.ocr.status,
      confidence: context.ocr.confidence,
      text: boundedOcr(context.ocr.text),
      ...(context.ocr.error ? { error: context.ocr.error } : {}),
    },
    screenshot: {
      status: context.screenshot.status,
      width: context.screenshot.width,
      height: context.screenshot.height,
      hasImage: context.screenshot.hasImage,
      cloudAllowed: false,
      ...(context.screenshot.error ? { error: context.screenshot.error } : {}),
    },
  };

  return sanitizeMcpResultOutput(output);
}
