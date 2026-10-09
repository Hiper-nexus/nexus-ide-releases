import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  assertCompletionEffectsSettled,
  getAutomaticCompletionProof,
  isAutomaticCompletionProof,
  withAutomaticCompletionProof,
} from './automatic-completion-proof';
import { createScopedEffectOutboxStore } from './effect-outbox';
import { createScopedHandoffStore } from './handoff-store';
import { createScopedMissionStore } from './mission-store';

const scope = testProjectScope({ workspaceRootDevice: '1', workspaceRootInode: '10' });
const mission = { id: 'reviewed', intentVersion: 2, updatedAt: 10, intentState: 'executing' as const };

describe('automatic completion proof', () => {
  it('exposes only the current internal proof for the exact scope and mission incarnation', () => {
    const input = { status: 'verified' as const, candidateFingerprint: 'physical-candidate' };
    let captured: unknown;
    expect(withAutomaticCompletionProof(scope, mission, input, () => {
      captured = getAutomaticCompletionProof(scope, mission);
      expect(captured).toEqual(input);
      expect(isAutomaticCompletionProof(captured)).toBe(true);
      expect(isAutomaticCompletionProof(captured, scope, mission)).toBe(true);
      expect(isAutomaticCompletionProof(captured, { ...scope, checkoutId: 'other' }, mission)).toBe(false);
      expect(isAutomaticCompletionProof(captured, scope, { ...mission, intentVersion: 3 })).toBe(false);
      expect(isAutomaticCompletionProof(input)).toBe(false);
      expect(getAutomaticCompletionProof({ ...scope, checkoutId: 'other' }, mission)).toBeNull();
      expect(getAutomaticCompletionProof({ ...scope, workspaceRootInode: '11' }, mission)).toBeNull();
      expect(getAutomaticCompletionProof(scope, { ...mission, intentVersion: 3 })).toBeNull();
      expect(getAutomaticCompletionProof(scope, { ...mission, updatedAt: 11 })).toBeNull();
      return true;
    })).toBe(true);
    expect(getAutomaticCompletionProof(scope, mission)).toBeNull();
    expect(isAutomaticCompletionProof(captured)).toBe(false);
  });

  it('clears unavailable proof after an exception and never upgrades its status', () => {
    expect(() => withAutomaticCompletionProof(scope, mission, { status: 'unavailable', note: 'Sem varredura' }, () => {
      expect(getAutomaticCompletionProof(scope, mission)?.status).toBe('unavailable');
      throw new Error('completion failed');
    })).toThrow('completion failed');
    expect(getAutomaticCompletionProof(scope, mission)).toBeNull();
  });
});

