/**
 * Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62.
 * Copyright (c) 2026 T3 Tools Inc. — MIT License.
 * See third_party/licenses/t3code-MIT.txt.
 * Upstream reference: apps/web/src/components/ComposerPromptEditorTiptap.tsx.
 * Nexus changes: Narrow ComposerCodeExtension excludes-code policy adapted. Nexus reduced Tiptap wrapper implements canonical multiline/hardBreak serialization, external-value synchronization, toolbar accessibility and readonly guards; F-1170 adds the textarea contract (Enter submit with the upstream IME guard, imperative focus, id/aria, maxLength, plain-text paste/drop) and minimal-escape serialization; no upstream full composer/upload/mention UI port.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Code } from '@tiptap/extension-code';
import { Extension, type JSONContent } from '@tiptap/core';
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Slice, type Node as PmNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
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
 *
 * F-1170: é o campo de escrita da missão, então cumpre o contrato do
 * `<textarea>` que substitui — Enter envia (Shift+Enter quebra linha) com a
 * guarda de IME, foco imperativo para a citação, id/aria, `maxLength` sobre o
 * markdown e colar só texto puro.
 */

export interface ComposerTiptapEditorProps {
  /** Canonical markdown; external changes replace the document without an onChange echo. */
  readonly value: string;
  readonly onChange?: (markdown: string) => void;
  readonly placeholder?: string;
  /** Nome acessível quando não há rótulo visível (`ariaLabelledBy` vence). */
  readonly ariaLabel?: string;
  readonly ariaLabelledBy?: string;
  readonly ariaDescribedBy?: string;
  readonly ariaInvalid?: boolean;
  readonly id?: string;
  readonly editable?: boolean;
  /** Enter sem Shift envia (nunca durante a composição do IME). Sem ele, Enter abre parágrafo. */
  readonly onSubmit?: () => void;
  /** Teto em unidades UTF-16 do markdown canônico (o que é salvo/enviado), como no textarea. */
  readonly maxLength?: number;
  /** Barra B/I/S/<> visível; os atalhos funcionam com ou sem ela. */
  readonly toolbar?: boolean;
  readonly className?: string;
  readonly surfaceClassName?: string;
}

