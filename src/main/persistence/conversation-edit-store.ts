/**
 * F-1237: registro durável de quais arquivos cada conversa do provider editou,
 * para o portão de regressão distinguir "minha edição de ontem" de "WIP de
 * outro agente de ontem" — o mtime sozinho não separa os dois.
 *
 * Chave: escopo de coordenação do checkout + adapter + id da CONVERSA + raiz
 * de execução + caminho relativo já normalizado e confinado a essa raiz (quem
 * chama garante; aqui só se valida a forma). Valor (F-1242): o sha256 do
 * conteúdo que a edição deixou no disco. A escrita é um upsert idempotente que
 * guarda a última edição vista; nada aqui lança para quem chama.
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
/**
 * Teto por conversa e raiz. Na leitura, uma conversa enorme não vira consulta
 * sem fim no Stop. F-1243: também na escrita — um loop de edições não enche o
 * banco, e tudo o que se grava cabe na leitura.
 */
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

const SHA256_HEX = /^[0-9a-f]{64}$/u;

/** Forma do caminho relativo: posix, sem `..`, sem absoluto, sem controle. */
function relPathShape(value: string): string | null {
  const rel = clean(value, PATH_MAX);
  if (!rel || rel.startsWith('/') || rel.includes('\\')) return null;
  return rel.split('/').some((part) => part === '' || part === '.' || part === '..') ? null : rel;
}

/**
 * Grava (upsert) que a conversa deixou em cada caminho de `edits` o conteúdo de
 * sha256 dado, em `editedAtMs`. Idempotente; edição atrasada não sobrescreve a
 * mais nova. F-1243: com a conversa no teto de linhas, caminho novo não grava
 * (o que já existe atualiza). Devolve quantos caminhos gravou; banco ausente,
 * chave inválida ou erro de SQLite dão 0 — nunca lança.
 */
export function recordConversationEdits(
  key: ConversationEditKey,
  edits: ReadonlyMap<string, string>,
  editedAtMs: number,
  db: Db | null = getDb(),
): number {
  try {
    const params = keyParams(key);
    if (!db || !params || !Number.isFinite(editedAtMs)) return 0;
    const shaped = new Map<string, string>();
    for (const [relPath, sha256] of edits) {
      const rel = relPathShape(relPath);
      if (rel && SHA256_HEX.test(sha256)) shaped.set(rel, sha256);
    }
    const paths = [...shaped];
    if (paths.length === 0) return 0;
    const where = `installation_id = ? AND project_id = ? AND checkout_id = ?
          AND adapter_id = ? AND session_id = ? AND root_real_path = ?`;
    const counted = db.prepare(`SELECT COUNT(*) AS n FROM provider_conversation_edits WHERE ${where}`)
      .get(...params) as { n?: unknown } | undefined;
    let room = MAX_CONVERSATION_EDITS_READ - (typeof counted?.n === 'number' ? counted.n : MAX_CONVERSATION_EDITS_READ);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO provider_conversation_edits
         (installation_id, project_id, checkout_id, adapter_id, session_id, root_real_path, rel_path, edited_at, content_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const update = db.prepare(
      `UPDATE provider_conversation_edits SET edited_at = ?, content_sha256 = ?
        WHERE ${where} AND rel_path = ? AND edited_at <= ?`,
    );
    const at = Math.floor(editedAtMs);
    let written = 0;
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
      for (const [rel, sha256] of paths) {
        if (room > 0 && changes(insert.run(...params, rel, at, sha256)) > 0) {
          room -= 1;
          written += 1;
        } else if (changes(update.run(at, sha256, ...params, rel, at)) > 0) {
          written += 1;
        }
      }
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
    return written;
  } catch {
    return 0;
  }
}

function changes(result: unknown): number {
  const value = (result as { changes?: unknown } | undefined)?.changes;
  return typeof value === 'number' ? value : 0;
}

/**
 * Caminho relativo → sha256 do conteúdo que a última edição registrada da
 * conversa deixou nesta raiz. Vazio sem registro; nunca lança.
 */
export function listConversationEdits(
  key: ConversationEditKey,
  db: Db | null = getDb(),
): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const params = keyParams(key);
    if (!db || !params) return out;
    const rows = db.prepare(
      `SELECT rel_path, content_sha256 FROM provider_conversation_edits
        WHERE installation_id = ? AND project_id = ? AND checkout_id = ?
          AND adapter_id = ? AND session_id = ? AND root_real_path = ?
        LIMIT ${MAX_CONVERSATION_EDITS_READ}`,
    ).all(...params) as Array<{ rel_path?: unknown; content_sha256?: unknown }>;
    for (const row of rows) {
      const rel = typeof row.rel_path === 'string' ? relPathShape(row.rel_path) : null;
      if (rel && typeof row.content_sha256 === 'string' && SHA256_HEX.test(row.content_sha256)) {
        out.set(rel, row.content_sha256);
      }
    }
  } catch {
    out.clear();
  }
  return out;
}