describe('assertCompletionEffectsSettled reads the handoff ledger', () => {
  const directories: string[] = [];
  const managers: ProjectRuntimeManager[] = [];

  afterEach(() => {
    for (const manager of managers.splice(0)) manager.closeAll();
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function openScope() {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-completion-gate-'));
    directories.push(baseDir);
    const runtime = new ProjectRuntimeManager({
      baseDir,
      appVersion: 'completion-gate-test',
    });
    managers.push(runtime);
    const projectScope = testProjectScope({
      projectId: 'project-completion-gate',
      checkoutId: 'checkout-completion-gate',
    });
    const missions = createScopedMissionStore(runtime, projectScope);
    const handoffs = createScopedHandoffStore(runtime, projectScope);
    return { runtime, projectScope, missions, handoffs };
  }

  it('refuses completion while the final handoff is still queued and effect_outbox is empty', () => {
    const { runtime, projectScope, missions, handoffs } = openScope();
    const missionRow = missions.create({ title: 'Board done' });
    handoffs.submit({
      missionId: missionRow.id,
      sessionId: 'worker-session',
      fromAgent: 'worker',
      status: 'success',
      summary: 'Handoff final ainda na fila do Maestro.',
    });
    expect(runtime.open(projectScope).db.prepare(
      'SELECT COUNT(*) AS n FROM effect_outbox',
    ).get()).toEqual({ n: 0 });

    expect(() => assertCompletionEffectsSettled(
      runtime,
      projectScope,
      missionRow.id,
    )).toThrow(/completion_effects_pending:.*handoff\.deliver=pending/);
  });

  it('allows completion after the handoff leaves the queue and still blocks a pending checkpoint', () => {
    const { runtime, projectScope, missions, handoffs } = openScope();
    const missionRow = missions.create({ title: 'Board done' });
    const other = missions.create({ title: 'Other mission' });
    const queued = handoffs.submit({
      missionId: missionRow.id,
      sessionId: 'worker-session',
      fromAgent: 'worker',
      status: 'success',
      summary: 'Handoff final entregue ao transporte.',
    });
    handoffs.submit({
      missionId: other.id,
      sessionId: 'other-session',
      fromAgent: 'worker',
      status: 'success',
      summary: 'Fila de outra missão não trava esta.',
    });
    expect(handoffs.markSubmitted(queued.id)).toBe(true);

    expect(() => assertCompletionEffectsSettled(
      runtime,
      projectScope,
      missionRow.id,
    )).not.toThrow();

    createScopedEffectOutboxStore(runtime, projectScope).enqueue({
      commandId: 'cmd-checkpoint',
      threadId: missionRow.id,
      type: 'checkpoint.capture',
    });
    expect(() => assertCompletionEffectsSettled(
      runtime,
      projectScope,
      missionRow.id,
    )).toThrow(/completion_effects_pending:.*checkpoint\.capture=pending/);
  });

  it('sees this mission checkpoint when other threads fill the status window', () => {
    const { runtime, projectScope, missions, handoffs } = openScope();
    const missionRow = missions.create({ title: 'Board done' });
    const delivered = handoffs.submit({
      missionId: missionRow.id,
      sessionId: 'worker-session',
      fromAgent: 'worker',
      status: 'success',
      summary: 'Handoff final já saiu da fila.',
    });
    expect(handoffs.markSubmitted(delivered.id)).toBe(true);
    const outbox = createScopedEffectOutboxStore(runtime, projectScope);
    for (let index = 0; index < 200; index += 1) {
      outbox.enqueue({
        commandId: `cmd-older-${index}`,
        threadId: 'other-thread',
        type: 'checkpoint.capture',
      });
      outbox.claimNext({ workerId: 'older-main', leaseDurationMs: 60_000 });
    }
    outbox.enqueue({
      commandId: 'cmd-checkpoint-hidden',
      threadId: missionRow.id,
      type: 'checkpoint.capture',
    });

    expect(() => assertCompletionEffectsSettled(
      runtime,
      projectScope,
      missionRow.id,
    )).toThrow(/completion_effects_pending:.*checkpoint\.capture=pending/);
  });

  it('ignores the orchestrator session queued handoff and still blocks a worker queue', () => {
    const { runtime, projectScope, missions, handoffs } = openScope();
    const missionRow = missions.create({ title: 'Board done' });
    handoffs.submit({
      missionId: missionRow.id,
      sessionId: 'maestro-session',
      fromAgent: 'maestro',
      status: 'success',
      summary: 'Resumo do Maestro, que não volta para ele mesmo.',
    });
    const worker = handoffs.submit({
      missionId: missionRow.id,
      sessionId: 'worker-session',
      fromAgent: 'worker',
      status: 'success',
      summary: 'Handoff do worker ainda na fila.',
    });
    const exclude = { excludeSessionId: 'maestro-session' };

    expect(() => assertCompletionEffectsSettled(
      runtime,
      projectScope,
      missionRow.id,
      exclude,
    )).toThrow(/completion_effects_pending:.*handoff\.deliver=pending/);

    expect(handoffs.markSubmitted(worker.id)).toBe(true);
    expect(() => assertCompletionEffectsSettled(
      runtime,
      projectScope,
      missionRow.id,
      exclude,
    )).not.toThrow();
    expect(() => assertCompletionEffectsSettled(
      runtime,
      projectScope,
      missionRow.id,
    )).toThrow(/completion_effects_pending:.*handoff\.deliver=pending/);
  });
  it('F-1065: fifty excluded Maestro rows cannot hide a later queued worker', () => {
    const { runtime, projectScope, missions } = openScope();
    const missionRow = missions.create({ title: 'Hidden worker' });
    let sequence = 0;
    const handoffs = createScopedHandoffStore(runtime, projectScope, { now: () => ++sequence });
    for (let index = 0; index < 50; index += 1) {
      handoffs.submit({ missionId: missionRow.id, sessionId: 'maestro-session', fromAgent: 'Maestro',
        status: 'success', summary: 'Own summary' });
    }
    const worker = handoffs.submit({ missionId: missionRow.id, sessionId: 'worker-session', fromAgent: 'Worker',
      status: 'success', summary: 'Pending worker delivery' });
    expect(() => assertCompletionEffectsSettled(runtime, projectScope, missionRow.id,
      { excludeSessionId: 'maestro-session' })).toThrow(/completion_effects_pending:.*handoff\.deliver=pending/);
    expect(handoffs.listQueuedDeliveries(missionRow.id, { excludeSessionId: 'maestro-session' }))
      .toEqual([{ id: worker.id, missionId: missionRow.id, sessionId: 'worker-session' }]);
    expect(handoffs.markSubmitted(worker.id)).toBe(true);
    expect(() => assertCompletionEffectsSettled(runtime, projectScope, missionRow.id,
      { excludeSessionId: 'maestro-session' })).not.toThrow();
  });

});
