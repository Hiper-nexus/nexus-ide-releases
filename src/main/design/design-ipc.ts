import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { ipcMain } from 'electron';
import { z } from 'zod';
import { DESIGN_WRITEBACK_CHANNELS } from '../../shared/channels';
import type { ProjectExecutionScope } from '../../shared/types';
import { getLastSelection, onDesignEvent } from '../browser/design-session';
import {
  assertTrustedLocalDesignPreview,
  browserDesignSessionKey,
} from '../browser/browser-manager';
import { getContextWorkflowService } from '../context/context-workflow-registry';
import {
  auditDenied,
  auditError,
  auditIntent,
  auditSuccess,
  ensureAuditLogWritable,
  type AuditContext,
} from '../jarvis/audit-log';
import { getPaneAuthzInfoOwnedByPane } from '../orch/pane-registry';
import { sameProjectScope } from '../orch/project-scoped-broadcast';
import {
  onRendererWorkspaceScopeChange,
  requireLiveRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import type {
  DesignWritebackAction,
  DesignWritebackAuthority,
} from './design-writeback-service';

type DesignWritebackService = typeof import('./design-writeback-service');

/**
 * The write-back service carries Babel + recast (~15 MB and ~30 ms of init in
 * Main). It loads the first time a renderer asks about design write-back,
 * never at app boot. A record only exists after `start` resolved the service,
 * so the synchronous paths that act on a live record read the loaded module.
 */
let writebackService: DesignWritebackService | null = null;
let writebackServiceLoad: Promise<DesignWritebackService> | null = null;

function loadWritebackService(): Promise<DesignWritebackService> {
  writebackServiceLoad ??= import('./design-writeback-service').then(
    (service) => (writebackService = service),
    (error: unknown) => {
      writebackServiceLoad = null;
      throw error;
    },
  );
  return writebackServiceLoad;
}

const nexusId = z.string().min(1).max(64);
const missionBindingSchema = z
  .object({
    browserPaneId: z.string().min(1).max(128),
    paneId: z.string().min(1).max(128),
    missionId: z.string().min(1).max(128),
  })
  .strict();
type DesignMissionBinding = z.infer<typeof missionBindingSchema>;
const styles = z
  .record(z.string().min(1).max(64), z.string().min(1).max(512))
  .refine((record) => {
    const count = Object.keys(record).length;
    return count >= 1 && count <= 64;
  });

const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('style'), nexusId, styles }).strict(),
  z
    .object({ kind: z.literal('text'), nexusId, text: z.string().max(2_000) })
    .strict(),
  z
    .object({
      kind: z.literal('move'),
      nexusId,
      direction: z.enum(['up', 'down']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reorder'),
      parentNexusId: nexusId,
      fromIndex: z.number().int().min(0).max(10_000),
      toIndex: z.number().int().min(0).max(10_000),
    })
    .strict(),
  z.object({ kind: z.literal('delete'), nexusId }).strict(),
  z.object({ kind: z.literal('duplicate'), nexusId }).strict(),
]);
const actionRequestSchema = z
  .object({ binding: missionBindingSchema, action: actionSchema })
  .strict();

interface DesignOwnerRecord {
  owner: WebContents;
  scope: ProjectExecutionScope;
  sessionKey: string;
  binding: Readonly<DesignMissionBinding>;
  sessionId: string;
  contextRevision: string;
  phase: 'starting' | 'active' | 'stopping';
  stopPromise?: Promise<{ ok: true }>;
}

const ownersByScope = new Map<string, DesignOwnerRecord>();
let unsubscribeScopeChanges: (() => void) | null = null;
let designEventsRegistered = false;

function scopeKey(scope: ProjectExecutionScope): string {
  return [
    scope.version,
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    scope.rootRealPath,
    scope.identitySource,
  ].join('\0');
}

function sessionKey(owner: WebContents, scope: ProjectExecutionScope): string {
  return `${scopeKey(scope)}\0owner:${owner.id}`;
}

function requireCurrentContractRevision(
  scope: ProjectExecutionScope,
  missionId: string,
): string {
  const stored = getContextWorkflowService(scope).getMissionWorkflow(missionId).contract;
  const revision = stored?.contract.contextRevision;
  if (!revision) {
    throw new Error('design write-back requires a frozen PREVC mission contract');
  }
  return revision;
}

