/**
 * Strip the PTY echo of the injected prompt from a captured agent reply.
 *
 * After the transcribed prompt is written into a pane, the pane echoes it back
 * (often woven through a spinner/cursor) at the head of the output buffer. Left
 * in, the "talk back" step would speak the user's own command instead of the
 * agent's response. Pure and dependency-free so it can be unit-tested directly.
 */

// eslint-disable-next-line no-control-regex
const ECHO_ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove ANSI, then drop everything up to and including the first occurrence of
 * the prompt. The prompt's words are matched with flexible whitespace so an
 * interleaved cursor/spinner between them still matches. When the prompt can't
 * be located, the cleaned buffer is returned unchanged.
 */
export function stripPromptEcho(raw: string, promptEcho: string): string {
  const clean = raw.replace(ECHO_ANSI_RE, '');
  const words = promptEcho.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return clean.trim();
  const pattern = words.map(escapeRegExp).join('\\s+');
  const match = new RegExp(pattern, 'i').exec(clean);
  if (!match) return clean.trim();
  return clean.slice(match.index + match[0].length).trim();
}
