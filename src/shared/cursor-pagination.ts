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
}

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
}): string {
  const payload: CursorPayload = { v: 1, k: input.key, i: input.id };
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
    typeof (parsed as { i: unknown }).i !== 'string'
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

/**
 * Recorta uma página keyset a partir de uma lista já ordenada (mais novo
 * primeiro OU mais velho primeiro — a ordem é a do `sorted`). `cursor` aponta
 * para o último item devolvido na página anterior; a página seguinte começa
 * DEPOIS dele. `+2` linhas extras provam `hasMoreHistory` sem segunda query.
 */
export function selectCursorPage<T>(
  sorted: readonly T[],
  options: {
    readonly limit?: number;
    readonly cursor?: string | null;
    readonly keyOf: (item: T) => string | number;
    readonly idOf: (item: T) => string;
  },
): CursorPage<T> {
  const limit = clampPageSize(options.limit);
  let start = 0;
  if (options.cursor !== undefined && options.cursor !== null) {
    const decoded = decodeCursor(options.cursor);
    const index = sorted.findIndex(
      (item) =>
        options.keyOf(item) === decoded.k &&
        options.idOf(item) === decoded.i,
    );
    if (index >= 0) start = index + 1;
    else {
      // Cursor de outra fatia: rejeita em vez de pular linhas em silêncio.
      throw new InvalidCursorError('cursor does not match any row in this slice');
    }
  }
  const window = sorted.slice(start, start + limit + 1);
  const hasMoreHistory = window.length > limit;
  const items = hasMoreHistory ? window.slice(0, limit) : window;
  const last = items[items.length - 1];
  const nextCursor =
    hasMoreHistory && last
      ? encodeCursor({ key: options.keyOf(last), id: options.idOf(last) })
      : null;
  return { items, nextCursor, hasMoreHistory };
}
