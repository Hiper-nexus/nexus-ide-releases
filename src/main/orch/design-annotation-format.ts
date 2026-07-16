import type {
  BrowserDesignAnnotation,
  BrowserDesignAnnotationPriority,
} from '../../shared/browser-design';
import { DESIGN_ANNOTATION_INTENT_LABELS } from '../../shared/browser-design';
import {
  DESIGN_SYSTEM_BEGIN,
  DESIGN_SYSTEM_END,
  UNTRUSTED_PAGE_DATA_BEGIN,
  UNTRUSTED_PAGE_DATA_END,
  UNTRUSTED_PAGE_DATA_PREAMBLE,
  safeOuterHtml,
  safePageText,
} from './design-context-format';

/**
 * Formats a pane's design annotations into ONE consolidated feedback prompt
 * for an agent CLI pane. Numbered items match the badges rendered in the page
 * and the entries inside the untrusted envelope, so the agent can correlate
 * "what the user said" (trusted, typed in the IDE) with "what the page is"
 * (untrusted, page-derived) without ambiguity.
 *
 * Output model adapted from stablyai/orca's Design Mode batch feedback
 * (`formatBrowserAnnotationsAsMarkdown`, MIT — provenance in
 * third_party/provenance/orca-5e1009.json), rebuilt on this project's
 * untrusted-envelope prompt discipline (design-context-format.ts): page data
 * NEVER ships as free-form markdown the agent could mistake for instructions.
 *
 * Budgeting invariant: the TRUSTED sections (numbered user notes + the
 * closing instruction) are emitted whole — the untrusted envelope and the
 * DESIGN.md block shrink to fit, never the user's feedback. The envelope is
 * fitted by measuring the REAL serialized string (no re-wrap of a truncated
 * preview, which would inflate escapes past the budget).
 */

const MAX_PROMPT_CHARS = 24_000;
const MAX_ENVELOPE_CHARS = 14_000;
const MIN_ENVELOPE_CHARS = 600;
const MAX_DESIGN_SYSTEM_CHARS = 10_000;
const MIN_DESIGN_SYSTEM_CHARS = 500;
const MAX_OUTER_HTML_CHARS = 300;
const MAX_TEXT_CHARS = 120;
const MAX_SELECTOR_CHARS = 512;
const MAX_STYLE_ENTRIES = 8;
const MAX_STYLE_VALUE_CHARS = 64;
const MAX_PAGE_URL_CHARS = 512;

/** Progressive per-comment display caps: the full 2k when it fits, tighter
 * when 20 long notes would otherwise crowd out the envelope. */
const COMMENT_DISPLAY_CAPS = [2_000, 1_000, 500, 250, 120] as const;

const PRIORITY_LABEL: Record<BrowserDesignAnnotationPriority, string> = {
  blocking: 'bloqueante',
  important: 'importante',
  suggestion: 'sugestão',
};

export interface DesignAnnotationsPromptInput {
  annotations: BrowserDesignAnnotation[];
  /** Workspace DESIGN.md (trusted, user-authored) — same rule as design-send. */
  designSystem?: string;
}

interface EnvelopeEntry {
  index: number;
  label: string;
  selector: string;
  rectCssPixels: { x: number; y: number; width: number; height: number };
  visibleText: string;
  outerHtml?: string;
  computedStyles?: string[];
  framework?: {
    name: string;
    component?: string;
    source?: string;
  };
}

function annotationEnvelopeEntry(
  annotation: BrowserDesignAnnotation,
  index: number,
): EnvelopeEntry {
  const { selection } = annotation;
  const hints = selection.frameworkHints;
  return {
    index: index + 1,
    label: safePageText(annotation.label, 160),
    selector: safePageText(selection.selector, MAX_SELECTOR_CHARS),
    rectCssPixels: {
      x: Math.round(selection.rect.x),
      y: Math.round(selection.rect.y),
      width: Math.round(selection.rect.width),
      height: Math.round(selection.rect.height),
    },
    visibleText: safePageText(selection.text, MAX_TEXT_CHARS),
    outerHtml: safeOuterHtml(selection.outerHtml, MAX_OUTER_HTML_CHARS),
    computedStyles: Object.entries(selection.computedStyles)
      .slice(0, MAX_STYLE_ENTRIES)
      .map(
        ([property, value]) =>
          `${safePageText(property, 64)}: ${safePageText(value, MAX_STYLE_VALUE_CHARS)}`,
      ),
    ...(hints
      ? {
          framework: {
            name: hints.framework,
            component: hints.componentName
              ? safePageText(hints.componentName, 128)
              : undefined,
            source: hints.source
              ? [
                  safePageText(hints.source.file, 512),
                  hints.source.line,
                  hints.source.column,
                ]
                  .filter((value) => value !== undefined)
                  .join(':')
              : undefined,
          },
        }
      : {}),
  };
}

/**
 * Fits the envelope INTO the given char budget by degrading gracefully —
 * drop outerHtml, then computed styles, then whole entries (tracking
 * `omittedEntries`) — always measuring the final serialized string.
 */
