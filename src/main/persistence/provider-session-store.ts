import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume';
import type { ProjectExecutionScope } from '../../shared/types';
import { getDb } from './db';

const ID_MAX = 512;

function valid(value: string, max = ID_MAX): string {
  const clean = value.trim();
  if (!clean || clean.length > max || clean.startsWith('-') || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new Error('invalid provider session identity');
  }
  return clean;
}

/** Persist the provider-owned conversation identity under immutable project + pane authority. */
export function saveProviderPaneSession(
  scope: Readonly<ProjectExecutionScope>,
  paneId: string,
  adapterId: string,
  session: AgentProviderSessionMetadata,
): boolean {
  const db = getDb();
  if (!db) return false;
  const id = valid(session.id);
  const pane = valid(paneId, 256);
  const adapter = valid(adapterId, 128);
  const transcript = session.transcriptPath?.trim() || null;
  db.prepare(
    `INSERT INTO provider_pane_sessions
       (installation_id, project_id, checkout_id, pane_id, adapter_id,
        session_key, session_id, transcript_path, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(installation_id, project_id, checkout_id, pane_id, adapter_id)
     DO UPDATE SET session_key = excluded.session_key,
                   session_id = excluded.session_id,
                   transcript_path = excluded.transcript_path,
                   updated_at = excluded.updated_at`,
  ).run(
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    pane,
    adapter,
    session.key,
    id,
    transcript,
    Date.now(),
  );
  return true;
}

export function getProviderPaneSession(
  scope: Readonly<ProjectExecutionScope>,
  paneId: string,
  adapterId: string,
): AgentProviderSessionMetadata | null {
  const db = getDb();
  if (!db) return null;
  const row = db.prepare(
    `SELECT session_key, session_id, transcript_path
       FROM provider_pane_sessions
      WHERE installation_id = ? AND project_id = ? AND checkout_id = ?
        AND pane_id = ? AND adapter_id = ?`,
  ).get(
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    paneId,
    adapterId,
  ) as { session_key?: unknown; session_id?: unknown; transcript_path?: unknown } | undefined;
  if (!row || (row.session_key !== 'session_id' && row.session_key !== 'conversation_id')) return null;
  if (typeof row.session_id !== 'string') return null;
  const id = valid(row.session_id);
  const transcriptPath = typeof row.transcript_path === 'string' && row.transcript_path
    ? row.transcript_path
    : undefined;
  return transcriptPath
    ? { key: row.session_key, id, transcriptPath }
    : { key: row.session_key, id };
}