export interface ComposerTiptapEditorHandle {
  focus(): void;
  /** Foca com o cursor no fim do documento (citação recém-anexada). */
  focusEnd(): void;
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

const RICH_TEXT_MARKS: readonly RichTextMark[] = ['bold', 'italic', 'strike', 'code'];

function isRichTextMark(type: string | undefined): type is RichTextMark {
  return RICH_TEXT_MARKS.includes(type as RichTextMark);
}

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

function markdownToTiptapContent(markdown: string): JSONContent {
  return spansToTiptapContent(parseInlineMarkdown(markdown.replace(/\r\n?/gu, '\n')));
}

function paragraphSpans(paragraph: JSONContent): RichTextSpan[] {
  const spans: RichTextSpan[] = [];
  for (const node of paragraph.content ?? []) {
    if (node.type === 'hardBreak') {
      spans.push({ text: '\n', marks: [] });
      continue;
    }
    if (typeof node.text !== 'string') continue;
    const marks = (node.marks ?? []).map((m) => m.type).filter(isRichTextMark);
    spans.push({ text: node.text, marks });
  }
  return spans;
}

/**
 * Texto sem marca sai cru; só os trechos marcados passam pelo serializador.
 * Não é garantidamente fiel — `tiptapJsonToMarkdown` confere pelo parser.
 */
function serializeMinimal(spans: readonly RichTextSpan[]): string {
  let out = '';
  let marked: RichTextSpan[] = [];
  const flush = () => {
    if (marked.length) out += serializeInlineMarkdown(marked);
    marked = [];
  };
  for (const span of spans) {
    if (span.marks.length) marked.push(span);
    else {
      flush();
      out += span.text;
    }
  }
  flush();
  return out;
}

/** Texto + marcas por trecho, normalizado, para comparar dois documentos. */
function spanFingerprint(spans: readonly RichTextSpan[]): string {
  const parts: Array<[string, string]> = [];
  for (const span of spans) {
    if (!span.text) continue;
    const key = [...span.marks].sort().join(',');
    const last = parts.at(-1);
    if (last && last[0] === key) last[1] += span.text;
    else parts.push([key, span.text]);
  }
  return JSON.stringify(parts);
}

const MAX_GREEDY_BLOCKS = 400;

/**
 * doc JSON → markdown canônico. Enter vira quebra entre parágrafos.
 *
 * F-1170: o markdown é o que o agente lê. Escapar todo `_`/`*`/crase faria
 * `my_file.ts` chegar como `my\_file.ts` e quebraria a marca de origem da
 * citação. Então o texto sem marca sai cru sempre que o parser o lê de volta
 * idêntico; só onde a leitura mudaria (ex.: `**x**` digitado como texto) o
 * bloco cai no serializador com escapes. A ida e volta continua exata.
 */
export function tiptapJsonToMarkdown(doc: JSONContent): string {
  const blocks = (doc.content ?? []).map(paragraphSpans);
  const expected: RichTextSpan[] = [];
  blocks.forEach((spans, index) => {
    if (index > 0) expected.push({ text: '\n', marks: [] });
    expected.push(...spans);
  });
  const target = spanFingerprint(expected);
  const reads = (markdown: string) => spanFingerprint(parseInlineMarkdown(markdown)) === target;

  const minimal = blocks.map(serializeMinimal);
  const minimalText = minimal.join('\n');
  if (reads(minimalText)) return minimalText;

  const escaped = blocks.map((spans) => serializeInlineMarkdown(spans));
  if (blocks.length > MAX_GREEDY_BLOCKS) return escaped.join('\n');
  // Bloco a bloco: mantém cru o que não muda a leitura do documento inteiro
  // (ênfase pode parear entre linhas, então a conferência é global).
  const chosen = [...escaped];
  for (let index = 0; index < blocks.length; index += 1) {
    if (minimal[index] === escaped[index]) continue;
    chosen[index] = minimal[index]!;
    if (!reads(chosen.join('\n'))) chosen[index] = escaped[index]!;
  }
  return chosen.join('\n');
}

function pmDocMarkdown(doc: PmNode): string {
  return tiptapJsonToMarkdown(doc.toJSON() as JSONContent);
}

/** Markdown colado → slice aberto (o 1º/último parágrafo fundem com o atual). */
function markdownSlice(view: EditorView, markdown: string): Slice {
  const doc = view.state.schema.nodeFromJSON(markdownToTiptapContent(markdown));
  return new Slice(doc.content, 1, 1);
}

const LIMIT_KEY = new PluginKey('composerMaxLength');
const LIMIT_EXTERNAL = 'composerExternalValue';

function isComposingEnter(event: KeyboardEvent | ReactKeyboardEvent): boolean {
  const native = 'nativeEvent' in event ? event.nativeEvent : event;
  return event.key === 'Enter' && (native.isComposing || native.keyCode === 229);
}

export const ComposerTiptapEditor = forwardRef<ComposerTiptapEditorHandle, ComposerTiptapEditorProps>(
  function ComposerTiptapEditor(
    {
      value,
      onChange,
      placeholder = 'Escreva aqui…',
      ariaLabel = 'Editor rich-text',
      ariaLabelledBy,
      ariaDescribedBy,
      ariaInvalid,
      id,
      editable = true,
      onSubmit,
      maxLength,
      toolbar = true,
      className,
      surfaceClassName,
    },
    ref,
  ) {
    const lastExternalValue = useRef(value);
    const limitId = useId();
    const [limitHit, setLimitHit] = useState(false);
    const onSubmitRef = useRef(onSubmit);
    onSubmitRef.current = onSubmit;
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const maxLengthRef = useRef(maxLength);
    maxLengthRef.current = maxLength;
    const initialContent = useMemo(
      () => markdownToTiptapContent(value),
      // Só o valor inicial monta o doc.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    );

    // Teto do textarea: transação que cresceria além dele não entra (apagar
    // sempre entra, mesmo com um valor externo acima do teto).
    const limitExtension = useMemo(
      () =>
        Extension.create({
          name: 'composerMaxLength',
          addProseMirrorPlugins() {
            return [
              new Plugin({
                key: LIMIT_KEY,
                filterTransaction(tr: Transaction, state: EditorState) {
                  const max = maxLengthRef.current;
                  if (max === undefined || !tr.docChanged || tr.getMeta(LIMIT_EXTERNAL)) return true;
                  const next = pmDocMarkdown(tr.doc).length;
                  if (next <= max || next <= pmDocMarkdown(state.doc).length) return true;
                  setLimitHit(true);
                  return false;
                },
              }),
            ];
          },
        }),
      [],
    );

    /** Insere markdown em texto puro; com teto, o maior prefixo que cabe. */
    const insertPlainText = useCallback((view: EditorView, raw: string, at?: number): void => {
      const text = raw.replace(/\r\n?/gu, '\n');
      const build = (chunk: string) => {
        const tr = view.state.tr;
        if (at !== undefined) tr.setSelection(TextSelection.create(tr.doc, at));
        return tr.replaceSelection(markdownSlice(view, chunk)).scrollIntoView();
      };
      const max = maxLengthRef.current;
      let tr = build(text);
      if (max !== undefined && pmDocMarkdown(tr.doc).length > max) {
        const chars = Array.from(text);
        let low = 0;
        let high = chars.length;
        // Maior prefixo (em pontos de código: emoji não parte ao meio) que cabe.
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (pmDocMarkdown(build(chars.slice(0, mid).join('')).doc).length <= max) low = mid;
          else high = mid - 1;
        }
        setLimitHit(true);
        if (low === 0) return;
        tr = build(chars.slice(0, low).join(''));
      }
      view.dispatch(tr);
    }, []);

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
        limitExtension,
      ],
      content: initialContent,
      shouldRerenderOnTransaction: true,
      editable,
      editorProps: {
        attributes: {
          ...(ariaLabelledBy ? { 'aria-labelledby': ariaLabelledBy } : { 'aria-label': ariaLabel }),
          ...(id ? { id } : {}),
          ...(ariaInvalid !== undefined ? { 'aria-invalid': String(ariaInvalid) } : {}),
          ...(!editable ? { 'aria-disabled': 'true' } : {}),
          ...((ariaDescribedBy || limitHit)
            ? { 'aria-describedby': [ariaDescribedBy, limitHit ? limitId : null].filter(Boolean).join(' ') }
            : {}),
          'aria-placeholder': placeholder,
          role: 'textbox',
          'aria-multiline': 'true',
          class: `composer-rich-text composer-tiptap__surface${surfaceClassName ? ` ${surfaceClassName}` : ''}`,
        },
        handleKeyDown: (view, event) => {
          // A composição do IME confirma com Enter: não é envio.
          if (view.composing || isComposingEnter(event)) return false;
          if (
            event.key !== 'Enter' || event.shiftKey || event.altKey ||
            event.ctrlKey || event.metaKey || !onSubmitRef.current
          ) return false;
          onSubmitRef.current();
          return true;
        },
        // HTML externo nunca entra no documento: só o texto puro, lido como
        // markdown (a fonte canônica) — o valor sai igual ao que foi colado.
        handlePaste: (view, event) => {
          const text = event.clipboardData?.getData('text/plain') ?? '';
          if (text) insertPlainText(view, text);
          return true;
        },
        handleDrop: (view, event, _slice, moved) => {
          if (moved) return false;
          const text = event.dataTransfer?.getData('text/plain') ?? '';
          if (text) {
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            insertPlainText(view, text, pos);
          }
          return true;
        },
      },
      onUpdate: ({ editor: e }) => {
        const markdown = tiptapJsonToMarkdown(e.getJSON());
        const max = maxLengthRef.current;
        if (max === undefined || markdown.length < max) setLimitHit(false);
        onChangeRef.current?.(markdown);
      },
    });

    useEffect(() => {
      if (!editor || value === lastExternalValue.current) return;
      lastExternalValue.current = value;
      // Equal canonical content is an acknowledgement, not a document reset.
      const next = markdownToTiptapContent(value);
      if (tiptapJsonToMarkdown(editor.getJSON()) !== tiptapJsonToMarkdown(next)) {
        editor
          .chain()
          .command(({ tr }) => {
            tr.setMeta(LIMIT_EXTERNAL, true);
            return true;
          })
          .setContent(next, { emitUpdate: false })
          .run();
      }
    }, [editor, value]);

    useEffect(() => {
      if (editor && editor.isEditable !== editable) editor.setEditable(editable, false);
    }, [editor, editable]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          if (editor && !editor.isDestroyed) editor.view.focus();
        },
        focusEnd: () => {
          if (!editor || editor.isDestroyed) return;
          const { view } = editor;
          // Síncrono (o `focus('end')` do Tiptap espera um frame).
          view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)).scrollIntoView());
          view.focus();
        },
      }),
      [editor],
    );

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
      <div
        className={`composer-tiptap${className ? ` ${className}` : ''}`}
        // Guarda de IME (ComposerPromptEditorTiptap.tsx:975–977): o Enter que
        // confirma a composição não chega ao ProseMirror nem aos atalhos da app,
        // e o default fica com o IME.
        onKeyDownCapture={(event) => {
          if (isComposingEnter(event)) event.stopPropagation();
        }}
      >
        {toolbar && (
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
                  editor.isActive(mark) ? ' is-active' : ''
                }`}
                aria-label={title}
                aria-pressed={editor.isActive(mark)}
                title={title}
                disabled={!editable}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggle(mark)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <EditorContent editor={editor} />
        {limitHit && maxLength !== undefined && (
          <p id={limitId} className="composer-tiptap__limit" role="status">
            Limite de {maxLength} caracteres atingido; o excedente não entrou.
          </p>
        )}
      </div>
    );
  },
);
