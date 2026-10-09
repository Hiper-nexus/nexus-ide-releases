/**
 * Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62.
 * Copyright (c) 2026 T3 Tools Inc. — MIT License.
 * See third_party/licenses/t3code-MIT.txt.
 * Upstream reference: apps/web/src/components/ComposerPromptEditorTiptap.tsx.
 * Nexus changes: Narrow ComposerCodeExtension excludes-code policy adapted. Nexus reduced Tiptap wrapper implements canonical multiline/hardBreak serialization, external-value synchronization, toolbar accessibility and readonly guards; no upstream full composer/upload/mention UI port or product caller.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Code } from '@tiptap/extension-code';
import type { JSONContent } from '@tiptap/core';
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
  /** Canonical markdown; external changes replace the document without an onChange echo. */
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

/** spans → texto simples + marcas para o doc JSON do ProseMirror. */
function spansToTiptapContent(spans: readonly RichTextSpan[]): JSONContent {
  const paragraphs: JSONContent[] = [{ type: 'paragraph', content: [] }];
  for (const span of spans) {
    const lines = span.text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index]!;
      if (text) paragraphs[paragraphs.length - 1]!.content!.push({
        type: 'text', text,
        ...(span.marks.length ? { marks: span.marks.map((type) => ({ type })) } : {}),
      });
      if (index < lines.length - 1) paragraphs.push({ type: 'paragraph', content: [] });
    }
  }
  return { type: 'doc', content: paragraphs };
}

/** doc JSON → spans → markdown canônico. Enter vira quebra entre parágrafos. */
export function tiptapJsonToMarkdown(doc: JSONContent): string {
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
  const lastExternalValue = useRef(value);
  const initialContent = useMemo(
    () => spansToTiptapContent(parseInlineMarkdown(value)),
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
        link: false,
        dropcursor: false,
        gapcursor: false,
        code: false,
      }),
      // Code mark não exclui bold/italic (política T3 ComposerCodeExtension).
      Code.extend({ excludes: 'code' }),
    ],
    content: initialContent,
    shouldRerenderOnTransaction: true,
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
      const markdown = tiptapJsonToMarkdown(e.getJSON());
      onChange?.(markdown);
    },
  });

  useEffect(() => {
    if (!editor || value === lastExternalValue.current) return;
    lastExternalValue.current = value;
    // Equal canonical content is an acknowledgement, not a document reset.
    const next = spansToTiptapContent(parseInlineMarkdown(value));
    if (tiptapJsonToMarkdown(editor.getJSON()) !== tiptapJsonToMarkdown(next)) {
      editor.commands.setContent(next, { emitUpdate: false });
    }
  }, [editor, value]);

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable, false);
  }, [editor, editable]);

  const toggle = useCallback(
    (mark: RichTextMark) => {
      if (!editable || !editor || !editor.isEditable) return;
      if (mark === 'bold') editor.chain().focus().toggleBold().run();
      else if (mark === 'italic') editor.chain().focus().toggleItalic().run();
      else if (mark === 'strike') editor.chain().focus().toggleStrike().run();
      else if (mark === 'code') editor.chain().focus().toggleCode().run();
    },
    [editor, editable],
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
            disabled={!editable}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggle(mark)}
          >
            {label}
          </button>
        ))}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
