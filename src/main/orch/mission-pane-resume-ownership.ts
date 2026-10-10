import { createHash, randomUUID } from 'node:crypto';
import type { ProjectExecutionScope } from '../../shared/types';
import { getProviderPaneSession } from '../persistence/provider-session-store';
import { getProjectDomainStores, requireProjectDomainStoreRegistry } from './project-domain-store-registry';
import { workerContinuationSpecHash, type ScopedMissionPaneSpec, type WorkerContinuationRef,
  type WorkerContinuation as WorkerContinuationClaim, type RecordMissionPaneInput } from './mission-pane-store';
import { withDeferredStoreChanges } from './scoped-store';
import type { PtyProcessTreeTerminationProof } from '../pty/pty-descendant-termination';
import { resolveMissionPaneAuthoritySeal, sameMissionPaneAuthoritySeal } from './mission-pane-authority';
import { listSquads } from './squad-store';

const runtimeEpochs = new WeakMap<object, string>();
function runtimeEpoch(): string {
  const manager = requireProjectDomainStoreRegistry().runtimeManager();
  let epoch = runtimeEpochs.get(manager);
  if (!epoch) { epoch = randomUUID(); runtimeEpochs.set(manager, epoch); }
  return epoch;
}

/** Reopening a never-authorized preparation cancels its exact late callback by CAS. */
export function reconcilePreparedWorkerContinuation(source: ScopedMissionPaneSpec): ScopedMissionPaneSpec {
  const claim = source.workerContinuation;
  if (claim && claim.state !== 'committed' && claim.state !== 'released' && !claim.childPossible && claim.ownerEpoch !== runtimeEpoch()) {
    getProjectDomainStores(source.scope).missionPanes.updateWorkerContinuation({ sourcePaneId: source.paneId!, attemptId: claim.attemptId },
      current => ({ ...current, state: 'released', outcome: 'prepared-cancelled' }));
    return getProjectDomainStores(source.scope).missionPanes.findByPaneId(source.paneId!)!;
  }
  return source;
}

function nativeHash(source: ScopedMissionPaneSpec): string {
  const native = getProviderPaneSession(source.scope, source.paneId!, source.adapterId, source.accountId);
  if (!native) throw new Error('resume_context_unavailable: conversa original indisponível');
  return createHash('sha256').update(JSON.stringify(native)).digest('hex');
}

/** The very predicate the later rebind applies, evaluated while no child exists yet. */
function assertDispatchStillRebindable(scope: ProjectExecutionScope, missionId: string, paneId: string,
  dispatch: NonNullable<WorkerContinuationClaim['dispatch']>): void {
  getProjectDomainStores(scope).taskDispatches.assertRestartedWorkerRebindable({ missionId, paneId,
    expectedSessionId: dispatch.sessionId, workerIncarnationId: dispatch.workerIncarnationId,
    expectedTaskId: dispatch.taskId, expectedRevision: dispatch.revision });
}

export function reserveWorkerContinuation(source: ScopedMissionPaneSpec): WorkerContinuationRef {
  const suite = getProjectDomainStores(source.scope);
  const matches = suite.taskDispatches.list(source.missionId).filter(row => row.paneId === source.paneId &&
    row.workerIncarnationId === source.workerIncarnationId &&
    (row.state === 'running' || row.state === 'superseded'));
  if (matches.length > 1) throw new Error('resume_dispatch_ambiguous: mais de uma tarefa possui este worker');
  const active = matches[0];
  if (active && (!active.sessionId || !active.workerIncarnationId || active.handoffId || active.handoffAcceptedAt ||
      active.integrationReceipt || active.completedAt)) {
    throw new Error('resume_dispatch_unavailable: a tarefa ativa exige identidade exata sem receipt; recupere o dispatch original');
  }
  const attemptId = `workerresume-${randomUUID()}`;
  if (active?.sessionId && active.workerIncarnationId) {
    assertDispatchStillRebindable(source.scope, source.missionId, source.paneId!, { taskId: active.taskId,
      revision: active.revision, sessionId: active.sessionId, workerIncarnationId: active.workerIncarnationId });
  }
  suite.missionPanes.reserveWorkerContinuation(source, { attemptId, sourceSpecHash: workerContinuationSpecHash(source),
    ownerEpoch: runtimeEpoch(),
    nativeIdentityHash: nativeHash(source), state: 'reserved', childPossible: false, target: null,
    dispatch: active?.sessionId && active.workerIncarnationId ? { taskId: active.taskId,
      revision: active.revision, sessionId: active.sessionId, workerIncarnationId: active.workerIncarnationId } : null });
  return { sourcePaneId: source.paneId!, attemptId };
}

