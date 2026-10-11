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
  parseInlineMarkdownDetailed,
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

interface BlockMarkdown {
  readonly text: string;
  /**
   * `safe`: lê sozinho os mesmos trechos/marcas e fecha todo marcador.
   * `open`: lê igual sozinho, mas sobra marcador aberto (ex.: `2*3`) que
   * poderia parear com outra linha — só o documento inteiro decide.
   * `unsafe`: nem os escapes leram igual (rede de segurança).
   */
  readonly state: 'safe' | 'open' | 'unsafe';
}

/**
 * Um parágrafo → markdown. Texto sem marca sai cru quando o parágrafo se lê
 * igual sozinho; senão, com escapes.
 *
 * F-1170 (revisão P2): a conferência é por parágrafo, não pelo documento a
 * cada bloco. O parser só carrega a pilha de marcadores entre linhas, e `\n`
 * não é marcador, escape nem conteúdo de código: com a pilha vazia na
 * fronteira, um parágrafo `safe` se lê no documento exatamente como sozinho.
 * Custo linear, e o resultado por nó ProseMirror (imutável) fica em cache.
 */
function serializeBlock(spans: readonly RichTextSpan[]): BlockMarkdown {
  const target = spanFingerprint(spans);
  const minimal = serializeMinimal(spans);
  const read = parseInlineMarkdownDetailed(minimal);
  if (spanFingerprint(read.spans) === target) {
    return { text: minimal, state: read.balanced ? 'safe' : 'open' };
  }
  const escaped = serializeInlineMarkdown(spans);
  const check = parseInlineMarkdownDetailed(escaped);
  return {
    text: escaped,
    state: check.balanced && spanFingerprint(check.spans) === target ? 'safe' : 'unsafe',
  };
}

function joinBlocks(
  blocks: readonly BlockMarkdown[],
  spansAt: (index: number) => readonly RichTextSpan[],
): string {
  const text = blocks.map((block) => block.text).join('\n');
  if (blocks.every((block) => block.state === 'safe')) return text;
  // Algum marcador sobrou aberto: uma leitura do documento inteiro decide
  // (no máximo três, todas lineares — nunca uma por bloco).
  const expected: RichTextSpan[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    if (index > 0) expected.push({ text: '\n', marks: [] });
    expected.push(...spansAt(index));
  }
  const target = spanFingerprint(expected);
  const reads = (markdown: string) => spanFingerprint(parseInlineMarkdown(markdown)) === target;
  if (reads(text)) return text;
  const closed = blocks
    .map((block, index) => (block.state === 'open' ? serializeInlineMarkdown(spansAt(index)) : block.text))
    .join('\n');
  if (reads(closed)) return closed;
  return blocks.map((_block, index) => serializeInlineMarkdown(spansAt(index))).join('\n');
}

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
  const spans = (doc.content ?? []).map(paragraphSpans);
  return joinBlocks(spans.map(serializeBlock), (index) => spans[index]!);
}

/** Texto literal (fala, colagem de fora) → markdown que se lê igual ao texto. */
export function plainTextToMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  return tiptapJsonToMarkdown({
    type: 'doc',
    content: lines.map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  });
}

/**
 * Corta markdown no maior prefixo que cabe em `max`, por unidades seguras:
 * pontos de código do texto lido (escape, marcador e emoji nunca partem ao
 * meio). Reserializa só quando precisa cortar.
 */
export function truncateMarkdown(markdown: string, max: number): string {
  if (markdown.length <= max) return markdown;
  const units: RichTextSpan[] = [];
  for (const span of parseInlineMarkdown(markdown.replace(/\r\n?/gu, '\n'))) {
    for (const char of Array.from(span.text)) units.push({ text: char, marks: span.marks });
  }
  const prefix = (count: number) =>
    tiptapJsonToMarkdown(spansToTiptapContent(units.slice(0, count)));
  let low = 0;
  let high = units.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (prefix(mid).length <= max) low = mid;
    else high = mid - 1;
  }
  return prefix(low);
}