function resolveMissionAuthority(
  owner: WebContents,
  scope: ProjectExecutionScope,
  binding: DesignMissionBinding,
): { sessionId: string; contextRevision: string } {
  const pane = getPaneAuthzInfoOwnedByPane(owner, binding.paneId);
  if (
    !pane?.sessionId ||
    pane.kind !== 'cli-agent' ||
    pane.missionId !== binding.missionId ||
    !pane.scope ||
    !sameProjectScope(scope, pane.scope)
  ) {
    throw new Error(
      'design write-back requires a trusted mission-bound agent pane in this project checkout',
    );
  }
  if (pane.executionScope && !sameProjectScope(scope, pane.executionScope)) {
    throw new Error(
      'design write-back is disabled when the mission executes in another worktree',
    );
  }
  assertTrustedLocalDesignPreview(
    owner,
    scope,
    binding.browserPaneId,
    binding.paneId,
  );
  const contextRevision = requireCurrentContractRevision(
    scope,
    binding.missionId,
  );
  if (pane.contextRevision !== contextRevision) {
    throw new Error(
      'design write-back mission pane carries a stale context revision',
    );
  }
  return Object.freeze({
    sessionId: pane.sessionId,
    contextRevision,
  });
}

function assertRecordAuthority(record: DesignOwnerRecord): void {
  requireLiveRendererWorkspaceScope(record.owner, record.scope);
  if (ownersByScope.get(scopeKey(record.scope)) !== record) {
    throw new Error('design write-back authority is stale');
  }
  if (record.phase === 'stopping') {
    throw new Error('design write-back is stopping');
  }
}

function assertRecordEffectAuthority(
  record: DesignOwnerRecord,
  effect: { readonly tool: string; readonly path?: string },
): void {
  assertRecordAuthority(record);
  const resolved = resolveMissionAuthority(record.owner, record.scope, record.binding);
  if (resolved.sessionId !== record.sessionId) {
    throw new Error('design write-back mission pane session changed');
  }
  if (resolved.contextRevision !== record.contextRevision) {
    throw new Error('design write-back context revision changed (context drift)');
  }
  getContextWorkflowService(record.scope).assertMutationAllowed(
    record.binding.missionId,
    effect.tool,
    {
      paneId: record.binding.paneId,
      ...(effect.path ? { path: effect.path } : {}),
    },
  );
}

function authorityFor(record: DesignOwnerRecord): DesignWritebackAuthority {
  return Object.freeze({
    assertAuthorized: (effect: { readonly tool: string; readonly path?: string }) =>
      assertRecordEffectAuthority(record, effect),
  });
}

