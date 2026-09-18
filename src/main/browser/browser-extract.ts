import type {
  BrowserExtractCandidates,
  BrowserExtractedField,
  BrowserExtractField,
  BrowserJudgmentSkipped,
} from '../../shared/browser-automation';
import type { JevQuestion, JevResult } from '../jev/jev-client';
import { judge } from '../jev/jev-client';
import { hasJevCredential } from '../jev/jev-secrets';
import { isJevSurfaceEnabled } from '../jev/jev-autopilot';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
} from '../jev/jev-decision-log';
import { USD_PER_INPUT_TOKEN } from '../jev/jev-pricing';

/**
 * `nexus_browser_extract` resolution: the page lists bounded candidates
 * (JSON-LD, label→value pairs, typed tokens) and the code picks — Jev only
 * breaks ties among real candidates or answers boolean/enum questions.
 * Jev NEVER invents a value: no confident candidate means `null`.
 */

const EXTRACT_JUDGE_TIMEOUT_MS = 4_000;
const EXTRACT_JEV_CANDIDATES_MAX = 12;
const EXTRACT_JEV_MIN_CONFIDENCE = 0.6;
const EXTRACT_PAIRS_STATE_MAX = 20;
const EXTRACT_EXCERPT_CHARS = 2_000;

export interface BrowserExtractDeps {
  jev?: typeof judge;
  jevEnabled?: () => boolean;
  jevReady?: () => boolean;
  recordDecision?: typeof recordJevDecision;
}

export interface BrowserExtractContext {
  url: string;
  title: string;
  /** Redacted visible-text excerpt for boolean/enum state. */
  excerpt?: string;
  sessionId?: string;
  missionId?: string;
}

function fold(value: string): string {
  return value
    .replace(/[\t\r\n ]+/g, ' ')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase();
}

