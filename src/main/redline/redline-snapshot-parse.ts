/**
 * Nexus Redline (Linux) — leitura defensiva de `redline-last-good.json`.
 *
 * O arquivo é produzido pelo próprio Nexus (`redline-sink.ts`), mas quem lê
 * nunca confia nele: pode estar truncado, corrompido, de outra versão ou
 * editado à mão. Este módulo é o ÚNICO ponto de entrada dos bytes do arquivo
 * para a bandeja: valida forma, tipos e faixas, descarta campo desconhecido
 * (nada de token/segredo sobrevive à leitura), limpa texto de exibição e
 * re-mascara qualquer e-mail inteiro que tenha escapado do contrato.
 *
 * Puro: sem fs, sem electron. O teto de tamanho vale em BYTES.
 */

import {
  REDLINE_SNAPSHOT_FORMAT_VERSION,
  maskEmail,
  type RedlineDecisiveWindow,
  type RedlineEntry,
  type RedlineRankingRow,
  type RedlineSnapshotFile,
  type RedlineWindow,
} from '../../shared/redline-types';
import type { QuotaWindowKind } from '../../shared/quota-types';

/** Snapshot real tem poucos KB por conta; 1 MiB é folga de sobra e barra abuso. */
export const REDLINE_SNAPSHOT_MAX_BYTES = 1024 * 1024;
export const REDLINE_MAX_ENTRIES = 200;
export const REDLINE_MAX_WINDOWS = 12;
export const REDLINE_MAX_RANKING_ROWS = 500;
export const REDLINE_MAX_STATUS_BAR_IDS = 50;

const MAX_ID_CHARS = 200;
const MAX_LABEL_CHARS = 120;
const MAX_WINDOW_LABEL_CHARS = 40;
const MAX_RANKING_ADAPTERS = 100;

const WINDOW_KINDS: ReadonlySet<string> = new Set<QuotaWindowKind>([
  'session',
  'hours',
  'weekly',
  'monthly',
  'credits',
  'local',
]);

const EXCLUDED_REASONS: ReadonlySet<string> = new Set([
  'no-credential',
  'needs-relogin',
  'cooldown',
  'unknown-usage',
]);

// Controles C0/C1, DEL, marcas e overrides bidi, espaços de largura zero,
// separadores de linha/parágrafo e a marca de ordem de bytes.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁯﻿]/g;
const WHITESPACE_RUN = /\s+/g;
const EMAIL_LIKE = /[^\s@<>()[\]{}"',;:]+@[^\s@<>()[\]{}"',;:]+\.[^\s@<>()[\]{}"',;:]+/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Substitui e-mail inteiro por versão mascarada; o já mascarado (`*`) passa. */
function scrubEmails(text: string): string {
  return text.replace(EMAIL_LIKE, (match) =>
    match.includes('*') ? match : (maskEmail(match) ?? '***'),
  );
}

/**
 * Texto de exibição seguro para um item de menu: sem controle/bidi/zero-width,
 * espaços colapsados, e-mail inteiro re-mascarado, teto em code points (nunca
 * parte um par substituto). Não-string vira vazio.
 */
export function sanitizeDisplayText(value: unknown, maxCodePoints: number): string {
  if (typeof value !== 'string') return '';
  const cleaned = scrubEmails(value.replace(INVISIBLE, '').replace(WHITESPACE_RUN, ' ').trim());
  const points = Array.from(cleaned);
  if (points.length <= maxCodePoints) return cleaned;
  return `${points.slice(0, Math.max(0, maxCodePoints - 1)).join('')}…`;
}

/** Fração usada: fora de 0..1 só aceita >1 (esgotado → 1); o resto é desconhecido. */
function readRatio(value: unknown): number | null {
  if (!isFiniteNumber(value) || value < 0) return null;
  return value > 1 ? 1 : value;
}

function readId(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.length > MAX_ID_CHARS ? '' : value.replace(INVISIBLE, '').trim();
}

function readWindow(raw: unknown): RedlineWindow | null {
  if (!isRecord(raw)) return null;
  const kind = typeof raw.kind === 'string' && WINDOW_KINDS.has(raw.kind) ? raw.kind : 'local';
  const window: RedlineWindow = {
    kind: kind as QuotaWindowKind,
    label: sanitizeDisplayText(raw.label, MAX_WINDOW_LABEL_CHARS),
    usedRatio: readRatio(raw.usedRatio),
  };
  if (isFiniteNumber(raw.resetsAt) && raw.resetsAt > 0) window.resetsAt = raw.resetsAt;
  return window;
}

function readDecisive(raw: unknown): RedlineDecisiveWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const ratio = readRatio(raw.effectiveUsedRatio);
  if (ratio === null) return undefined;
  const decisive: RedlineDecisiveWindow = {
    label: sanitizeDisplayText(raw.label, MAX_WINDOW_LABEL_CHARS),
    effectiveUsedRatio: ratio,
  };
  if (isFiniteNumber(raw.resetsAt) && raw.resetsAt > 0) decisive.resetsAt = raw.resetsAt;
  return decisive;
}