function pmParagraphSpans(paragraph: PmNode): RichTextSpan[] {
  const spans: RichTextSpan[] = [];
  paragraph.forEach((node) => {
    if (node.type.name === 'hardBreak') spans.push({ text: '\n', marks: [] });
    else if (node.isText) {
      spans.push({ text: node.text ?? '', marks: node.marks.map((m) => m.type.name).filter(isRichTextMark) });
    }
  });
  return spans;
}

// Nós ProseMirror são imutáveis e reaproveitados entre transações: só o
// parágrafo editado é serializado de novo a cada tecla.
const blockCache = new WeakMap<PmNode, BlockMarkdown>();
const docCache = new WeakMap<PmNode, string>();

/** Markdown canônico de um doc ProseMirror, uma vez por doc (cache). */
function pmDocMarkdown(doc: PmNode): string {
  const cached = docCache.get(doc);
  if (cached !== undefined) return cached;
  const paragraphs: PmNode[] = [];
  doc.forEach((node) => paragraphs.push(node));
  const blocks = paragraphs.map((paragraph) => {
    let block = blockCache.get(paragraph);
    if (!block) {
      block = serializeBlock(pmParagraphSpans(paragraph));
      blockCache.set(paragraph, block);
    }
    return block;
  });
  const markdown = joinBlocks(blocks, (index) => pmParagraphSpans(paragraphs[index]!));
  docCache.set(doc, markdown);
  return markdown;
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
    /** Último markdown emitido por onChange: o eco do pai não reserializa nada. */
    const lastEmittedValue = useRef<string | null>(null);
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
          ...(placeholder ? { 'aria-placeholder': placeholder } : {}),
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
        handleDOMEvents: {
          // HTML externo nunca entra no documento: só o texto puro, lido como
          // markdown (a fonte canônica) — o valor sai igual ao que foi colado.
          // Sem texto (print, imagem, HTML com imagem embutida) o editor não
          // insere nada e NÃO reivindica o default: o app anexa o arquivo à
          // missão (App.tsx onPaste ignora cola com defaultPrevented). O
          // schema não tem nó de imagem, então nada nativo sobra no doc.
          paste: (view, event) => {
            const text = event.clipboardData?.getData('text/plain') ?? '';
            if (!text) return true;
            event.preventDefault();
            insertPlainText(view, text);
            return true;
          },
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
        // Mesmo doc que o filtro de teto já serializou: vem do cache.
        const markdown = pmDocMarkdown(e.state.doc);
        lastEmittedValue.current = markdown;
        const max = maxLengthRef.current;
        if (max === undefined || markdown.length < max) setLimitHit(false);
        onChangeRef.current?.(markdown);
      },
    });

    useEffect(() => {
      if (!editor || value === lastExternalValue.current) return;
      lastExternalValue.current = value;
      // Eco do que o editor acabou de emitir: nada a comparar nem aplicar.
      if (value === lastEmittedValue.current && value === pmDocMarkdown(editor.state.doc)) return;
      // Equal canonical content is an acknowledgement, not a document reset.
      const next = markdownToTiptapContent(value);
      const current = pmDocMarkdown(editor.state.doc);
      const incoming = tiptapJsonToMarkdown(next);
      if (current !== incoming) {
        // Troca programática: acréscimo no fim (ditado) mantém o cursor onde
        // estava; substituição (exemplo, rascunho restaurado) leva o cursor ao
        // fim, como o textarea. O foco não muda.
        const appended = current.length > 0 && incoming.startsWith(current);
        const { anchor, head } = editor.state.selection;
        editor
          .chain()
          .command(({ tr }) => {
            tr.setMeta(LIMIT_EXTERNAL, true);
            return true;
          })
          .setContent(next, { emitUpdate: false })
          .command(({ tr }) => {
            const end = Selection.atEnd(tr.doc).from;
            const clamp = (pos: number) => Math.max(1, Math.min(pos, end));
            tr.setSelection(
              appended
                ? TextSelection.between(tr.doc.resolve(clamp(anchor)), tr.doc.resolve(clamp(head)))
                : Selection.atEnd(tr.doc),
            );
            return true;
          })
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
