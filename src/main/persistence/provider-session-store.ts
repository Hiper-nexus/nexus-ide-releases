import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume';
import type { ProjectExecutionScope } from '../../shared/types';
import { getDb } from './db';

const ID_MAX = 512;

/** A provider conversation cannot acquire a different account through a hook. */
export function providerSessionAccountIsCompatible(
  scope: Readonly<ProjectExecutionScope>,
  adapterId: string,
  sessionId: string,
  accountId?: string,
  nativeOwnerKey?: string,
): boolean {
  const db = getDb();
  if (!db) return false;
  const owners = db.prepare(`SELECT account_id, 'ledger' AS source FROM provider_session_accounts
    WHERE installation_id = ? AND project_id = ? AND checkout_id = ? AND adapter_id = ? AND session_id = ?
    UNION ALL SELECT account_id, 'pane' AS source FROM provider_pane_sessions
    WHERE installation_id = ? AND project_id = ? AND checkout_id = ?
      AND adapter_id = ? AND session_key = 'session_id' AND session_id = ?`)
    .all(scope.installationId, scope.projectId, scope.checkoutId, adapterId, sessionId,
      scope.installationId, scope.projectId, scope.checkoutId, adapterId, sessionId) as
      Array<{ account_id: string | null; source?: string }>;
  const durable = owners.filter(owner => owner.source === 'ledger');
  if (durable.length) return durable.every(owner => sessionBelongsToAccount(owner.account_id, accountId ?? nativeOwnerKey));
  if (!accountId && nativeOwnerKey && owners.length) return false;
  return owners.every(owner => sessionBelongsToAccount(owner.account_id, accountId));
}

function valid(value: string, max = ID_MAX): string {
  const clean = value.trim();
  if (!clean || clean.length > max || clean.startsWith('-') || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new Error('invalid provider session identity');
  }
  return clean;
}

/**
 * Persist the provider-owned conversation identity under immutable project +
 * pane authority. Optional `accountId` binds the session to the vault account
 * that created it so exact resume cannot leak across multi-account failover.
 *
 * Ownership is sticky: a save without accountId never clears a prior owner.
 */
