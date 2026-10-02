/** Cursor opaco da lista do admin: a posição (created_at, id) do último item entregue. */
export interface ListCursor { readonly createdAt: number; readonly id: string }

const CURSOR_FORMAT = /^(\d{1,16}):([0-9a-f-]{36})$/;

export function encodeCursor(cursor: ListCursor): string {
  return btoa(`${cursor.createdAt}:${cursor.id}`).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Nulo para qualquer valor que não tenha saído de encodeCursor: a lista responde 400 em vez de adivinhar. */
export function decodeCursor(value: string): ListCursor | null {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(value)) return null;
  let decoded: string;
  try { decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/')); } catch { return null; }
  const match = CURSOR_FORMAT.exec(decoded);
  return match ? { createdAt: Number(match[1]), id: match[2]! } : null;
}