function fittedEnvelope(
  pageUrl: string,
  entries: EnvelopeEntry[],
  budget: number,
): string {
  const serialize = (list: EnvelopeEntry[], omitted: number): string =>
    JSON.stringify({
      pageUrl,
      annotations: list,
      ...(omitted > 0 ? { omittedEntries: omitted } : {}),
    });

  let current = entries;
  let serialized = serialize(current, 0);
  if (serialized.length <= budget) return serialized;

  current = current.map(({ outerHtml: _outerHtml, ...rest }) => rest);
  serialized = serialize(current, 0);
  if (serialized.length <= budget) return serialized;

  current = current.map(({ computedStyles: _styles, ...rest }) => rest);
  serialized = serialize(current, 0);
  if (serialized.length <= budget) return serialized;

  while (current.length > 1) {
    current = current.slice(0, -1);
    serialized = serialize(current, entries.length - current.length);
    if (serialized.length <= budget) return serialized;
  }
  // Last resort: an explicitly truncated single-entry envelope. slice() on
  // the URL/label only — never re-wrap a truncated JSON string in JSON.
  return serialize(
    [
      {
        index: 1,
        label: current[0]?.label.slice(0, 40) ?? '',
        selector: '',
        rectCssPixels: { x: 0, y: 0, width: 0, height: 0 },
        visibleText: '',
      },
    ],
    entries.length - 1,
  );
}

function annotationLine(
  annotation: BrowserDesignAnnotation,
  index: number,
  commentCap: number,
): string {
  const priority =
    annotation.priority !== 'suggestion'
      ? ` (${PRIORITY_LABEL[annotation.priority]})`
      : '';
  // The comment is user-typed in the IDE (trusted intent), but it still gets
  // the control-char scrub so a paste cannot smuggle escape sequences.
  const comment = safePageText(annotation.comment, commentCap);
  return `${index + 1}. [${DESIGN_ANNOTATION_INTENT_LABELS[annotation.intent]}]${priority} ${comment}`;
}

export function formatDesignAnnotationsPrompt(
  input: DesignAnnotationsPromptInput,
): string {
  if (input.annotations.length === 0) {
    throw new Error('no design annotations to format');
  }
  const pageUrl = safePageText(
    input.annotations[0].selection.url,
    MAX_PAGE_URL_CHARS,
  );

  const header = [
    `[Nexus Design] Feedback visual em lote do browser pane (${input.annotations.length} anotações)`,
    UNTRUSTED_PAGE_DATA_PREAMBLE,
  ];
  const instruction =
    'Para cada anotação: localize o código-fonte do elemento no workspace ' +
    '(selector/framework do bloco não confiável são apenas pistas) e aplique ' +
    'o que o comentário pede com a menor mudança possível. Itens [pergunta] ' +
    'pedem resposta, não edição; itens [aprovado] são registro, sem ação. ' +
    'Responda ponto a ponto, na mesma numeração.' +
    (input.designSystem?.trim()
      ? ' Alinhe qualquer UI gerada ao design system em BEGIN_DESIGN_SYSTEM.'
      : '');
  const notesHeader =
    'Anotações do usuário (digitadas no IDE; a numeração casa com os badges ' +
    'na página e com as entradas do bloco acima):';

  // Trusted sections first: pick the widest per-comment cap whose full notes
  // section still leaves the envelope its minimum room. User feedback is the
  // point of the prompt — it must never fall off the tail.
  const fixedOverhead =
    header.join('\n').length +
    UNTRUSTED_PAGE_DATA_BEGIN.length +
    UNTRUSTED_PAGE_DATA_END.length +
    notesHeader.length +
    instruction.length +
    64; // newlines/margin
  let notes: string[] = [];
  for (const cap of COMMENT_DISPLAY_CAPS) {
    notes = input.annotations.map((annotation, index) =>
      annotationLine(annotation, index, cap),
    );
    const notesLength = notes.join('\n').length;
    if (fixedOverhead + notesLength + MIN_ENVELOPE_CHARS <= MAX_PROMPT_CHARS) {
      break;
    }
  }
  const trustedLength = fixedOverhead + notes.join('\n').length;

  // DESIGN.md is trusted but droppable: it never displaces the user's notes
  // and never squeezes the envelope below its minimum.
  let designSystemBlock: string[] = [];
  if (input.designSystem?.trim()) {
    const room =
      MAX_PROMPT_CHARS - trustedLength - MIN_ENVELOPE_CHARS -
      DESIGN_SYSTEM_BEGIN.length - DESIGN_SYSTEM_END.length - 8;
    const budget = Math.min(MAX_DESIGN_SYSTEM_CHARS, room);
    if (budget >= MIN_DESIGN_SYSTEM_CHARS) {
      designSystemBlock = [
        DESIGN_SYSTEM_BEGIN,
        safePageText(input.designSystem, budget),
        DESIGN_SYSTEM_END,
      ];
    }
  }

  const envelopeBudget = Math.max(
    MIN_ENVELOPE_CHARS,
    Math.min(
      MAX_ENVELOPE_CHARS,
      MAX_PROMPT_CHARS - trustedLength - designSystemBlock.join('\n').length,
    ),
  );
  const envelope = fittedEnvelope(
    pageUrl,
    input.annotations.map(annotationEnvelopeEntry),
    envelopeBudget,
  );

  return [
    ...header,
    UNTRUSTED_PAGE_DATA_BEGIN,
    envelope,
    UNTRUSTED_PAGE_DATA_END,
    ...designSystemBlock,
    notesHeader,
    ...notes,
    instruction,
  ].join('\n');
}
