/**
 * Inspired by pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62 (no code copied).
 * Upstream reference: apps/web/src/components/chat/MermaidDiagram.tsx.
 * Nexus changes: Nexus pure fenced-markdown splitter respects outer fences and preserves canonical diagram source. No upstream component/parser code copied.
 */
/**
 * Markdown com Mermaid (item T3 `ChatMarkdown` / `MermaidDiagram`).
 *
 * Cerca pura: encontra fences ```mermaid e devolve as partes (prosa ×
 * diagrama). Nenhum HTML é gerado aqui — quem renderiza decide. O diagrama
 * fica como fonte canônica; o renderizador Mermaid consome depois.
 */

export type MarkdownPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'mermaid'; readonly source: string; readonly index: number };

const FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*([A-Za-z0-9_-]*)[ \t]*$/;

function closingFence(line: string, opener: string): boolean {
  const close = FENCE.exec(line);
  if (!close) return false;
  const marker = close[2] ?? '';
  return (
    marker[0] === opener[0] &&
    marker.length >= opener.length &&
    (close[3] ?? '') === ''
  );
}

/**
 * Divide o markdown em prosa e blocos mermaid. Fences ```mermaid (ou
 * ```mmd) viram `kind: 'mermaid'`. Dentro de outra cerca, um exemplo
 * ```mermaid fica texto: a cerca de fora não é partida.
 */
export function splitMarkdownMermaid(markdown: string): MarkdownPart[] {
  const lines = (markdown ?? '').split(/\r?\n/);
  const parts: MarkdownPart[] = [];
  let buffer: string[] = [];
  let mermaidIndex = 0;
  let i = 0;
  const flushText = () => {
    if (buffer.length === 0) return;
    parts.push({ kind: 'text', text: buffer.join('\n') });
    buffer = [];
  };
  while (i < lines.length) {
    const open = FENCE.exec(lines[i] ?? '');
    const lang = (open?.[3] ?? '').toLowerCase();
    const isMermaid = lang === 'mermaid' || lang === 'mmd';
    if (open && isMermaid) {
      const fence = open[2] ?? '';
      const indent = open[1];
      flushText();
      const sourceLines: string[] = [];
      i += 1;
      while (i < lines.length) {
        if (closingFence(lines[i] ?? '', fence)) {
          i += 1;
          break;
        }
        sourceLines.push(
          indent && (lines[i] ?? '').startsWith(indent)
            ? (lines[i] ?? '').slice(indent.length)
            : (lines[i] ?? ''),
        );
        i += 1;
      }
      parts.push({
        kind: 'mermaid',
        source: sourceLines.join('\n'),
        index: mermaidIndex,
      });
      mermaidIndex += 1;
      continue;
    }
    if (open) {
      const opener = open[2] ?? '';
      buffer.push(lines[i] ?? '');
      i += 1;
      while (i < lines.length) {
        const inner = lines[i] ?? '';
        buffer.push(inner);
        i += 1;
        if (closingFence(inner, opener)) break;
      }
      continue;
    }
    buffer.push(lines[i] ?? '');
    i += 1;
  }
  flushText();
  return parts;
}

export function hasMermaidBlock(markdown: string): boolean {
  return splitMarkdownMermaid(markdown).some((part) => part.kind === 'mermaid');
}

/** Escape mínimo para o source ir num `<pre data-mermaid>` sem virar HTML. */
export function escapeMermaidSource(source: string): string {
  return source
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