function readEntry(raw: unknown): RedlineEntry | null {
  if (!isRecord(raw)) return null;
  const id = readId(raw.id);
  const adapterId = readId(raw.adapterId);
  if (id === '' || adapterId === '') return null;
  const windows = (Array.isArray(raw.windows) ? raw.windows : [])
    .slice(0, REDLINE_MAX_WINDOWS * 4)
    .map(readWindow)
    .filter((window): window is RedlineWindow => window !== null)
    .slice(0, REDLINE_MAX_WINDOWS);
  const entry: RedlineEntry = {
    id,
    adapterId,
    label: sanitizeDisplayText(raw.label, MAX_LABEL_CHARS),
    active: raw.active === true,
    installed: raw.installed === true,
    onCooldown: raw.onCooldown === true,
    windows,
    updatedAt: isFiniteNumber(raw.updatedAt) ? raw.updatedAt : 0,
    eligible: raw.eligible === true,
  };
  const accountId = readId(raw.accountId);
  if (accountId !== '') entry.accountId = accountId;
  const email = sanitizeDisplayText(raw.emailMasked, MAX_LABEL_CHARS);
  if (email !== '') entry.emailMasked = email;
  if (isFiniteNumber(raw.cooldownUntil) && raw.cooldownUntil > 0) {
    entry.cooldownUntil = raw.cooldownUntil;
  }
  if (typeof raw.excludedReason === 'string' && EXCLUDED_REASONS.has(raw.excludedReason)) {
    entry.excludedReason = raw.excludedReason as RedlineEntry['excludedReason'];
  }
  const headroom = readRatio(raw.headroom);
  if (headroom !== null) entry.headroom = headroom;
  const decisive = readDecisive(raw.decisiveWindow);
  if (decisive) entry.decisiveWindow = decisive;
  return entry;
}

function readRankingRow(raw: unknown): RedlineRankingRow | null {
  if (!isRecord(raw)) return null;
  const entryId = readId(raw.entryId);
  const adapterId = readId(raw.adapterId);
  const headroom = readRatio(raw.headroom);
  if (entryId === '' || adapterId === '' || headroom === null) return null;
  const row: RedlineRankingRow = {
    entryId,
    adapterId,
    label: sanitizeDisplayText(raw.label, MAX_LABEL_CHARS),
    headroom,
  };
  const email = sanitizeDisplayText(raw.emailMasked, MAX_LABEL_CHARS);
  if (email !== '') row.emailMasked = email;
  const decisive = readDecisive(raw.decisiveWindow);
  if (decisive) row.decisiveWindow = decisive;
  if (isFiniteNumber(raw.minutesToReset) && raw.minutesToReset >= 0) {
    row.minutesToReset = raw.minutesToReset;
  }
  return row;
}

function readRanking(raw: unknown): Record<string, RedlineRankingRow[]> {
  // Sem protótipo: chave hostil (`__proto__`, `constructor`) vira dado, nunca atalho.
  const ranking: Record<string, RedlineRankingRow[]> = Object.create(null) as Record<
    string,
    RedlineRankingRow[]
  >;
  if (!isRecord(raw)) return ranking;
  let budget = REDLINE_MAX_RANKING_ROWS;
  for (const [adapterId, rows] of Object.entries(raw).slice(0, MAX_RANKING_ADAPTERS)) {
    if (adapterId === '__proto__' || !Array.isArray(rows) || budget <= 0) continue;
    const parsed = rows
      .slice(0, budget)
      .map(readRankingRow)
      .filter((row): row is RedlineRankingRow => row !== null);
    budget -= parsed.length;
    if (parsed.length > 0) ranking[adapterId] = parsed;
  }
  return ranking;
}

function readWorst(raw: unknown): number | null {
  return readRatio(raw);
}

/**
 * Texto cru do arquivo → snapshot validado, ou `null` quando não há nada
 * confiável para mostrar (vazio, corrompido, versão desconhecida, sem conta).
 * Nunca lança.
 */
export function parseRedlineSnapshot(text: string): RedlineSnapshotFile | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  // Barato antes do caro: length (UTF-16) é limite inferior dos bytes.
  if (text.length > REDLINE_SNAPSHOT_MAX_BYTES) return null;
  if (Buffer.byteLength(text, 'utf8') > REDLINE_SNAPSHOT_MAX_BYTES) return null;

  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(root)) return null;
  if (root.formatVersion !== REDLINE_SNAPSHOT_FORMAT_VERSION) return null;
  if (!Array.isArray(root.entries)) return null;

  const entries = root.entries
    .slice(0, REDLINE_MAX_ENTRIES * 2)
    .map(readEntry)
    .filter((entry): entry is RedlineEntry => entry !== null)
    .slice(0, REDLINE_MAX_ENTRIES);
  if (entries.length === 0) return null;

  const statusBarEntryIds = (Array.isArray(root.statusBarEntryIds) ? root.statusBarEntryIds : [])
    .filter((id): id is string => typeof id === 'string')
    .map(readId)
    .filter((id) => id !== '')
    .slice(0, REDLINE_MAX_STATUS_BAR_IDS);

  return {
    formatVersion: REDLINE_SNAPSHOT_FORMAT_VERSION,
    generatedBy: 'nexus',
    updatedAt: isFiniteNumber(root.updatedAt) ? root.updatedAt : 0,
    worstUsedRatio: readWorst(root.worstUsedRatio),
    entries,
    ranking: readRanking(root.ranking),
    statusBarEntryIds,
  };
}
