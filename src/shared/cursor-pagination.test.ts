import { describe, expect, it } from 'vitest';
import {
  clampPageSize,
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  selectCursorPage,
  CURSOR_MAX_LENGTH,
} from './cursor-pagination';

type Row = { seq: number; id: string };

const rows: Row[] = Array.from({ length: 10 }, (_, i) => ({
  seq: 10 - i,
  id: `r${10 - i}`,
}));

const keyOf = (r: Row) => r.seq;
const idOf = (r: Row) => r.id;

describe('cursor pagination (T3 policy)', () => {
  it('encode/decode is stable and versioned', () => {
    const cursor = encodeCursor({ key: 7, id: 'r7' });
    expect(decodeCursor(cursor)).toEqual({ v: 1, k: 7, i: 'r7' });
  });

  it('rejects absurd cursors before base64/JSON', () => {
    expect(() => decodeCursor('')).toThrow(InvalidCursorError);
    expect(() => decodeCursor('x'.repeat(CURSOR_MAX_LENGTH + 1))).toThrow(
      InvalidCursorError,
    );
    expect(() => decodeCursor('!!!not-base64!!!')).toThrow(InvalidCursorError);
  });

  it('rejects an explicitly empty cursor instead of restarting the first page', () => {
    expect(() => selectCursorPage(rows, { cursor: '', keyOf, idOf })).toThrow(InvalidCursorError);
  });

  it('rejects a cursor from another slice instead of skipping silently', () => {
    expect(() =>
      selectCursorPage(rows, {
        limit: 3,
        cursor: encodeCursor({ key: 99, id: 'ghost' }),
        keyOf,
        idOf,
      }),
    ).toThrow(/does not match any row/);
  });

  it('pages through the whole list with nextCursor and hasMoreHistory', () => {
    const first = selectCursorPage(rows, { limit: 4, keyOf, idOf });
    expect(first.items.map((r) => r.id)).toEqual(['r10', 'r9', 'r8', 'r7']);
    expect(first.hasMoreHistory).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = selectCursorPage(rows, {
      limit: 4,
      cursor: first.nextCursor,
      keyOf,
      idOf,
    });
    expect(second.items.map((r) => r.id)).toEqual(['r6', 'r5', 'r4', 'r3']);
    expect(second.hasMoreHistory).toBe(true);

    const third = selectCursorPage(rows, {
      limit: 4,
      cursor: second.nextCursor,
      keyOf,
      idOf,
    });
    expect(third.items.map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(third.hasMoreHistory).toBe(false);
    expect(third.nextCursor).toBeNull();
  });

  it('exact multiple of page size ends cleanly', () => {
    const first = selectCursorPage(rows, { limit: 5, keyOf, idOf });
    expect(first.hasMoreHistory).toBe(true);
    const second = selectCursorPage(rows, {
      limit: 5,
      cursor: first.nextCursor,
      keyOf,
      idOf,
    });
    expect(second.items).toHaveLength(5);
    expect(second.hasMoreHistory).toBe(false);
  });

  it('clampPageSize honors the T3-style caps', () => {
    expect(clampPageSize(undefined)).toBe(50);
    expect(clampPageSize(0)).toBe(50);
    expect(clampPageSize(10)).toBe(10);
    expect(clampPageSize(9999)).toBe(200);
    expect(clampPageSize('nope')).toBe(50);
  });

  it('tie-break by id keeps keyset stable on equal keys', () => {
    const tied: Row[] = [
      { seq: 1, id: 'b' },
      { seq: 1, id: 'a' },
      { seq: 0, id: 'c' },
    ];
    const first = selectCursorPage(tied, {
      limit: 1,
      keyOf,
      idOf,
    });
    expect(first.items[0]?.id).toBe('b');
    const second = selectCursorPage(tied, {
      limit: 1,
      cursor: first.nextCursor,
      keyOf,
      idOf,
    });
    expect(second.items[0]?.id).toBe('a');
  });
});
