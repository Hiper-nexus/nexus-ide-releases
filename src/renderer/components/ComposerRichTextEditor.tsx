import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  parseInlineMarkdown,
  serializeInlineMarkdown,
  type RichTextMark,
  type RichTextSpan,
} from '../../shared/rich-text-marks';

/**
 * Editor rich-text (próxima onda do item T3 "editor Tiptap").
 *
 * Superfície contenteditable com toolbar de marks em cima de
 * `rich-text-marks` (parse/serialize). O documento continua markdown — a
 * fonte canônica — e a cada edição o markdown é re-serializado dos spans.
 * Tiptap/ProseMirror entra por cima desta superfície quando as deps
 * `@tiptap/*` forem adicionadas; o contrato de marks já é o mesmo.
 */
export interface ComposerRichTextEditorProps {
  /** Markdown inicial (fonte canônica). */
  readonly value: string;
  readonly onChange?: (markdown: string) => void;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
}

const MARK_TOOLS: ReadonlyArray<{
  mark: RichTextMark;
  label: string;
  title: string;
}> = [
  { mark: 'bold', label: 'B', title: 'Negrito (**texto**)' },
  { mark: 'italic', label: 'I', title: 'Itálico (*texto*)' },
  { mark: 'strike', label: 'S', title: 'Tachado (~~texto~~)' },
  { mark: 'code', label: '<>', title: 'Código (`texto`)' },
];

function MarkedText({ span }: { span: RichTextSpan }): ReactNode {
  let node: ReactNode = span.text;
  if (span.marks.includes('code')) node = <code>{node}</code>;
  if (span.marks.includes('bold')) node = <strong>{node}</strong>;
  if (span.marks.includes('strike')) node = <s>{node}</s>;
  if (span.marks.includes('italic')) node = <em>{node}</em>;
  return node;
}

/**
 * A superfície não re-renderiza. O texto digitado vive no DOM; um render do
 * React por cima apagaria a edição.
 */
const FrozenSurface = memo(
  function FrozenSurface({
    spans,
    editorRef,
    onInput,
    onKeyDown,
    ariaLabel,
    placeholder,
  }: {
    spans: readonly RichTextSpan[];
    editorRef: RefObject<HTMLDivElement | null>;
    onInput: () => void;
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
    ariaLabel: string;
    placeholder?: string;
  }) {
    return (
      <div
        ref={editorRef}
        className="composer-rich-text-editor__surface composer-rich-text"
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        data-placeholder={placeholder}
        suppressContentEditableWarning
        onInput={onInput}
        onKeyDown={onKeyDown}
      >
        {spans.map((span, index) => (
          <MarkedText key={index} span={span} />
        ))}
      </div>
    );
  },
  () => true,
);

export function ComposerRichTextEditor({
  value,
  onChange,
  placeholder,
  ariaLabel = 'Editor de texto com formatação',
}: ComposerRichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [activeMarks, setActiveMarks] = useState<ReadonlySet<RichTextMark>>(
    new Set(),
  );
  const initialSpans = useMemo(
    () => parseInlineMarkdown(value),
    // Só o valor inicial monta os spans; edições vivem no contenteditable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const emit = useCallback(() => {
    const publish = onChangeRef.current;
    if (!editorRef.current || !publish) return;
    publish(editorRef.current.textContent ?? '');
  }, []);

  const toggleMark = useCallback((mark: RichTextMark) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !editorRef.current) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return;
    const selected = range.toString();
    const next = activeMarks.has(mark)
      ? [...activeMarks].filter((m) => m !== mark)
      : [...activeMarks, mark];
    // Re-insere o texto com as marks ativas em markdown; o serialize devolve
    // o markdown canônico e o render refaz os spans.
    const markdown = serializeInlineMarkdown([{ text: selected, marks: next }]);
    range.deleteContents();
    range.insertNode(document.createTextNode(markdown));
    setActiveMarks(new Set(next));
    emit();
  }, [activeMarks, emit]);

  const toggleRef = useRef(toggleMark);
  toggleRef.current = toggleMark;
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      const mark: RichTextMark | null =
        key === 'b' ? 'bold' : key === 'i' ? 'italic' : key === 'e' ? 'code' : null;
      if (!mark) return;
      event.preventDefault();
      toggleRef.current(mark);
    },
    [],
  );

  return (
    <div className="composer-rich-text-editor">
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
              activeMarks.has(mark) ? ' is-active' : ''
            }`}
            aria-label={title}
            aria-pressed={activeMarks.has(mark)}
            title={title}
            onMouseDown={(e) => {
              e.preventDefault();
              toggleMark(mark);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <FrozenSurface
        spans={initialSpans}
        editorRef={editorRef}
        onInput={emit}
        onKeyDown={onKeyDown}
        ariaLabel={ariaLabel}
        placeholder={placeholder}
      />
    </div>
  );
}