function readWorkerContinuation(scope: ProjectExecutionScope, ref: WorkerContinuationRef, checkDispatch: boolean) {
  const suite = getProjectDomainStores(scope);
  const source = suite.missionPanes.findByPaneId(ref.sourcePaneId);
  const claim = source?.workerContinuation;
  if (!source || !claim || claim.state === 'released' || claim.attemptId !== ref.attemptId ||
      workerContinuationSpecHash(source) !== claim.sourceSpecHash || nativeHash(source) !== claim.nativeIdentityHash) {
    throw new Error('resume_authority_changed: origem, conta, conversa ou tentativa mudou; recupere a continuação existente');
  }
  if (checkDispatch && source.authoritySeal) {
    const mission = suite.missions.get(source.missionId);
    const squads = listSquads().filter(squad => squad.id === mission?.squadId);
    const current = mission ? resolveMissionPaneAuthoritySeal(scope, mission, squads.length === 1 ? squads[0] : null) : null;
    if (!sameMissionPaneAuthoritySeal(source.authoritySeal, current)) {
      throw new Error('resume_authority_changed: selo atual da missão mudou durante a continuação');
    }
  }
  return { source, claim };
}

export function assertWorkerContinuationCurrent(scope: ProjectExecutionScope, ref: WorkerContinuationRef) {
  return readWorkerContinuation(scope, ref, true);
}

export function bindWorkerContinuationTarget(scope: ProjectExecutionScope, ref: WorkerContinuationRef,
  target: { paneId: string; requestId: string; workerIncarnationId: string }): void {
  assertWorkerContinuationCurrent(scope, ref);
  getProjectDomainStores(scope).missionPanes.updateWorkerContinuation(ref, claim => {
    if (claim.state !== 'reserved' || claim.target) throw new Error('resume_continuation_owned: tentativa já vinculou seu pane');
    return { ...claim, state: 'bound', target };
  });
}

/** Exact authority validation, including the deferred native callback. */
export function assertWorkerContinuationTarget(scope: ProjectExecutionScope, ref: WorkerContinuationRef,
  target: { paneId: string; requestId: string; workerIncarnationId: string }) {
  const { claim, source } = assertWorkerContinuationCurrent(scope, ref);
  if (claim.ownerEpoch !== runtimeEpoch() || claim.state !== 'bound' || !claim.target || claim.target.paneId !== target.paneId ||
      claim.target.requestId !== target.requestId || claim.target.workerIncarnationId !== target.workerIncarnationId) {
    throw new Error('resume_continuation_owned: nascimento não pertence à tentativa durável');
  }
  const native = getProviderPaneSession(scope, target.paneId, source.adapterId, source.accountId);
  if (!native || createHash('sha256').update(JSON.stringify(native)).digest('hex') !== claim.nativeIdentityHash) {
    throw new Error('resume_authority_changed: conversa nativa do alvo mudou antes do nascimento');
  }
  return { claim, source };
}

/** Runs only at the host-post boundary, after owned preparation has settled. */
export function authorizeWorkerContinuationBirth(scope: ProjectExecutionScope, ref: WorkerContinuationRef,
  target: { paneId: string; requestId: string; workerIncarnationId: string }): void {
  const { claim, source } = assertWorkerContinuationTarget(scope, ref, target);
  // A superseded/revised dispatch must refuse here, before any child exists,
  // not at the post-birth commit that can no longer undo it.
  if (!claim.childPossible && claim.dispatch) assertDispatchStillRebindable(scope, source.missionId, source.paneId!, claim.dispatch);
  getProjectDomainStores(scope).missionPanes.updateWorkerContinuation(ref,
    current => current.childPossible ? current : { ...current, childPossible: true });
}

/** The selected physical account must equal the original pin; the commit applies the same equality. */
export function assertWorkerContinuationAccount(scope: ProjectExecutionScope, ref: WorkerContinuationRef,
  selectedAccountId: string | undefined): void {
  const { source } = assertWorkerContinuationCurrent(scope, ref);
  if (selectedAccountId !== source.accountId) {
    throw new Error('resume_authority_changed: a conta selecionada difere da conta original do worker');
  }
}

