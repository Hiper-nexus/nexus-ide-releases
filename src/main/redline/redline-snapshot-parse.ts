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
import type { QuotaReadHint, QuotaWindowKind } from '../../shared/quota-types';

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

const READ_HINTS: ReadonlySet<string> = new Set<QuotaReadHint>([
  'auth-expired', 'identity-mismatch', 'no-credential',
  'cli-missing', 'unavailable', 'quota-key-required',
]);

// Controles C0/C1, DEL, marcas e overrides bidi, espaços de largura zero,
// separadores de linha/parágrafo e a marca de ordem de bytes. Escapes \u de
// propósito: caractere invisível literal some em editor e em linter.
const INVISIBLE =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
const WHITESPACE_RUN = /\s+/g;
// Quantificadores LIMITADOS: com `+` livre este padrão é quadrático (80 mil
// caracteres sem '@' levavam ~6 s) e o texto vem de um arquivo não confiável.
// Os tetos cobrem endereço real (local 64, domínio 255, TLD 63).
const EMAIL_LIKE =
  /[^\s@<>()[\]{}",;:]{1,64}@[^\s@<>()[\]{}",;:]{1,255}\.[^\s@<>()[\]{}",;:]{1,63}/g;
// Forma exata que `maskEmail` produz: só ela passa como "já mascarado".
const MASKED_EMAIL = /^[^*\s@]{0,2}\*{4}@[^*\s@]\*{2}(?:\.[^*\s@]{1,63})?$/;
/** Sobra para o que a limpeza remove (espaços, invisíveis) antes do teto. */
const RAW_SLICE_FACTOR = 4;
const RAW_SLICE_EXTRA = 32;
const MAX_ADAPTER_ID_CHARS = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Substitui e-mail inteiro por versão mascarada; só a forma exata do mascarado passa. */
function scrubEmails(text: string): string {
  return text.replace(EMAIL_LIKE, (match) =>
    MASKED_EMAIL.test(match) ? match : (maskEmail(match) ?? '***'),
  );
}

/** Corta o texto cru num teto proporcional ao de exibição, sem partir par substituto. */
function boundedRaw(value: string, maxCodePoints: number): string {
  const limit = maxCodePoints * RAW_SLICE_FACTOR + RAW_SLICE_EXTRA;
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Texto de exibição seguro para um item de menu: sem controle/bidi/zero-width,
 * espaços colapsados, e-mail inteiro re-mascarado, teto em code points (nunca
 * parte um par substituto). Não-string vira vazio. O custo é limitado pelo
 * teto, não pelo tamanho da entrada: o corte vem ANTES de qualquer regex.
 */
export function sanitizeDisplayText(value: unknown, maxCodePoints: number): string {
  if (typeof value !== 'string') return '';
  const cleaned = scrubEmails(
    boundedRaw(value, maxCodePoints).replace(INVISIBLE, '').replace(WHITESPACE_RUN, ' ').trim(),
  );
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

/** Id do provedor aparece em menu e tooltip: é texto de exibição, não só chave. */
function readAdapterId(value: unknown): string {
  return sanitizeDisplayText(value, MAX_ADAPTER_ID_CHARS);
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
  if (raw.estimated === true && window.usedRatio !== null) window.estimated = true;
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
  const adapterId = readAdapterId(raw.adapterId);
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
  if (typeof raw.readHint === 'string' && READ_HINTS.has(raw.readHint)) {
    entry.readHint = raw.readHint as QuotaReadHint;
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
  const adapterId = readAdapterId(raw.adapterId);
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
