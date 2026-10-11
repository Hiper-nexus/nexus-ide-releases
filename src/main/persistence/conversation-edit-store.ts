/**
 * F-1237: registro durável de quais arquivos cada conversa do provider editou,
 * para o portão de regressão distinguir "minha edição de ontem" de "WIP de
 * outro agente de ontem" — o mtime sozinho não separa os dois.
 *
 * Chave: escopo de coordenação do checkout + adapter + id da CONVERSA + raiz
 * de execução + caminho relativo já normalizado e confinado a essa raiz (quem
 * chama garante; aqui só se valida a forma). A escrita é um upsert idempotente
 * que guarda a última edição vista; nada aqui lança para quem chama.
 */
import { getDb, type Db } from './db';

export interface ConversationEditKey {
  readonly scope: Readonly<{ installationId: string; projectId: string; checkoutId: string }>;
  readonly adapterId: string;
  /** Id da conversa do provider (o mesmo do `--resume <id>`). */
  readonly conversationId: string;
  /** Raiz de execução (realpath) onde os caminhos relativos valem. */
  readonly rootRealPath: string;
}

const ID_MAX = 512;
const PATH_MAX = 4096;
/** Teto por leitura: uma conversa enorme não vira consulta sem fim no Stop. */
export const MAX_CONVERSATION_EDITS_READ = 20_000;

function clean(value: unknown, max = ID_MAX): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  // eslint-disable-next-line no-control-regex -- recusa controles de propósito
  return text && text.length <= max && !/[\u0000-\u001f\u007f]/u.test(text) ? text : null;
}

function keyParams(key: ConversationEditKey): string[] | null {
  const params = [
    clean(key.scope?.installationId),
    clean(key.scope?.projectId),
    clean(key.scope?.checkoutId),
    clean(key.adapterId, 128),
    clean(key.conversationId),
    clean(key.rootRealPath, PATH_MAX),
  ];
  return params.every((param): param is string => param !== null) ? params : null;
}

/** Forma do caminho relativo: posix, sem `..`, sem absoluto, sem controle. */
function relPathShape(value: string): string | null {
  const rel = clean(value, PATH_MAX);
  if (!rel || rel.startsWith('/') || rel.includes('\\')) return null;
  return rel.split('/').some((part) => part === '' || part === '.' || part === '..') ? null : rel;
}

/**
 * Grava (upsert) que a conversa editou `relPaths` em `editedAtMs`. Idempotente:
 * repetir o mesmo par só avança `edited_at`. Devolve quantos caminhos gravou;
 * banco ausente, chave inválida ou erro de SQLite dão 0 — nunca lança.
 */
export function recordConversationEdits(
  key: ConversationEditKey,
  relPaths: readonly string[],
  editedAtMs: number,
  db: Db | null = getDb(),
): number {
  try {
    const params = keyParams(key);
    if (!db || !params || !Number.isFinite(editedAtMs)) return 0;
    const paths = [...new Set(relPaths.map(relPathShape).filter((rel): rel is string => rel !== null))];
    if (paths.length === 0) return 0;
    const statement = db.prepare(
      `INSERT INTO provider_conversation_edits
         (installation_id, project_id, checkout_id, adapter_id, session_id, root_real_path, rel_path, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(installation_id, project_id, checkout_id, adapter_id, session_id, root_real_path, rel_path)
       DO UPDATE SET edited_at = MAX(edited_at, excluded.edited_at)`,
    );
    const at = Math.floor(editedAtMs);
    // Um patch com vários arquivos vira uma transação só (um fsync).
    let transaction = false;
    if (paths.length > 1) {
      try {
        db.exec('BEGIN');
        transaction = true;
      } catch {
        transaction = false;
      }
    }
    try {
      for (const rel of paths) statement.run(...params, rel, at);
      if (transaction) db.exec('COMMIT');
    } catch (error) {
      if (transaction) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // a falha original é a que importa
        }
      }
      throw error;
    }
    return paths.length;
  } catch {
    return 0;
  }
}

/**
 * Caminho relativo → última edição registrada (ms) da conversa nesta raiz.
 * Vazio sem registro; nunca lança.
 */
export function listConversationEdits(
  key: ConversationEditKey,
  db: Db | null = getDb(),
): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const params = keyParams(key);
    if (!db || !params) return out;
    const rows = db.prepare(
      `SELECT rel_path, edited_at FROM provider_conversation_edits
        WHERE installation_id = ? AND project_id = ? AND checkout_id = ?
          AND adapter_id = ? AND session_id = ? AND root_real_path = ?
        LIMIT ${MAX_CONVERSATION_EDITS_READ}`,
    ).all(...params) as Array<{ rel_path?: unknown; edited_at?: unknown }>;
    for (const row of rows) {
      const rel = typeof row.rel_path === 'string' ? relPathShape(row.rel_path) : null;
      if (rel && typeof row.edited_at === 'number' && Number.isFinite(row.edited_at)) out.set(rel, row.edited_at);
    }
  } catch {
    out.clear();
  }
  return out;
}
