/**
 * Inspired by pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62 (no code copied).
 * Upstream reference: apps/web/src/composer-rich-text.ts.
 * Nexus changes: Nexus safe React span/code preview over the adapted parser; no upstream rendered UI code copied, no product caller.
 */
import { useMemo } from 'react';
import {
  parseInlineMarkdown,
  type RichTextSpan,
} from '../../shared/rich-text-marks';

/**
 * Editor rich-text (item T3 "editor Tiptap") — camada de renderização.
 * O documento fica markdown; aqui só a superfície de preview consome os
 * spans. O editor Tiptap completo entra por cima do mesmo
 * `parseInlineMarkdown` / `serializeInlineMarkdown`.
 */
export interface ComposerRichTextViewProps {
  /** Markdown do prompt (fonte canônica). */
  readonly markdown: string;
  readonly className?: string;
}

function spanClass(span: RichTextSpan): string {
  return span.marks.map((mark) => `rt-${mark}`).join(' ');
}

export function ComposerRichTextView({
  markdown,
  className,
}: ComposerRichTextViewProps) {
  const spans = useMemo(() => parseInlineMarkdown(markdown), [markdown]);
  return (
    <span className={['composer-rich-text', className].filter(Boolean).join(' ')}>
      {spans.map((span, i) => {
        const cls = spanClass(span);
        if (span.marks.includes('code')) {
          return (
            <code key={i} className={cls}>
              {span.text}
            </code>
          );
        }
        return (
          <span key={i} className={cls}>
            {span.text}
          </span>
        );
      })}
    </span>
  );
}