/** pt-BR `1.234,56` and en `1,234.56`; bare `1.234` counts as thousands. */
export function coerceExtractNumber(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,-]/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    const groups = cleaned.split(',');
    normalized =
      groups.length === 2
        ? cleaned.replace(',', '.')
        : cleaned.replace(/,/g, '');
  } else if (lastDot >= 0) {
    const groups = cleaned.split('.');
    const looksLikeThousands =
      groups.length > 2 ||
      (groups.length === 2 &&
        groups[1].length === 3 &&
        groups[0].length >= 1);
    normalized = looksLikeThousands ? cleaned.replace(/\./g, '') : cleaned;
  } else {
    normalized = cleaned;
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

const MONTHS: Record<string, number> = {
  janeiro: 0, fevereiro: 1, 'março': 2, marco: 2, abril: 3, maio: 4,
  junho: 5, julho: 6, agosto: 7, setembro: 8, outubro: 9, novembro: 10,
  dezembro: 11,
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9,
  nov: 10, dec: 11,
};

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** ISO stays ISO; dd/mm/yyyy and pt/en month names → ISO; else the raw text. */
export function coerceExtractDate(raw: string): string {
  const text = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/.exec(text);
  if (dmy) {
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${year}-${pad2(Number(dmy[2]))}-${pad2(Number(dmy[1]))}`;
  }
  const pt = /^(\d{1,2})\s+de\s+([a-zç]+)\s+de\s+(\d{4})/i.exec(text);
  if (pt && MONTHS[pt[2].toLocaleLowerCase()] !== undefined) {
    return `${pt[3]}-${pad2(MONTHS[pt[2].toLocaleLowerCase()] + 1)}-${pad2(Number(pt[1]))}`;
  }
  const en = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i.exec(text);
  if (en && MONTHS[en[1].toLocaleLowerCase()] !== undefined) {
    return `${en[3]}-${pad2(MONTHS[en[1].toLocaleLowerCase()] + 1)}-${pad2(Number(en[2]))}`;
  }
  return text;
}

export function coerceExtractValue(
  raw: string,
  field: BrowserExtractField,
): string | number | boolean | null {
  switch (field.type) {
    case 'number':
      return coerceExtractNumber(raw);
    case 'date':
      return coerceExtractDate(raw);
    case 'boolean': {
      const folded = fold(raw);
      if (/^(sim|yes|true|1|on|checked)$/.test(folded)) return true;
      if (/^(não|nao|no|false|0|off|unchecked)$/.test(folded)) return false;
      return null;
    }
    case 'enum': {
      const folded = fold(raw);
      const hit = (field.enum ?? []).find(
        (option) => fold(option) === folded,
      );
      return hit ?? null;
    }
    default:
      return raw;
  }
}

interface JsonLdLeaf {
  key: string;
  value: unknown;
}

function collectJsonLdLeaves(
  value: unknown,
  depth: number,
  out: JsonLdLeaf[],
): void {
  if (out.length >= 200 || depth > 8 || value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) {
      collectJsonLdLeaves(item, depth + 1, out);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (
        child !== null &&
        typeof child === 'object' &&
        !Array.isArray(child)
      ) {
        collectJsonLdLeaves(child, depth + 1, out);
      } else if (Array.isArray(child)) {
        collectJsonLdLeaves(child, depth + 1, out);
      } else {
        out.push({ key, value: child });
      }
    }
  }
}

function jsonLdScalarCompatible(
  leaf: JsonLdLeaf,
  field: BrowserExtractField,
): boolean {
  const v = leaf.value;
  switch (field.type) {
    case 'number':
      return (
        (typeof v === 'number' && Number.isFinite(v)) ||
        (typeof v === 'string' && coerceExtractNumber(v) !== null)
      );
    case 'boolean':
      return (
        typeof v === 'boolean' ||
        (typeof v === 'string' && /^(true|false|sim|não|nao|yes|no)$/i.test(v))
      );
    case 'enum':
      return (
        typeof v === 'string' &&
        (field.enum ?? []).some((o) => fold(o) === fold(v))
      );
    case 'date':
      return typeof v === 'string' || typeof v === 'number';
    default:
      return (
        typeof v === 'string' ||
        typeof v === 'number' ||
        typeof v === 'boolean'
      );
  }
}

function jsonLdValue(
  leaf: JsonLdLeaf,
  field: BrowserExtractField,
): string | number | boolean | null {
  const v = leaf.value;
  if (field.type === 'number') {
    return typeof v === 'number' ? v : coerceExtractNumber(String(v));
  }
  if (field.type === 'boolean') {
    if (typeof v === 'boolean') return v;
    return /^(true|sim|yes)$/i.test(String(v));
  }
  if (field.type === 'enum') {
    return coerceExtractValue(String(v), field);
  }
  if (field.type === 'date') {
    return coerceExtractDate(String(v));
  }
  return String(v);
}

interface ExtractCandidate {
  label: string;
  value: string;
  source: 'pair' | 'token';
  ref?: string;
}

const NUMBER_TOKEN_KINDS = new Set(['number', 'money', 'percent']);

function fieldQuery(field: BrowserExtractField): string {
  return fold(`${field.name} ${field.hint ?? ''}`);
}

function labelMatchesField(label: string, query: string): boolean {
  if (!query) return false;
  const folded = fold(label);
  return (
    folded === query ||
    folded.startsWith(query) ||
    folded.includes(query) ||
    query.includes(folded)
  );
}

function tokenCompatible(
  token: BrowserExtractCandidates['tokens'][number],
  field: BrowserExtractField,
  query: string,
): boolean {
  if (field.type === 'number') return NUMBER_TOKEN_KINDS.has(token.kind);
  if (field.type === 'date') return token.kind === 'date';
  if (field.type !== 'string') return false;
  if (token.kind === 'email') return /mail|correio|e-mail/.test(query);
  return labelMatchesField(token.context, query);
}

export interface BrowserExtractResolution {
  fields: Record<string, BrowserExtractedField>;
  jev: { calls: number; skipped?: BrowserJudgmentSkipped };
}

const NONE_RESULT: BrowserExtractedField = {
  value: null,
  confidence: 0,
  source: 'none',
};

interface PendingJevField {
  /** Question id owned by this run: sanitized field name, unique. */
  qid: string;
  field: BrowserExtractField;
  kind: 'boolean' | 'enum' | 'candidates';
  pool?: ExtractCandidate[];
}

function sanitizeQuestionId(raw: string, taken: Set<string>): string {
  let qid = `f_${raw.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  let suffix = 2;
  while (taken.has(qid)) qid = `f_${raw.replace(/[^a-zA-Z0-9_]/g, '_')}_${suffix++}`;
  taken.add(qid);
  return qid;
}

function pendingQuestion(pending: PendingJevField): JevQuestion {
  const { field } = pending;
  const hint = field.hint ? `(${field.hint}) ` : '';
  if (pending.kind === 'boolean') {
    return {
      type: 'noul',
      instructions:
        `Does the visible page indicate that "${field.name}" ${hint}` +
        'is true / applies?',
    };
  }
  if (pending.kind === 'enum') {
    const criteria: Record<string, string | null> = {};
    for (const option of (field.enum ?? []).slice(0, 20)) {
      criteria[option] = option;
    }
    criteria['none'] = 'nenhuma opção corresponde';
    return {
      type: 'choice',
      instructions:
        `Which option best describes "${field.name}" ${hint}on this page?`,
      criteria,
    };
  }
  const criteria: Record<string, string | null> = {};
  (pending.pool ?? []).forEach((candidate, index) => {
    criteria[`c${index + 1}`] =
      `${candidate.label} → ${candidate.value} (${candidate.source})`.slice(
        0,
        256,
      );
  });
  criteria['none'] = 'nenhum candidato é este campo';
  return {
    type: 'choice',
    instructions:
      `Which candidate is the value of "${field.name}" ${hint}` +
      '? Pick none if none matches.',
    criteria,
  };
}

function applyJevAnswer(
  pending: PendingJevField,
  answer: JevResult['answers'][string] | undefined,
): BrowserExtractedField {
  const { field } = pending;
  if (pending.kind === 'boolean') {
    if (answer?.type === 'noul') {
      return {
        value: answer.noul >= 0.6,
        confidence: Math.abs(answer.noul - 0.5) * 2,
        source: 'jev',
      };
    }
    return NONE_RESULT;
  }
  if (pending.kind === 'enum') {
    if (
      answer?.type === 'choice' &&
      answer.choice !== 'none' &&
      answer.confidence >= EXTRACT_JEV_MIN_CONFIDENCE &&
      (field.enum ?? []).includes(answer.choice)
    ) {
      return { value: answer.choice, confidence: answer.confidence, source: 'jev' };
    }
    return NONE_RESULT;
  }
  if (
    answer?.type === 'choice' &&
    answer.choice !== 'none' &&
    answer.confidence >= EXTRACT_JEV_MIN_CONFIDENCE
  ) {
    const index = Number(answer.choice.replace(/^c/, '')) - 1;
    const chosen = pending.pool?.[index];
    if (chosen) {
      const coerced = coerceExtractValue(chosen.value, field);
      if (coerced !== null) {
        return {
          value: coerced,
          confidence: answer.confidence,
          source: 'jev',
          ...(chosen.ref ? { ref: chosen.ref } : {}),
        };
      }
    }
  }
  return NONE_RESULT;
}

export async function resolveBrowserExtract(
  candidates: BrowserExtractCandidates,
  fields: BrowserExtractField[],
  context: BrowserExtractContext,
  deps: BrowserExtractDeps = {},
): Promise<BrowserExtractResolution> {
  const judgeFn = deps.jev ?? judge;
  const jevEnabled = deps.jevEnabled ?? (() => isJevSurfaceEnabled('browserTool'));
  const jevReady = deps.jevReady ?? hasJevCredential;
  const record = deps.recordDecision ?? recordJevDecision;

  const out: Record<string, BrowserExtractedField> = {};
  let jevCalls = 0;
  let jevSkipped: BrowserJudgmentSkipped | undefined;

  const jevUsable = (): boolean => {
    if (!jevEnabled()) {
      jevSkipped = 'surface-disabled';
      return false;
    }
    if (!jevReady()) {
      jevSkipped = 'no-credential';
      return false;
    }
    return true;
  };

  const jsonLdLeaves: JsonLdLeaf[] = [];
  for (const doc of candidates.jsonLd.slice(0, 3)) {
    collectJsonLdLeaves(doc, 0, jsonLdLeaves);
  }

  // Pass 1 — deterministic resolution; fields that NEED Jev are collected.
  const pending: PendingJevField[] = [];
  const takenQids = new Set<string>();
  const scopedFields = fields.slice(0, 20);
  for (const field of scopedFields) {
    const query = fieldQuery(field);
    const queryWords = query.split(' ').filter((w) => w.length >= 2);

    // (a) JSON-LD leaf: key equals the field name or a hint word.
    const leaf = jsonLdLeaves.find(
      (l) =>
        (fold(l.key) === fold(field.name) || queryWords.includes(fold(l.key))) &&
        jsonLdScalarCompatible(l, field),
    );
    if (leaf) {
      const value = jsonLdValue(leaf, field);
      if (value !== null) {
        out[field.name] = { value, confidence: 1, source: 'json-ld' };
        continue;
      }
    }

    if (field.type === 'boolean' || field.type === 'enum') {
      pending.push({
        qid: sanitizeQuestionId(field.name, takenQids),
        field,
        kind: field.type,
      });
      continue;
    }

    // (b) pairs + tokens → candidates.
    const pool: ExtractCandidate[] = [];
    for (const pair of candidates.pairs) {
      if (pool.length >= EXTRACT_JEV_CANDIDATES_MAX) break;
      if (!labelMatchesField(pair.label, query)) continue;
      pool.push({
        label: pair.label,
        value: pair.value,
        source: 'pair',
        ...(pair.ref ? { ref: pair.ref } : {}),
      });
    }
    for (const token of candidates.tokens) {
      if (pool.length >= EXTRACT_JEV_CANDIDATES_MAX) break;
      if (!tokenCompatible(token, field, query)) continue;
      pool.push({
        label: token.context,
        value: token.text,
        source: 'token',
      });
    }

    if (pool.length === 0) {
      out[field.name] = NONE_RESULT;
      continue;
    }
    if (pool.length === 1) {
      const coerced = coerceExtractValue(pool[0].value, field);
      out[field.name] =
        coerced === null
          ? NONE_RESULT
          : {
              value: coerced,
              confidence: 0.8,
              source: pool[0].source,
              ...(pool[0].ref ? { ref: pool[0].ref } : {}),
            };
      continue;
    }
    pending.push({
      qid: sanitizeQuestionId(field.name, takenQids),
      field,
      kind: 'candidates',
      pool,
    });
  }

  // Pass 2 — ONE Jev call for every field that still needs judgment.
  if (pending.length > 0) {
    let result: JevResult | null = null;
    if (jevUsable()) {
      const questions: Record<string, JevQuestion> = {};
      for (const entry of pending) {
        questions[entry.qid] = pendingQuestion(entry);
      }
      const fieldsState: Record<string, unknown> = {};
      for (const entry of pending) {
        fieldsState[entry.field.name] = {
          type: entry.field.type,
          hint: entry.field.hint ?? '',
        };
      }
      try {
        result = await judgeFn({
          state: {
            url: context.url,
            title: context.title,
            excerpt: (context.excerpt ?? '').slice(0, EXTRACT_EXCERPT_CHARS),
            pairs: candidates.pairs.slice(0, EXTRACT_PAIRS_STATE_MAX),
            fields: fieldsState,
          },
          questions,
          timeoutMs: EXTRACT_JUDGE_TIMEOUT_MS,
          surface: 'browserTool',
          sessionId: context.sessionId,
          missionId: context.missionId,
        });
      } catch {
        result = null;
      }
      if (!result) {
        jevSkipped = 'judge-unavailable';
      } else {
        jevCalls = 1;
        record({
          surface: 'browserTool',
          sessionId: context.sessionId,
          missionId: context.missionId,
          model: result.model,
          questions: Object.keys(questions),
          probabilities: jevAnswerProbabilities(result.answers),
          confidence: jevAnswerConfidences(result.answers),
          decision:
            `extract:${pending.map((entry) => entry.field.name).join(',')}`.slice(0, 200),
          inputTokens: result.usage.input_tokens,
          usd: result.usage.input_tokens * USD_PER_INPUT_TOKEN,
        });
      }
    }
    for (const entry of pending) {
      out[entry.field.name] = applyJevAnswer(entry, result?.answers[entry.qid]);
    }
  }

  return {
    fields: out,
    jev: {
      calls: jevCalls,
      ...(jevSkipped && jevCalls === 0 ? { skipped: jevSkipped } : {}),
    },
  };
}
