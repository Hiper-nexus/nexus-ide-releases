import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedHandoffStore } from './handoff-store';
import { createScopedMissionStore } from './mission-store';
import { testProjectScope } from './__tests__/scope-fixture';
import { __resetSessionWebExposureForTests, markSessionWebExposed } from './session-web-exposure';
import { compileIntentContract } from '../../shared/mission-intent';
import { bindTokenToSession, mintToken, releaseSession, resetGateForTests } from './gate';

vi.mock('../license-access', async () =>
  (await import('../__tests__/licensed-access')).licensedAccessMock,
);

const memory = vi.hoisted(() => ({
  retain: vi.fn().mockResolvedValue(null),
  resolved: vi.fn().mockResolvedValue(null),
  skip: vi.fn(),
}));
// The remote Jev barrier is covered in trusted-memory tests; these tests
// exercise the durable handoff transitions that must actually invoke it.
// importOriginal keeps the pure reported-fix detector real.
vi.mock('../memory/trusted-memory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../memory/trusted-memory')>()),
  retainAcknowledgedHandoffMemoryBestEffort: memory.retain,
  retainAcceptedHandoffMemoryDistilledBestEffort: vi.fn().mockResolvedValue(null),
  retainReportedFixFromHandoffBestEffort: memory.resolved,
  recordMemoryRetentionSkip: memory.skip,
}));

let baseDir: string;
let manager: ProjectRuntimeManager;
const scope = testProjectScope();

beforeEach(() => {
  memory.retain.mockReset().mockResolvedValue(null);
  memory.resolved.mockReset().mockResolvedValue(null);
  memory.skip.mockReset();
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-handoff-memory-'));
  manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
});

