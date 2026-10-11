import { File } from '@pierre/diffs/react';
import type { FileContents } from '@pierre/diffs';
import { useMemo, type ReactNode } from 'react';
import {
  DIFF_PREFERRED_HIGHLIGHTER,
  DIFF_SURFACE_THEME_UNSAFE_CSS,
  resolveDiffThemeName,
} from '../lib/diff-rendering';
import { DiffWorkerPoolProvider, useDiffColorScheme } from './diffs/DiffWorkerPoolProvider';

/**
 * Bloco cercado do markdown com realce (F-1176). Carregado sob demanda pelo
 * `MarkdownView` — só quando há bloco de linguagem conhecida —, para que a
 * prosa não puxe @pierre/diffs nem o Shiki.
 *
 * Mesma infraestrutura do diff: `File` do @pierre/diffs (Shiki JS no pool de
 * workers compartilhado, tema do app). Renderiza em shadow DOM próprio, sem
 * innerHTML do lado do Nexus. Sem cabeçalho de arquivo nem numeração: é
 * texto de agente, não arquivo. Enquanto o pool não fica pronto, `fallback`
 * (o `<pre><code>` puro) ocupa o lugar.
 */
export interface MarkdownCodeHighlightProps {
  readonly code: string;
  /** Linguagem do Shiki, já filtrada por `markdownHighlightLanguage`. */
  readonly lang: string;
  readonly fallback: ReactNode;
}

const MARKDOWN_CODE_UNSAFE_CSS = `${DIFF_SURFACE_THEME_UNSAFE_CSS}
[data-file] pre {
  padding-block: 8px !important;
}
`;

export function MarkdownCodeHighlight({ code, lang, fallback }: MarkdownCodeHighlightProps) {
  const colorScheme = useDiffColorScheme();
  const file = useMemo<FileContents>(() => ({ name: 'bloco', contents: code, lang }), [code, lang]);
  return (
    <DiffWorkerPoolProvider fallback={fallback}>
      <File
        file={file}
        className="markdown-view__highlight"
        style={{ colorScheme }}
        options={{
          theme: resolveDiffThemeName(colorScheme),
          themeType: colorScheme,
          preferredHighlighter: DIFF_PREFERRED_HIGHLIGHTER,
          disableLineNumbers: true,
          disableFileHeader: true,
          overflow: 'scroll',
          unsafeCSS: MARKDOWN_CODE_UNSAFE_CSS,
        }}
      />
    </DiffWorkerPoolProvider>
  );
}
