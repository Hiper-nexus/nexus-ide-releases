import { useCallback, useEffect, useMemo } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Code } from '@tiptap/extension-code';
import {
  parseInlineMarkdown,
  serializeInlineMarkdown,
  type RichTextMark,
  type RichTextSpan,
} from '../../shared/rich-text-marks';

/**
 * Editor Tiptap (item T3 "editor Tiptap" — o de verdade, com `@tiptap/*`).
 *
 * O documento continua markdown (fonte canônica). Os spans de
 * `rich-text-marks` viram nós ProseMirror; a cada update o markdown é
 * re-serializado. Marks: bold/italic/strike/code — o mesmo contrato da
 * superfície contenteditable anterior.
 */

export interface ComposerTiptapEditorProps {
  readonly value: string;
  readonly onChange?: (markdown: string) => void;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  readonly editable?: boolean;
}

const MARK_TOOLS: ReadonlyArray<{
  mark: RichTextMark;
  label: string;
  title: string;
  shortcut: string;
}> = [
  { mark: 'bold', label: 'B', title: 'Negrito', shortcut: 'Mod-b' },
  { mark: 'italic', label: 'I', title: 'Itálico', shortcut: 'Mod-i' },
  { mark: 'strike', label: 'S', title: 'Tachado', shortcut: 'Mod-Shift-s' },
  { mark: 'code', label: '<>', title: 'Código inline', shortcut: 'Mod-e' },
];

function spanToTiptapText(span: RichTextSpan) {
  return {
    type: 'text' as const,
    text: span.text,
    ...(span.marks.length > 0
      ? {
          marks: span.marks.map((mark) => ({
            type:
              mark === 'strike' ? 'strike' : mark === 'code' ? 'code' : mark,
          })),
        }
      : {}),
  };
}

/**
 * Uma linha vira um parágrafo. `\n` no texto do ProseMirror some no mount,
 * então a quebra tem de ser bloco, inclusive a linha em branco.
 */
export function markdownToTiptapContent(markdown: string) {
  return {
    type: 'doc' as const,
    content: markdown.split('\n').map((line) => {
      const content = parseInlineMarkdown(line)
        .filter((span) => span.text.length > 0)
        .map(spanToTiptapText);
      return content.length > 0
        ? { type: 'paragraph' as const, content }
        : { type: 'paragraph' as const };
    }),
  };
}

/** doc JSON → spans → markdown canônico. Enter separa parágrafos; Shift+Enter é hardBreak. */
export function tiptapJsonToMarkdown(doc: {
  content?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
      marks?: Array<{ type: string }>;
    }>;
  }>;
}): string {
  const blocks: string[] = [];
  for (const paragraph of doc.content ?? []) {
    const spans: RichTextSpan[] = [];
    for (const node of paragraph.content ?? []) {
      if (node.type === 'hardBreak') {
        spans.push({ text: '\n', marks: [] });
        continue;
      }
      if (typeof node.text !== 'string') continue;
      const marks = (node.marks ?? [])
        .map((m) => m.type)
        .filter((t): t is RichTextMark =>
          t === 'bold' || t === 'italic' || t === 'strike' || t === 'code',
        );
      spans.push({ text: node.text, marks });
    }
    blocks.push(serializeInlineMarkdown(spans));
  }
  return blocks.join('\n');
}

export function ComposerTiptapEditor({
  value,
  onChange,
  placeholder = 'Escreva aqui…',
  ariaLabel = 'Editor rich-text',
  editable = true,
}: ComposerTiptapEditorProps) {
  const initialContent = useMemo(
    () => markdownToTiptapContent(value),
    // Só o valor inicial monta o doc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        blockquote: false,
        bulletList: false,
        codeBlock: false,
        heading: false,
        horizontalRule: false,
        listItem: false,
        orderedList: false,
        underline: false,
        dropcursor: false,
        gapcursor: false,
        code: false,
      }),
      // Code mark não exclui bold/italic (política T3 ComposerCodeExtension).
      Code.extend({ excludes: 'code' }),
    ],
    content: initialContent,
    editable,
    editorProps: {
      attributes: {
        'aria-label': ariaLabel,
        'aria-placeholder': placeholder,
        role: 'textbox',
        'aria-multiline': 'true',
        class: 'composer-rich-text composer-tiptap__surface',
      },
    },
    onUpdate: ({ editor: e }) => {
      if (!onChange) return;
      onChange(tiptapJsonToMarkdown(e.getJSON() as never));
    },
  });

  useEffect(() => {
    if (!editor) return;
    const current = tiptapJsonToMarkdown(editor.getJSON() as never);
    if (current === value) return;
    editor.commands.setContent(markdownToTiptapContent(value), {
      emitUpdate: false,
    });
  }, [editor, value]);

  const toggle = useCallback(
    (mark: RichTextMark) => {
      if (!editor) return;
      if (mark === 'bold') editor.chain().focus().toggleBold().run();
      else if (mark === 'italic') editor.chain().focus().toggleItalic().run();
      else if (mark === 'strike') editor.chain().focus().toggleStrike().run();
      else if (mark === 'code') editor.chain().focus().toggleCode().run();
    },
    [editor],
  );

  if (!editor) return null;

  return (
    <div className="composer-tiptap">
      <div
        className="composer-rich-text-editor__toolbar"
        role="toolbar"
        aria-label="Formatação do texto"
      >
        {MARK_TOOLS.map(({ mark, label, title }) => (
          <button
            key={mark}
            type="button"
            className={`composer-rich-text-editor__tool${
              editor.isActive(mark === 'strike' ? 'strike' : mark)
                ? ' is-active'
                : ''
            }`}
            aria-label={title}
            aria-pressed={editor.isActive(mark === 'strike' ? 'strike' : mark)}
            title={title}
            onMouseDown={(e) => {
              e.preventDefault();
              toggle(mark);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