afterEach(() => {
  __resetSessionWebExposureForTests();
  resetGateForTests();
  manager.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('F-768 handoff memory triggers', () => {
  it('distills a successful helper handoff without a mission at commit', () => {
    const handoffs = createScopedHandoffStore(manager, scope);
    const handoff = handoffs.submit({
      sessionId: 'helper-session',
      status: 'success',
      summary: 'O caminho de quota preserva a sessão nativa durante refresh.',
    });
    expect(memory.retain).toHaveBeenCalledExactlyOnceWith(
      scope,
      { handoffId: handoff.id, status: 'success' },
      handoff.summary,
    );
    expect(handoffs.get(handoff.id)).toMatchObject({
      deliveryState: 'queued', evidenceTrust: 'unverified', claimTrust: 'untrusted',
    });
    handoffs.submit({ status: 'partial', summary: 'Trabalho ainda incompleto.' });
    expect(memory.retain).toHaveBeenCalledTimes(1);
  });

  it('distills mission delivery without waiting for an orchestrator ACK', () => {
    createScopedMissionStore(manager, scope, { idFactory: () => 'mission-a' })
      .create({ title: 'Memória' });
    const handoffs = createScopedHandoffStore(manager, scope);
    const handoff = handoffs.submit({
      missionId: 'mission-a', status: 'success',
      summary: 'A leitura do SQLite em modo ro inclui as alterações do WAL.',
    });
    expect(memory.retain).not.toHaveBeenCalled();
    expect(handoffs.markSubmitted(handoff.id)).toBe(true);
    expect(handoffs.markSubmitted(handoff.id)).toBe(false);
    expect(memory.retain).toHaveBeenCalledExactlyOnceWith(
      scope, { handoffId: handoff.id, missionId: 'mission-a', status: 'success' },
      handoff.summary,
    );
    expect(handoffs.get(handoff.id)).toMatchObject({
      deliveryState: 'submitted', evidenceTrust: 'unverified', consumedAt: undefined,
    });
  });

  it('distills only the accepted delivery attempt after its transaction commits', () => {
    const missions = createScopedMissionStore(manager, scope, { idFactory: () => 'mission-a' });
    missions.create({ title: 'Memória', orchestratorSessionId: 'maestro' });
    const handoffs = createScopedHandoffStore(manager, scope, { now: () => 100 });
    const handoff = handoffs.submit({
      missionId: 'mission-a', status: 'success', summary: 'O refresh deve usar o store nativo.',
    });
    const attempt = handoffs.reserveDeliveryAttempt({
      handoffId: handoff.id, missionId: 'mission-a', orchestratorSessionId: 'maestro', maxAttempts: 2,
    });
    handoffs.markDeliveryAttemptPasted({
      attemptId: attempt.id, handoffId: handoff.id, acceptDeadlineAt: 200,
    });
    missions.setOrchestratorSession('mission-a', 'maestro-new');
    expect(handoffs.acceptDeliveryAttempt({ attemptId: attempt.id, handoffId: handoff.id })).toBe(false);
    expect(memory.retain).not.toHaveBeenCalled();
    missions.setOrchestratorSession('mission-a', 'maestro');
    expect(handoffs.acceptDeliveryAttempt({ attemptId: attempt.id, handoffId: handoff.id })).toBe(true);
    expect(memory.retain).toHaveBeenCalledExactlyOnceWith(
      scope, { handoffId: handoff.id, missionId: 'mission-a', status: 'success' }, handoff.summary,
    );
    expect(handoffs.get(handoff.id)?.deliveryState).toBe('submitted');
    expect(handoffs.listDeliveryAttempts(handoff.id)[0].state).toBe('accepted');
  });

  it('records retention failure without rolling back a committed helper handoff', async () => {
    memory.retain.mockRejectedValueOnce(new Error('unavailable'));
    const handoffs = createScopedHandoffStore(manager, scope);
    const handoff = handoffs.submit({ status: 'success', summary: 'O runtime conserva as sessões do projeto.' });
    await Promise.resolve();
    expect(memory.skip).toHaveBeenCalledWith(scope, 'store-unavailable');
    expect(handoffs.get(handoff.id)?.deliveryState).toBe('queued');
  });
});

describe('reported fix writer trigger (F-911)', () => {
  const declared = 'Corrigido o vazamento do watcher; ver docs/qa/items/F-911.md.';
  const missionHandoffs = () => {
    createScopedMissionStore(manager, scope, { idFactory: () => 'mission-a' })
      .create({ title: 'Memória' });
    return createScopedHandoffStore(manager, scope);
  };

  // Autoridade Main-owned da sessão autora (gate), como o MCP faz no spawn.
  const session = (sessionId: string, missionId: string, readOnly: boolean) => {
    const ctx = mintToken({ label: sessionId, role: 'worker', missionId, readOnly, scope });
    bindTokenToSession(ctx.token, sessionId);
  };
  const consultMission = (id: string) =>
    createScopedMissionStore(manager, scope, { idFactory: () => id }).create({
      title: 'Consulta',
      intentVersion: 1,
      intentContract: compileIntentContract({
        goal: 'Ler logs e resumir', intentVersion: 1, source: 'typed', lane: 'consult',
      }),
    });

  it('passes the Main-owned handoff order when a writable author declares a fix (no quarantine)', () => {
    const handoffs = missionHandoffs();
    session('worker-rw', 'mission-a', false);
    const handoff = handoffs.submit({ missionId: 'mission-a', sessionId: 'worker-rw', status: 'success', summary: declared });
    expect(memory.resolved).not.toHaveBeenCalled();
    expect(handoffs.markSubmitted(handoff.id)).toBe(true);
    expect(memory.resolved).toHaveBeenCalledExactlyOnceWith(
      scope,
      {
        handoffId: handoff.id, missionId: 'mission-a', status: 'success',
        handoffCreatedAt: handoff.createdAt, summary: declared,
      },
    );
  });

  it('declares the fix through an artifact that states it, sending that artifact as text', () => {
    const handoffs = missionHandoffs();
    session('worker-rw', 'mission-a', false);
    const handoff = handoffs.submit({
      missionId: 'mission-a', sessionId: 'worker-rw', status: 'success',
      summary: 'Rotina de sincronização concluída.',
      artifacts: [{ kind: 'qa', ref: 'docs/qa/items/F-912.md', note: 'corrigido' }],
    });
    expect(handoffs.markSubmitted(handoff.id)).toBe(true);
    expect(memory.resolved).toHaveBeenCalledExactlyOnceWith(
      scope,
      expect.objectContaining({
        handoffId: handoff.id, missionId: 'mission-a', status: 'success',
        artifactsText: 'qa docs/qa/items/F-912.md corrigido',
      }),
    );
  });

  it.each([
    ['open work', 'Acompanha o F-911 em andamento, ainda sem conclusão.', []],
    ['a negated fix', 'O F-911 não foi corrigido nesta rodada.', []],
    ['a bare QA path', 'Bug ainda aberto; ver docs/qa/items/F-911.md', []],
    ['a bare QA artifact', 'Rotina concluída.', [{ kind: 'qa', ref: 'docs/qa/items/F-912.md' }]],
  ] as const)('skips the writer for %s', (_label, summary, artifacts) => {
    const handoffs = missionHandoffs();
    const handoff = handoffs.submit({ missionId: 'mission-a', status: 'success', summary, artifacts: [...artifacts] });
    expect(handoffs.markSubmitted(handoff.id)).toBe(true);
    expect(memory.retain).toHaveBeenCalledTimes(1);
    expect(memory.resolved).not.toHaveBeenCalled();
  });

  it('F-808: a readOnly reviewer of a standard mission is quarantined without vault, even after its session left', () => {
    const handoffs = missionHandoffs();
    session('reviewer-ro', 'mission-a', true);
    const handoff = handoffs.submit({ missionId: 'mission-a', sessionId: 'reviewer-ro', status: 'success', summary: declared });
    releaseSession('reviewer-ro');
    expect(handoffs.markSubmitted(handoff.id)).toBe(true);
    expect(memory.resolved).toHaveBeenCalledExactlyOnceWith(
      scope,
      {
        handoffId: handoff.id, missionId: 'mission-a', status: 'success',
        handoffCreatedAt: handoff.createdAt, summary: declared,
        quarantine: 'read-only session', readOnlyContext: true,
      },
    );
  });

  it('F-808: an author whose authority cannot be proven is quarantined without vault (fail-safe)', () => {
    const handoffs = missionHandoffs();
    const handoff = handoffs.submit({ missionId: 'mission-a', sessionId: 'unknown-session', status: 'success', summary: declared });
    expect(handoffs.markSubmitted(handoff.id)).toBe(true);
    expect(memory.resolved).toHaveBeenCalledExactlyOnceWith(
      scope,
      expect.objectContaining({ handoffId: handoff.id, quarantine: 'unproven author session', readOnlyContext: true }),
    );
  });

  it('F-808: a writable web-exposed author is quarantined but keeps the vault', () => {
    const handoffs = missionHandoffs();
    session('worker-web', 'mission-a', false);
    markSessionWebExposed('worker-web');
    const handoff = handoffs.submit({ missionId: 'mission-a', sessionId: 'worker-web', status: 'success', summary: declared });
    expect(handoffs.markSubmitted(handoff.id)).toBe(true);
    expect(memory.resolved).toHaveBeenCalledExactlyOnceWith(
      scope,
      {
        handoffId: handoff.id, missionId: 'mission-a', status: 'success',
        handoffCreatedAt: handoff.createdAt, summary: declared, quarantine: 'web-exposed session',
      },
    );
  });

  it('F-808: a consult mission is quarantined without vault', () => {
    consultMission('mission-c');
    const handoffs = createScopedHandoffStore(manager, scope);
    session('worker-c', 'mission-c', false);
    const handoff = handoffs.submit({ missionId: 'mission-c', sessionId: 'worker-c', status: 'success', summary: declared });
    expect(handoffs.markSubmitted(handoff.id)).toBe(true);
    expect(memory.resolved).toHaveBeenCalledExactlyOnceWith(
      scope,
      expect.objectContaining({ handoffId: handoff.id, missionId: 'mission-c', quarantine: 'read-only session', readOnlyContext: true }),
    );
  });

  it('F-806: web exposure in a consult mission keeps the vault veto (read-only context wins over the cause)', () => {
    consultMission('mission-c');
    const handoffs = createScopedHandoffStore(manager, scope);
    session('worker-cw', 'mission-c', false);
    markSessionWebExposed('worker-cw');
    const handoff = handoffs.submit({ missionId: 'mission-c', sessionId: 'worker-cw', status: 'success', summary: declared });
    expect(handoffs.markSubmitted(handoff.id)).toBe(true);
    expect(memory.resolved).toHaveBeenCalledExactlyOnceWith(
      scope,
      expect.objectContaining({ handoffId: handoff.id, quarantine: 'web-exposed session', readOnlyContext: true }),
    );
  });

  it('skips the writer for helper handoffs even when they cite a fixed bug', () => {
    const handoffs = createScopedHandoffStore(manager, scope);
    handoffs.submit({ status: 'success', summary: declared });
    expect(memory.retain).toHaveBeenCalledTimes(1);
    expect(memory.resolved).not.toHaveBeenCalled();
  });
});

describe('Mem12 delivered handoff activity', () => {
  it('counts successful deliveries in the window, independent of memory retention', () => {
    createScopedMissionStore(manager, scope, { idFactory: () => 'mission-a' })
      .create({ title: 'Memória' });
    let now = 1_000;
    const handoffs = createScopedHandoffStore(manager, scope, { now: () => now });
    const delivered = handoffs.submit({ missionId: 'mission-a', status: 'success', summary: 'Entrega um.' });
    const failed = handoffs.submit({ missionId: 'mission-a', status: 'failed', summary: 'Falhou.' });
    const queued = handoffs.submit({ missionId: 'mission-a', status: 'success', summary: 'Ainda na fila.' });
    now = 5_000;
    expect(handoffs.markSubmitted(delivered.id)).toBe(true);
    expect(handoffs.markSubmitted(failed.id)).toBe(true);
    expect(queued.deliveryState).toBe('queued');
    // A retenção pode ter falhado (mock): a contagem vem do banco de handoffs.
    expect(handoffs.countSuccessfulDeliveriesBetween(4_000, 6_000)).toBe(1);
    expect(handoffs.countSuccessfulDeliveriesBetween(5_000, 6_000)).toBe(0);
    expect(handoffs.countSuccessfulDeliveriesBetween(0, 4_999)).toBe(0);
    // Commit sem entrega (helper ainda na fila do pane pai) não conta.
    now = 7_000;
    handoffs.submit({ status: 'success', summary: 'Helper avulso ainda na fila.' });
    expect(handoffs.countSuccessfulDeliveriesBetween(6_000, 8_000)).toBe(0);
  });
});