export function rollbackWorkerContinuationBeforeBirth(scope: ProjectExecutionScope, ref: WorkerContinuationRef): boolean {
  const { claim } = readWorkerContinuation(scope, ref, false);
  if (claim.childPossible || claim.state === 'committed') return false;
  getProjectDomainStores(scope).missionPanes.updateWorkerContinuation(ref,
    current => ({ ...current, state: 'released', outcome: 'prepared-cancelled' }));
  return true;
}

export function bindWorkerContinuationSession(scope: ProjectExecutionScope, ref: WorkerContinuationRef,
  target: { paneId: string; requestId: string; workerIncarnationId: string }, sessionId: string): void {
  assertWorkerContinuationTarget(scope, ref, target);
  getProjectDomainStores(scope).missionPanes.updateWorkerContinuation(ref, current => {
    if (current.target?.sessionId && current.target.sessionId !== sessionId) throw new Error('resume_authority_changed: tentativa já tem outro processo');
    return { ...current, target: { ...current.target!, sessionId } };
  });
}

/** Main-only handle callback. Boolean termination/root exit never substitutes for this raw proof. */
export function workerContinuationPhysicalProof(scope: ProjectExecutionScope, ref: WorkerContinuationRef,
  target: { paneId: string; requestId: string; workerIncarnationId: string }) {
  return (sessionId: string, proof: PtyProcessTreeTerminationProof): void => {
    if (!proof.ok || !proof.rootExited || !proof.descendantsExited) return;
    const saved = getProjectDomainStores(scope).missionPanes.findByPaneId(ref.sourcePaneId)?.workerContinuation;
    if (!saved || saved.attemptId !== ref.attemptId) return;
    // Already released (cancelled before birth, or the same tree proved earlier): a late proof is not news.
    if (saved.state === 'released') return;
    // A stale or foreign proof is simply not this claim's: it must never abort the caller's normal
    // shutdown. Real drift of the source is logged by class only (no ids, no conversation data); a
    // failed durable WRITE below still propagates to the caller, which logs it.
    let claim: WorkerContinuationClaim;
    try { claim = readWorkerContinuation(scope, ref, false).claim; }
    catch (error) {
      console.error(`[mission-pane-resume] physical proof ignored: ${error instanceof Error ? error.message.split(':')[0] : 'unreadable claim'}`);
      return;
    }
    if (!claim.target || claim.target.paneId !== target.paneId || claim.target.requestId !== target.requestId ||
        claim.target.workerIncarnationId !== target.workerIncarnationId ||
        claim.target.sessionId !== undefined && claim.target.sessionId !== sessionId) return;
    getProjectDomainStores(scope).missionPanes.updateWorkerContinuation(ref, current => ({ ...current,
      state: current.state === 'committed' ? 'committed' : 'released', outcome: 'physical-tree-exited',
      target: { ...current.target!, sessionId } }));
  };
}

export type WorkerContinuationBirthState = 'authorized' | 'waiting' | 'gone';

/**
 * Read-only: has this exact attempt reached the host-post boundary? The durable
 * target row may only be committed once `childPossible` is persisted; before that
 * the native readiness can still fail and no process exists. `gone` means the
 * reservation was released (or replaced), so no child can ever appear for it.
 */
export function workerContinuationBirthState(scope: ProjectExecutionScope, ref: WorkerContinuationRef): WorkerContinuationBirthState {
  const claim = getProjectDomainStores(scope).missionPanes.findByPaneId(ref.sourcePaneId)?.workerContinuation;
  if (!claim || claim.attemptId !== ref.attemptId || claim.state === 'released') return 'gone';
  return claim.childPossible || claim.state === 'committed' ? 'authorized' : 'waiting';
}

export function commitWorkerContinuation(scope: ProjectExecutionScope, ref: WorkerContinuationRef,
  target: RecordMissionPaneInput, sessionId: string): ScopedMissionPaneSpec {
  const suite = getProjectDomainStores(scope);
  assertWorkerContinuationCurrent(scope, ref);
  return withDeferredStoreChanges(() => suite.missionPanes.commitWorkerContinuation(ref, target, sessionId, claim => {
    if (!claim.dispatch) return;
    suite.taskDispatches.rebindRestartedWorker({ missionId: target.missionId, paneId: ref.sourcePaneId,
      expectedSessionId: claim.dispatch.sessionId, workerIncarnationId: claim.dispatch.workerIncarnationId,
      expectedTaskId: claim.dispatch.taskId, expectedRevision: claim.dispatch.revision,
      replacementSessionId: sessionId, replacementPaneId: target.paneId!,
      replacementWorkerIncarnationId: target.workerIncarnationId!, leaseMs: 60_000 });
  }));
}
