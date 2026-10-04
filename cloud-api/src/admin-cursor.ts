/** Cursor opaco da lista de contas: (created_at, id) do último item entregue.
 * A ordem da lista é created_at DESC, id ASC, então a página seguinte começa depois desse par. */
export interface AccountListCursor { readonly createdAt: number; readonly id: string }

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CURSOR_FORMAT = /^(\d{1,16}):([A-Za-z0-9_-]{1,64})$/;

export function encodeAccountCursor(cursor: AccountListCursor): string {
  if (!Number.isSafeInteger(cursor.createdAt) || cursor.createdAt < 0 || !ACCOUNT_ID.test(cursor.id)) throw new Error('cursor de conta inválido');
  return btoa(`${cursor.createdAt}:${cursor.id}`).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Nulo para qualquer valor que não tenha saído de encodeAccountCursor. */
export function decodeAccountCursor(value: string): AccountListCursor | null {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value)) return null;
  let decoded: string;
  try { decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/')); } catch { return null; }
  const match = CURSOR_FORMAT.exec(decoded);
  if (!match) return null;
  const createdAt = Number(match[1]);
  if (!Number.isSafeInteger(createdAt)) return null;
  return { createdAt, id: match[2]! };
}