function auditContextFor(record: DesignOwnerRecord): AuditContext {
  return Object.freeze({
    scope: record.scope,
    missionId: record.binding.missionId,
    contextRevision: record.contextRevision,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function auditUnavailable(error: unknown, effectMayHaveCommitted = false): Error {
  const suffix = effectMayHaveCommitted ? '; effect may have committed' : '';
  return new Error(`audit_unavailable: ${errorMessage(error)}${suffix}`);
}

async function runAuditedEffect<T>(
  record: DesignOwnerRecord,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  effect: () => Promise<T>,
): Promise<T> {
  const context = auditContextFor(record);
  const session = `design:${record.owner.id}:${record.binding.paneId}`;
  const invocationId = randomUUID();
  const startedAt = Date.now();
  try {
    ensureAuditLogWritable(context);
  } catch (error) {
    throw auditUnavailable(error);
  }
  try {
    assertRecordEffectAuthority(record, {
      tool,
      ...(typeof args.path === 'string' ? { path: args.path } : {}),
    });
  } catch (error) {
    try {
      auditDenied(context, session, tool, { ...args }, Date.now() - startedAt, errorMessage(error));
    } catch (auditError) {
      throw auditUnavailable(auditError);
    }
    throw error;
  }
  try {
    auditIntent(
      context,
      session,
      tool,
      { ...args },
      Date.now() - startedAt,
      true,
      'ipc-renderer',
      invocationId,
    );
  } catch (error) {
    throw auditUnavailable(error);
  }
  let result: T;
  try {
    result = await effect();
  } catch (error) {
    try {
      auditError(
        context,
        session,
        tool,
        { ...args },
        Date.now() - startedAt,
        errorMessage(error),
        true,
        'ipc-renderer',
        invocationId,
      );
    } catch (outcomeAuditError) {
      throw auditUnavailable(outcomeAuditError, true);
    }
    throw error;
  }
  try {
    auditSuccess(
      context,
      session,
      tool,
      { ...args },
      Date.now() - startedAt,
      true,
      'ipc-renderer',
      invocationId,
    );
  } catch (error) {
    throw auditUnavailable(error, true);
  }
  return result;
}

function recordDeniedReorder(
  record: DesignOwnerRecord,
  args: Readonly<Record<string, unknown>>,
  reason: string,
): void {
  const context = auditContextFor(record);
  try {
    ensureAuditLogWritable(context);
    auditDenied(
      context,
      `design:${record.owner.id}:${record.binding.paneId}`,
      'nexus_design_writeback_reorder',
      { ...args },
      0,
      reason,
    );
  } catch (error) {
    console.error('[design] denied reorder audit unavailable:', errorMessage(error));
  }
}

function requireOwnedRecord(
  owner: WebContents,
  scope: ProjectExecutionScope,
): DesignOwnerRecord {
  const record = ownersByScope.get(scopeKey(scope));
  if (!record || record.owner !== owner || record.phase !== 'active') {
    throw new Error('renderer does not own an active design write-back session');
  }
  assertRecordAuthority(record);
  return record;
}

function stopRecord(record: DesignOwnerRecord): Promise<{ ok: true }> {
  if (record.stopPromise) return record.stopPromise;
  record.phase = 'stopping';
  record.stopPromise = loadWritebackService()
    .then((service) => service.stopDesignWriteback(record.sessionKey))
    .then(
    (result) => {
      if (ownersByScope.get(scopeKey(record.scope)) === record) {
        ownersByScope.delete(scopeKey(record.scope));
      }
      return result;
    },
    (error) => {
      // Keep ownership so cleanup can be retried. The underlying service is
      // fail-closed; if it already closed, the retry is an idempotent success.
      record.stopPromise = undefined;
      record.phase = 'active';
      throw error;
    },
  );
  return record.stopPromise;
}

export async function closeDesignWritebackFor(owner: WebContents): Promise<void> {
  const owned = [...ownersByScope.values()].filter(
    (record) => record.owner === owner,
  );
  await stopRecords(owned);
}

export async function closeAllDesignWritebacks(): Promise<void> {
  await stopRecords([...ownersByScope.values()]);
}

async function stopRecords(records: DesignOwnerRecord[]): Promise<void> {
  const results = await Promise.allSettled(
    records.map((record) => stopRecord(record)),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'design write-back cleanup failed');
  }
}

function registerTrustedReorderBridge(): void {
  if (designEventsRegistered) return;
  designEventsRegistered = true;
  onDesignEvent((browserKey, event, source) => {
    if (event.type !== 'reorder' || !event.reorder) return;
    const reorder = event.reorder;
    if (!source) return;
    const record = ownersByScope.get(scopeKey(source.scope));
    if (
      !record ||
      record.phase !== 'active' ||
      record.owner !== source.owner ||
      scopeKey(record.scope) !== scopeKey(source.scope)
    ) {
      return;
    }
    try {
      assertRecordAuthority(record);
    } catch {
      return;
    }
    const service = writebackService;
    if (!service) return;
    const selectedNexusId =
      getLastSelection(browserKey)?.attributes['data-nexus-id'];
    const targetPath = service.designActionTargetPath(
      { kind: 'reorder', ...reorder },
      record.sessionKey,
    );
    const auditArgs = Object.freeze({
      eventId: event.eventId,
      nexusId: reorder.nexusId,
      parentNexusId: reorder.parentNexusId,
      fromIndex: reorder.fromIndex,
      toIndex: reorder.toIndex,
      ...(targetPath ? { path: targetPath } : {}),
    });
    if (
      browserKey !==
      browserDesignSessionKey(record.scope, record.binding.browserPaneId)
    ) {
      recordDeniedReorder(
        record,
        auditArgs,
        'reorder came from a different browser pane than the bound preview',
      );
      return;
    }
    if (selectedNexusId !== reorder.nexusId) {
      recordDeniedReorder(
        record,
        auditArgs,
        'reorder element does not match the main-side selected element',
      );
      return;
    }
    if (!targetPath) {
      recordDeniedReorder(
        record,
        auditArgs,
        'reorder element is not owned by this write-back instrumentation session',
      );
      return;
    }
    void runAuditedEffect(
      record,
      'nexus_design_writeback_reorder',
      auditArgs,
      () =>
        service.applyDesignAction(
          { kind: 'reorder', ...reorder },
          record.sessionKey,
        ),
    ).catch((error) => {
      console.warn(
        '[design] trusted drag reorder failed:',
        error instanceof Error ? error.message : error,
      );
    });
  });
}

export function registerDesignWritebackIpc(options: {
  readonly allowSourceMutation: boolean;
}): void {
  unsubscribeScopeChanges?.();
  unsubscribeScopeChanges = null;
  if (!options.allowSourceMutation) {
    const disabled = (): never => {
      throw new Error('design_writeback_disabled_in_release');
    };
    ipcMain.handle(DESIGN_WRITEBACK_CHANNELS.status, async (event) => {
      requireLiveRendererWorkspaceScope(event.sender);
      return {
        enabled: false,
        active: false,
        styleMode: 'tailwind' as const,
        canUndo: false,
        canRedo: false,
        authorityReady: false,
        authorityError: 'Write-back direto não está disponível nesta versão distribuída.',
      };
    });
    for (const channel of [
      DESIGN_WRITEBACK_CHANNELS.start,
      DESIGN_WRITEBACK_CHANNELS.stop,
      DESIGN_WRITEBACK_CHANNELS.action,
      DESIGN_WRITEBACK_CHANNELS.undo,
      DESIGN_WRITEBACK_CHANNELS.redo,
    ]) {
      ipcMain.handle(channel, async () => disabled());
    }
    return;
  }
  unsubscribeScopeChanges = onRendererWorkspaceScopeChange((owner) => {
    for (const record of [...ownersByScope.values()]) {
      if (record.owner.id !== owner.id) continue;
      void stopRecord(record).catch((error) => {
        console.error('[design] scope-change cleanup failed:', error);
      });
    }
  });
  registerTrustedReorderBridge();

  ipcMain.handle(DESIGN_WRITEBACK_CHANNELS.status, async (event, rawBinding) => {
    const { designWritebackStatus } = await loadWritebackService();
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const status = designWritebackStatus(
      scope.rootRealPath,
      sessionKey(event.sender, scope),
    );
    const parsed = missionBindingSchema.safeParse(rawBinding);
    if (!parsed.success) {
      return {
        ...status,
        authorityReady: false,
        authorityError: 'Selecione um pane de agente vinculado a uma missão PREVC em execução.',
      };
    }
    try {
      const authority = resolveMissionAuthority(event.sender, scope, parsed.data);
      getContextWorkflowService(scope).assertMutationAllowed(
        parsed.data.missionId,
        'nexus_design_writeback_status',
        { paneId: parsed.data.paneId },
      );
      const existing = ownersByScope.get(scopeKey(scope));
      if (
        existing &&
        (existing.binding.missionId !== parsed.data.missionId ||
          existing.binding.paneId !== parsed.data.paneId ||
          existing.contextRevision !== authority.contextRevision)
      ) {
        throw new Error('write-back is bound to another mission context');
      }
      return { ...status, authorityReady: true };
    } catch (error) {
      return {
        ...status,
        authorityReady: false,
        authorityError: errorMessage(error),
      };
    }
  });

  ipcMain.handle(DESIGN_WRITEBACK_CHANNELS.start, async (event, rawBinding) => {
    const parsedBinding = missionBindingSchema.safeParse(rawBinding);
    if (!parsedBinding.success) throw new Error('invalid design mission binding');
    // Loaded before any ownership check, so the check-and-claim below keeps
    // running in one uninterrupted turn, exactly as before.
    const service = await loadWritebackService();
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const resolved = resolveMissionAuthority(event.sender, scope, parsedBinding.data);
    const key = scopeKey(scope);
    const existing = ownersByScope.get(key);
    if (existing && existing.owner !== event.sender) {
      throw new Error('design write-back is owned by another project window');
    }
    if (existing?.phase === 'stopping') {
      throw new Error('design write-back cleanup is still running');
    }
    if (
      existing &&
      (existing.binding.missionId !== parsedBinding.data.missionId ||
        existing.binding.paneId !== parsedBinding.data.paneId ||
        existing.contextRevision !== resolved.contextRevision ||
        existing.sessionId !== resolved.sessionId)
    ) {
      throw new Error('design write-back is already bound to another mission context');
    }
    const record: DesignOwnerRecord =
      existing ?? {
        owner: event.sender,
        scope: Object.freeze({ ...scope }),
        sessionKey: sessionKey(event.sender, scope),
        binding: Object.freeze({ ...parsedBinding.data }),
        sessionId: resolved.sessionId,
        contextRevision: resolved.contextRevision,
        phase: 'starting',
      };
    record.phase = 'starting';
    ownersByScope.set(key, record);
    try {
      const result = await runAuditedEffect(
        record,
        'nexus_design_writeback_start',
        { paneId: record.binding.paneId },
        () =>
          service.startDesignWriteback(
            scope.rootRealPath,
            record.sessionKey,
            authorityFor(record),
          ),
      );
      assertRecordAuthority(record);
      record.phase = 'active';
      return result;
    } catch (error) {
      if (ownersByScope.get(key) === record) ownersByScope.delete(key);
      await service.stopDesignWriteback(record.sessionKey).catch(() => undefined);
      throw error;
    }
  });

  ipcMain.handle(DESIGN_WRITEBACK_CHANNELS.stop, async (event, rawBinding) => {
    const parsedBinding = missionBindingSchema.safeParse(rawBinding);
    if (!parsedBinding.success) throw new Error('invalid design mission binding');
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const record = ownersByScope.get(scopeKey(scope));
    if (!record) return { ok: true };
    if (record.owner !== event.sender) {
      throw new Error('renderer does not own this design write-back session');
    }
    if (
      record.binding.missionId !== parsedBinding.data.missionId ||
      record.binding.paneId !== parsedBinding.data.paneId
    ) {
      throw new Error('design write-back mission binding changed');
    }
    return runAuditedEffect(
      record,
      'nexus_design_writeback_stop',
      { paneId: record.binding.paneId },
      () => stopRecord(record),
    );
  });

  ipcMain.handle(DESIGN_WRITEBACK_CHANNELS.action, async (event, raw) => {
    const parsed = actionRequestSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid design action payload');
    const service = await loadWritebackService();
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const record = requireOwnedRecord(event.sender, scope);
    if (
      record.binding.missionId !== parsed.data.binding.missionId ||
      record.binding.paneId !== parsed.data.binding.paneId
    ) {
      throw new Error('design write-back mission binding changed');
    }
    const action = parsed.data.action as DesignWritebackAction;
    const targetPath = service.designActionTargetPath(action, record.sessionKey);
    const auditArgs = {
      paneId: record.binding.paneId,
      kind: action.kind,
      ...('nexusId' in action ? { nexusId: action.nexusId } : {}),
      ...(targetPath ? { path: targetPath } : {}),
    };
    return runAuditedEffect(
      record,
      `nexus_design_writeback_${action.kind}`,
      auditArgs,
      () => service.applyDesignAction(action, record.sessionKey),
    );
  });

  ipcMain.handle(DESIGN_WRITEBACK_CHANNELS.undo, async (event, rawBinding) => {
    const parsedBinding = missionBindingSchema.safeParse(rawBinding);
    if (!parsedBinding.success) throw new Error('invalid design mission binding');
    const service = await loadWritebackService();
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const record = requireOwnedRecord(event.sender, scope);
    if (
      record.binding.missionId !== parsedBinding.data.missionId ||
      record.binding.paneId !== parsedBinding.data.paneId
    ) throw new Error('design write-back mission binding changed');
    return runAuditedEffect(
      record,
      'nexus_design_writeback_undo',
      { paneId: record.binding.paneId },
      () => service.undoDesignAction(record.sessionKey),
    );
  });

  ipcMain.handle(DESIGN_WRITEBACK_CHANNELS.redo, async (event, rawBinding) => {
    const parsedBinding = missionBindingSchema.safeParse(rawBinding);
    if (!parsedBinding.success) throw new Error('invalid design mission binding');
    const service = await loadWritebackService();
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const record = requireOwnedRecord(event.sender, scope);
    if (
      record.binding.missionId !== parsedBinding.data.missionId ||
      record.binding.paneId !== parsedBinding.data.paneId
    ) throw new Error('design write-back mission binding changed');
    return runAuditedEffect(
      record,
      'nexus_design_writeback_redo',
      { paneId: record.binding.paneId },
      () => service.redoDesignAction(record.sessionKey),
    );
  });
}
