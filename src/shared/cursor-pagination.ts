/**
 * Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
 * Copyright (c) 2026 T3 Tools Inc. — MIT License.
 * See third_party/licenses/t3code-MIT.txt.
 * Source: apps/server/src/orchestration-v2/threadHistoryPaging.ts.
 * Nexus changes: generic timestamp/id cursor, item-only page limits, slice validation;
 * no thread projection, byte budget or Effect dependency.
 */
/**
 * Paginação por cursor (porte da política T3 `threadHistoryPaging.ts` @
 * 26285ab; casca pura, sem Effect).
 *
 * Cursor = base64url de JSON versionado. Absurdos são recusados ANTES de
 * base64/JSON (teto de bytes). A página devolve `nextCursor` e
 * `hasMoreHistory`; linhas extras provam que há mais uma página.
 */

export const CURSOR_PAGE_DEFAULT_MAX_ITEMS = 50;
export const CURSOR_PAGE_MAX_ITEMS = 200;
/** Recusa cursors absurdos antes de base64/JSON. */
export const CURSOR_MAX_LENGTH = 4_096;

export interface CursorPayload {
  readonly v: 1;
  /** Âncora estável: sequence/timestamp do último item da página. */
  readonly k: string | number;
  /** Tie-break: id do último item (evita pular empate de keyset). */
  readonly i: string;
  /**
   * Digest do recorte da consulta (missão, filtros, ids, painéis).
   * Um cursor de outro recorte é recusado em vez de pular linhas.
   */
  readonly s: string;
}

const CURSOR_SLICE_MAX_LENGTH = 128;

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMoreHistory: boolean;
}

export class InvalidCursorError extends Error {
  readonly _tag = 'InvalidCursorError';
  constructor(message = 'Invalid cursor.') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

export function encodeCursor(input: {
  readonly key: string | number;
  readonly id: string;
  readonly slice: string;
}): string {
  if (
    input.slice.length === 0 ||
    input.slice.length > CURSOR_SLICE_MAX_LENGTH
  ) {
    throw new InvalidCursorError('cursor slice is missing');
  }
  const payload: CursorPayload = {
    v: 1,
    k: input.key,
    i: input.id,
    s: input.slice,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  if (cursor.length === 0 || cursor.length > CURSOR_MAX_LENGTH) {
    throw new InvalidCursorError();
  }
  let parsed: unknown;
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new InvalidCursorError();
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('v' in parsed) ||
    (parsed as { v: unknown }).v !== 1 ||
    !('k' in parsed) ||
    (typeof (parsed as { k: unknown }).k !== 'string' &&
      typeof (parsed as { k: unknown }).k !== 'number') ||
    !('i' in parsed) ||
    typeof (parsed as { i: unknown }).i !== 'string' ||
    !('s' in parsed) ||
    typeof (parsed as { s: unknown }).s !== 'string' ||
    (parsed as { s: string }).s.length === 0 ||
    (parsed as { s: string }).s.length > CURSOR_SLICE_MAX_LENGTH
  ) {
    throw new InvalidCursorError();
  }
  return parsed as CursorPayload;
}

export function clampPageSize(limit: unknown): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : NaN;
  if (!Number.isFinite(n) || n <= 0) return CURSOR_PAGE_DEFAULT_MAX_ITEMS;
  return Math.min(n, CURSOR_PAGE_MAX_ITEMS);
}

function compareCursorValue(left: string | number, right: string | number): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export type CursorSortOrder = 'asc' | 'desc';

function inferKeyOrder<T>(
  sorted: readonly T[],
  keyOf: (item: T) => string | number,
): CursorSortOrder {
  for (let index = 1; index < sorted.length; index += 1) {
    const cmp = compareCursorValue(
      keyOf(sorted[index - 1]!),
      keyOf(sorted[index]!),
    );
    if (cmp < 0) return 'asc';
    if (cmp > 0) return 'desc';
  }
  return 'asc';
}

function inferIdOrder<T>(
  sorted: readonly T[],
  keyOf: (item: T) => string | number,
  idOf: (item: T) => string,
  keyOrder: CursorSortOrder,
): CursorSortOrder {
  for (let index = 1; index < sorted.length; index += 1) {
    if (
      compareCursorValue(keyOf(sorted[index - 1]!), keyOf(sorted[index]!)) !==
      0
    ) {
      continue;
    }
    const cmp = compareCursorValue(
      idOf(sorted[index - 1]!),
      idOf(sorted[index]!),
    );
    if (cmp < 0) return 'asc';
    if (cmp > 0) return 'desc';
  }
  return keyOrder;
}

function isAfterCursor<T>(
  item: T,
  decoded: CursorPayload,
  keyOf: (item: T) => string | number,
  idOf: (item: T) => string,
  keyOrder: CursorSortOrder,
  idOrder: CursorSortOrder,
): boolean {
  const keyCmp = compareCursorValue(keyOf(item), decoded.k);
  if (keyCmp !== 0) {
    return keyOrder === 'asc' ? keyCmp > 0 : keyCmp < 0;
  }
  const idCmp = compareCursorValue(idOf(item), decoded.i);
  if (idCmp === 0) return false;
  return idOrder === 'asc' ? idCmp > 0 : idCmp < 0;
}

/**
 * Recorta uma página keyset a partir de uma lista já ordenada (mais novo
 * primeiro OU mais velho primeiro — a ordem é a do `sorted`, ou `order`
 * quando a lista filtrada não deixa a direção óbvia). `cursor` aponta para
 * o último item devolvido na página anterior; a página seguinte começa na
 * primeira linha DEPOIS de `(k, i)`, mesmo se aquela linha já saiu do
 * filtro. Cursor ilegível (vazio, longo demais, base64/JSON/versão errados,
 * sem digest, ou digest de outro recorte) é `InvalidCursorError`. `+1`
 * linha extra prova `hasMoreHistory`.
 */
export function selectCursorPage<T>(
  sorted: readonly T[],
  options: {
    readonly limit?: number;
    readonly cursor?: string | null;
    readonly keyOf: (item: T) => string | number;
    readonly idOf: (item: T) => string;
    readonly order?: CursorSortOrder;
    /** Digest do recorte desta consulta. Obrigatório. */
    readonly slice: string;
  },
): CursorPage<T> {
  if (
    options.slice.length === 0 ||
    options.slice.length > CURSOR_SLICE_MAX_LENGTH
  ) {
    throw new InvalidCursorError('cursor slice is missing');
  }
  const limit = clampPageSize(options.limit);
  let start = 0;
  if (options.cursor !== undefined && options.cursor !== null) {
    const decoded = decodeCursor(options.cursor);
    if (decoded.s !== options.slice) {
      throw new InvalidCursorError('cursor does not match this slice');
    }
    const keyOrder = options.order ?? inferKeyOrder(sorted, options.keyOf);
    const idOrder =
      options.order ??
      inferIdOrder(sorted, options.keyOf, options.idOf, keyOrder);
    const found = sorted.findIndex((item) =>
      isAfterCursor(
        item,
        decoded,
        options.keyOf,
        options.idOf,
        keyOrder,
        idOrder,
      ),
    );
    start = found < 0 ? sorted.length : found;
  }
  const window = sorted.slice(start, start + limit + 1);
  const hasMoreHistory = window.length > limit;
  const items = hasMoreHistory ? window.slice(0, limit) : window;
  const last = items[items.length - 1];
  const nextCursor =
    hasMoreHistory && last
      ? encodeCursor({
          key: options.keyOf(last),
          id: options.idOf(last),
          slice: options.slice,
        })
      : null;
  return { items, nextCursor, hasMoreHistory };
}