export function saveProviderPaneSession(
  scope: Readonly<ProjectExecutionScope>,
  paneId: string,
  adapterId: string,
  session: AgentProviderSessionMetadata,
  accountId?: string,
  nativeOwnerKey?: string,
): boolean {
  const db = getDb();
  if (!db) return false;
  const id = valid(session.id);
  const pane = valid(paneId, 256);
  const adapter = valid(adapterId, 128);
  const account =
    accountId && accountId.trim()
      ? valid(accountId.trim(), 128)
      : null;
  const transcript = session.transcriptPath?.trim() || null;
  if (adapter === 'mimo-code') {
    if ((!account && !nativeOwnerKey) || session.key !== 'session_id' || !providerSessionAccountIsCompatible(scope, adapter, id, accountId, nativeOwnerKey)) return false;
    db.prepare(`INSERT OR IGNORE INTO provider_session_accounts
      (installation_id, project_id, checkout_id, adapter_id, session_id, account_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(scope.installationId, scope.projectId, scope.checkoutId, adapter, id, account ?? nativeOwnerKey);
    if (!providerSessionAccountIsCompatible(scope, adapter, id, accountId, nativeOwnerKey)) return false;
  }
  db.prepare(
    `INSERT INTO provider_pane_sessions
       (installation_id, project_id, checkout_id, pane_id, adapter_id,
        session_key, session_id, transcript_path, updated_at, account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(installation_id, project_id, checkout_id, pane_id, adapter_id)
     DO UPDATE SET session_key = excluded.session_key,
                   session_id = excluded.session_id,
                   transcript_path = excluded.transcript_path,
                   updated_at = excluded.updated_at,
                   account_id = COALESCE(excluded.account_id, provider_pane_sessions.account_id)`,
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
    account,
  );
  // F-1237: a primeira gravação da conversa vence (cópia e retomada não a
  // rejuvenescem). Acessória ao vínculo: sem ela, o portão fica no spawn.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO provider_session_births
         (installation_id, project_id, checkout_id, adapter_id, session_id, born_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(scope.installationId, scope.projectId, scope.checkoutId, adapter, id, Date.now());
  } catch {
    // banco sem a tabela: a conversa fica sem prova de idade
  }
  return true;
}

/**
 * F-1237: quando o Nexus gravou pela primeira vez esta conversa neste checkout
 * (ms). Null sem registro; nunca lança.
 */
export function providerSessionBornAtMs(
  scope: Readonly<{ installationId: string; projectId: string; checkoutId: string }>,
  adapterId: string,
  sessionId: string,
): number | null {
  try {
    const row = getDb()?.prepare(
      `SELECT born_at FROM provider_session_births
        WHERE installation_id = ? AND project_id = ? AND checkout_id = ?
          AND adapter_id = ? AND session_id = ?`,
    ).get(scope.installationId, scope.projectId, scope.checkoutId, adapterId, sessionId) as
      { born_at?: unknown } | undefined;
    return typeof row?.born_at === 'number' && Number.isFinite(row.born_at) ? row.born_at : null;
  } catch {
    return null;
  }
}

/**
 * Load a captured session for exact resume.
 * Fail-closed:
 *  - owned row (account_id set) requires a matching pin
 *  - pin without matching owner → null
 *  - legacy unowned row only when caller also has no pin
 */
export function getProviderPaneSession(
  scope: Readonly<ProjectExecutionScope>,
  paneId: string,
  adapterId: string,
  accountId?: string,
): AgentProviderSessionMetadata | null {
  const db = getDb();
  if (!db) return null;
  const row = db.prepare(
    `SELECT session_key, session_id, transcript_path, account_id
       FROM provider_pane_sessions
      WHERE installation_id = ? AND project_id = ? AND checkout_id = ?
        AND pane_id = ? AND adapter_id = ?`,
  ).get(
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    paneId,
    adapterId,
  ) as {
    session_key?: unknown;
    session_id?: unknown;
    transcript_path?: unknown;
    account_id?: unknown;
  } | undefined;
  if (!row || (row.session_key !== 'session_id' && row.session_key !== 'conversation_id')) {
    return null;
  }
  if (typeof row.session_id !== 'string') return null;

  const storedAccount =
    typeof row.account_id === 'string' && row.account_id.trim()
      ? row.account_id.trim()
      : null;
  const wantAccount =
    accountId && accountId.trim() ? accountId.trim() : null;

  if (!sessionBelongsToAccount(storedAccount, wantAccount)) {
    return null;
  }

  const id = valid(row.session_id);
  const transcriptPath =
    typeof row.transcript_path === 'string' && row.transcript_path
      ? row.transcript_path
      : undefined;
  return transcriptPath
    ? { key: row.session_key, id, transcriptPath }
    : { key: row.session_key, id };
}

/**
 * Exact-resume ownership guard (pure).
 * Owned rows require a matching pin; pins require a matching owner.
 * Legacy both-null remains allowed for old rows without account_id.
 */
export function sessionBelongsToAccount(
  storedAccountId: string | null | undefined,
  wantAccountId: string | null | undefined,
): boolean {
  const stored = storedAccountId?.trim() || null;
  const want = wantAccountId?.trim() || null;
  if (stored && !want) return false;
  if (want && !stored) return false;
  if (stored && want) return stored === want;
  return true;
}

/**
 * F-721: esquece TODA linha deste projeto que aponta para a conversa `sessionId`
 * — o id que nunca virou transcrito. São várias porque cada "Retomar" do
 * Maestro copia a linha para o pane novo (a cópia vem da linha velha). Só toca
 * esse id: uma conversa nova capturada depois (um `/resume` à mão) fica. Devolve
 * quantas linhas apagou.
 */
export function forgetProviderSessionById(
  scope: Readonly<{ installationId: string; projectId: string; checkoutId: string }>,
  adapterId: string,
  sessionId: string,
): number {
  const db = getDb();
  if (!db) return 0;
  const result = db.prepare(
    `DELETE FROM provider_pane_sessions
      WHERE installation_id = ? AND project_id = ? AND checkout_id = ?
        AND adapter_id = ? AND session_id = ?`,
  ).run(
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    adapterId,
    sessionId,
  );
  const changes = (result as { changes?: number }).changes;
  return typeof changes === 'number' ? changes : 0;
}

/**
 * 0.76.45: um pane NOVO retoma a conversa de um pane antigo (estacionado ou
 * fechado). Copia o registro de sessão do provider para o paneId novo, com o
 * mesmo dono de conta, para o lookup de resume exato (por paneId) encontrá-lo.
 * Devolve false quando o pane antigo não tem sessão gravada.
 */
export function copyProviderPaneSession(
  scope: Readonly<ProjectExecutionScope>,
  fromPaneId: string,
  toPaneId: string,
  adapterId: string,
  accountId?: string,
  nativeOwnerKey?: string,
): boolean {
  const session = getProviderPaneSession(scope, fromPaneId, adapterId, accountId);
  if (!session) return false;
  return saveProviderPaneSession(scope, toPaneId, adapterId, session, accountId, nativeOwnerKey);
}
