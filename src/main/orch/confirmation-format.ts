import { redactArgs } from '../jarvis/audit-log';

/**
 * Formatting for the native agent-confirmation dialog (mcp-server.ts).
 *
 * dialog.showMessageBox renders an NSAlert on macOS, which cannot scroll:
 * every rendered line grows the alert vertically, and once it is taller than
 * the screen the Negar/Permitir buttons are pushed off-screen and the
 * operator is locked out (caso de campo 18/07: um nexus_task action:plan de
 * ~6.000 chars tornou o diálogo infechável no meio de uma missão). The
 * budgets below keep the whole dialog — header lines included — inside a
 * 768px-tall display. The full, redacted invocation is always in the audit
 * log; this text only needs to be enough for the operator to decide.
 */

/** Approximate characters per rendered line in the macOS alert body font. */
export const CONFIRMATION_WRAP_COLUMNS = 60;
export const MAX_CONFIRMATION_ARGUMENT_RENDERED_LINES = 24;
export const MAX_CONFIRMATION_ARGUMENTS_CHARS = 2_000;
export const MAX_CONFIRMATION_LEAF_CHARS = 160;
export const MAX_CONFIRMATION_LINE_CHARS = 300;

/** Rendered-line estimate for a text block under the alert's wrap width. */
export function estimateRenderedLines(text: string): number {
  return text
    .split('\n')
    .reduce(
      (total, line) =>
        total + Math.max(1, Math.ceil(line.length / CONFIRMATION_WRAP_COLUMNS)),
      0,
    );
}

function clipLeafStrings(value: unknown, markTruncated: () => void): unknown {
  if (typeof value === 'string') {
    if (value.length <= MAX_CONFIRMATION_LEAF_CHARS) return value;
    markTruncated();
    return `${value.slice(0, MAX_CONFIRMATION_LEAF_CHARS)}…`;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => clipLeafStrings(entry, markTruncated));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        clipLeafStrings(entry, markTruncated),
      ]),
    );
  }
  return value;
}

/**
 * One header field (e.g. the confirmation reason, which embeds agent-supplied
 * text such as a full terminal command): collapse newlines and cap length so
 * a single field can never blow the dialog's height budget.
 */
export function boundedConfirmationLine(value: string): string {
  const flattened = value.replace(/\s+/g, ' ').trim();
  if (flattened.length <= MAX_CONFIRMATION_LINE_CHARS) return flattened;
  return `${flattened.slice(0, MAX_CONFIRMATION_LINE_CHARS)}…`;
}

/**
 * Redacted, height-bounded rendering of the tool arguments. Secrets are
 * stripped first (redactArgs), then long leaf strings are clipped, then the
 * whole block is capped by characters and by estimated rendered lines.
 */
export function boundedConfirmationArgs(args: Record<string, unknown>): string {
  const redacted = redactArgs(args);
  const fullLength = JSON.stringify(redacted, null, 2).length;
  let truncated = false;
  const markTruncated = () => {
    truncated = true;
  };
  let serialized = JSON.stringify(
    clipLeafStrings(redacted, markTruncated),
    null,
    2,
  );
  if (serialized.length > MAX_CONFIRMATION_ARGUMENTS_CHARS) {
    truncated = true;
    serialized = serialized.slice(0, MAX_CONFIRMATION_ARGUMENTS_CHARS);
  }
  const kept: string[] = [];
  let renderedLines = 0;
  for (const line of serialized.split('\n')) {
    renderedLines += Math.max(
      1,
      Math.ceil(line.length / CONFIRMATION_WRAP_COLUMNS),
    );
    if (renderedLines > MAX_CONFIRMATION_ARGUMENT_RENDERED_LINES) {
      truncated = true;
      break;
    }
    kept.push(line);
  }
  const bounded = kept.join('\n');
  if (!truncated) return bounded;
  return (
    `${bounded}\n… [truncado — ${fullLength} chars no total; ` +
    'ação completa no audit log]'
  );
}
