import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MergeQueueBlockedError, MergeValidationRejectedError } from './merge-queue';
import { STALLED_MERGE_ATTEMPT_MS } from './merge-stall-watchdog';
import { createSignal, root, scope, worktrees, queue, git, commitTask, approved } from './merge-queue-test-fixture';



describe('orphaned mission block retirement', () => {
  it('lifts a block whose mission no longer exists and unbricks the scope', async () => {
    await commitTask('mission-dead', 'task-dead', 'worker-dead', 'dead.txt', 'D\n');
    await commitTask('mission-live', 'task-live', 'worker-live', 'live.txt', 'L\n');

    await expect(
      queue.enqueue({
        scope,
        missionId: 'mission-dead',
        taskId: 'task-dead',
        validate: async () => ({
          sensorsPassed: false,
          reviewPassed: true,
          evidenceIds: ['rejected-dead'],
        }),
      }),
    ).rejects.toThrow(MergeValidationRejectedError);

    // A different mission inherits the block while the owner still exists.
    await expect(
      queue.enqueue({
        scope,
        missionId: 'mission-live',
        taskId: 'task-live',
        validate: approved,
      }),
    ).rejects.toThrow(MergeQueueBlockedError);

    // Owner alive → retirement refuses to touch the block.
    expect(queue.retireOrphanedMissionBlock(scope, () => true)).toBeNull();
    expect(queue.snapshot(scope).blocked).not.toBeNull();

    // Owner mission removed → the block is provably unownable and lifts.
    const retired = queue.retireOrphanedMissionBlock(
      scope,
      (missionId) => missionId !== 'mission-dead',
    );
    expect(retired?.errorName).toBe('MergeValidationRejectedError');

    const after = queue.snapshot(scope);
    expect(after.blocked).toBeNull();
    // Audit evidence survives: the blocked entry and a reconciliation event.
    expect(
      after.entries.some(
        (entry) => entry.missionId === 'mission-dead' && entry.status === 'blocked',
      ),
    ).toBe(true);
    expect(after.events.at(-1)).toMatchObject({
      type: 'restart-reconciled',
      fromStatus: 'blocked',
    });

    // The scope is usable again end-to-end.
    const result = await queue.enqueue({
      scope,
      missionId: 'mission-live',
      taskId: 'task-live',
      validate: approved,
    });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(result.integratedSha);
    expect(fs.readFileSync(path.join(root, 'live.txt'), 'utf8')).toBe('L\n');
  });

  it('returns null when the scope has no block', () => {
    expect(queue.retireOrphanedMissionBlock(scope, () => false)).toBeNull();
  });
});


describe('same-process stalled merge watchdog (deadline + dead-letter)', () => {
  const ENQUEUED_AT = 1_700_000_000_000;

  function candidateCheckoutsOnDisk(): readonly string[] {
    const scopeDirectory = path.join(
      queue.candidatesRoot,
      `scope-${worktrees.scopeKey(scope)}`,
    );
    if (!fs.existsSync(scopeDirectory)) return [];
    return fs.readdirSync(scopeDirectory);
  }

  it(
    'dead-letters an abandoned candidate validation past the deadline with an ' +
      'actionable reason, releases its resources, and lets the queue move on',
    async () => {
      // Regressão do incidente de 31/07/2026: entrada presa em
      // candidate-validating por 22,7 min NO MESMO processo, blocked=null,
      // 91 ticks com applied=0 — a promise de validação nunca voltou.
      await commitTask(
        'mission-stalled',
        'task-stalled',
        'worker-stalled',
        'stalled.txt',
        'abandoned mid-validation\n',
      );
      await commitTask(
        'mission-next',
        'task-next',
        'worker-next',
        'next.txt',
        'must still integrate\n',
      );

      const validationStarted = createSignal('stalled-validation-started');
      const resumeZombie = createSignal('resume-zombie-validation');
      const abandoned = queue.enqueue({
        scope,
        missionId: 'mission-stalled',
        taskId: 'task-stalled',
        async validate(context) {
          if (context.phase === 'candidate') {
            validationStarted.notify();
            await resumeZombie.wait();
          }
          return approved(context);
        },
      });
      await validationStarted.wait();
      expect(queue.snapshot(scope).entries[0]?.status).toBe(
        'candidate-validating',
      );
      // O recurso está preso: o checkout do candidato existe em disco.
      expect(candidateCheckoutsOnDisk()).toHaveLength(1);

      // 91 ticks dentro do prazo (o incidente real): o watchdog NÃO dispara —
      // deadline generoso, nunca menor que o bound da validação.
      for (let tick = 1; tick <= 91; tick += 1) {
        expect(
          queue.reconcileIfStalled(scope, ENQUEUED_AT + tick * 15_000),
        ).toEqual({ action: 'none' });
      }
      expect(queue.snapshot(scope).entries[0]?.status).toBe(
        'candidate-validating',
      );

      // Deadline vencido: a entrada NÃO fica lá — vira dead-letter.
      const firedAt = ENQUEUED_AT + STALLED_MERGE_ATTEMPT_MS + 1;
      expect(queue.reconcileIfStalled(scope, firedAt)).toMatchObject({
        action: 'blocked-interrupted',
        fromStatus: 'candidate-validating',
        integrationState: 'not-integrated',
      });

      const after = queue.snapshot(scope);
      expect(after.activeTaskKey).toBeNull();
      expect(after.blocked).toMatchObject({
        errorName: 'MergeStalledError',
        disposition: 'retryable',
      });
      // Reason acionável: o que estava fazendo, há quanto tempo, o que fazer.
      expect(after.blocked?.reason).toMatch(/candidate-validating/);
      expect(after.blocked?.reason).toMatch(/25 min/);
      expect(after.blocked?.reason).toMatch(/watchdog/i);
      expect(after.blocked?.reason).toMatch(/retry|retomar/i);
      // A entrada continua visível como falha (não é "resolvida" em silêncio).
      expect(
        after.entries.find((entry) => entry.missionId === 'mission-stalled'),
      ).toMatchObject({ status: 'blocked', failureReason: after.blocked?.reason });
      // Recurso liberado: o checkout do candidato foi removido.
      expect(candidateCheckoutsOnDisk()).toHaveLength(0);
      // Retryable não condena o worktree da task: ele fica para o retry.
      expect(
        worktrees.get(scope, 'mission-stalled', 'task-stalled'),
      ).not.toMatchObject({ status: 'failed' });

      // Nada foi afrouxado: enquanto o dead-letter não é reconhecido, o scope
      // continua fail-closed para novas entradas.
      await expect(
        queue.enqueue({
          scope,
          missionId: 'mission-next',
          taskId: 'task-next',
          validate: approved,
        }),
      ).rejects.toThrow(MergeQueueBlockedError);

      // A lane automática do produto destrava o retryable sem wizard…
      const retried = await queue.retryRecoverable({
        scope,
        missionId: 'mission-stalled',
        taskId: 'task-stalled',
        validate: approved,
      });
      expect(git(root, 'rev-parse', 'HEAD')).toBe(retried.integratedSha);

      // …e a fila volta a processar as demais entradas.
      const next = await queue.enqueue({
        scope,
        missionId: 'mission-next',
        taskId: 'task-next',
        validate: approved,
      });
      expect(git(root, 'rev-parse', 'HEAD')).toBe(next.integratedSha);
      expect(fs.readFileSync(path.join(root, 'next.txt'), 'utf8')).toBe(
        'must still integrate\n',
      );

      // A tentativa zumbi acordando depois não corrompe nada: a autoridade
      // dela foi superada e ela apenas rejeita.
      resumeZombie.notify();
      await expect(abandoned).rejects.toThrow();
      const settled = queue.snapshot(scope);
      expect(settled.blocked).toBeNull();
      expect(git(root, 'rev-parse', 'HEAD')).toBe(next.integratedSha);
      expect(
        settled.entries.find((entry) => entry.missionId === 'mission-stalled'),
      ).toMatchObject({ status: 'integrated', attempt: 2 });
    },
  );

  it('never touches a healthy validation still inside the deadline', async () => {
    await commitTask(
      'mission-healthy',
      'task-healthy',
      'worker-healthy',
      'healthy.txt',
      'slow but alive\n',
    );
    const validationStarted = createSignal('healthy-validation-started');
    const resumeValidation = createSignal('resume-healthy-validation');
    const attempt = queue.enqueue({
      scope,
      missionId: 'mission-healthy',
      taskId: 'task-healthy',
      async validate(context) {
        if (context.phase === 'candidate') {
          validationStarted.notify();
          await resumeValidation.wait();
        }
        return approved(context);
      },
    });
    await validationStarted.wait();

    // Um tick aquém do deadline: falso positivo mataria validação viva.
    expect(
      queue.reconcileIfStalled(
        scope,
        ENQUEUED_AT + STALLED_MERGE_ATTEMPT_MS - 1,
      ),
    ).toEqual({ action: 'none' });
    expect(queue.snapshot(scope)).toMatchObject({
      activeTaskKey: expect.any(String),
      blocked: null,
      entries: [{ status: 'candidate-validating' }],
    });

    resumeValidation.notify();
    const result = await attempt;
    expect(git(root, 'rev-parse', 'HEAD')).toBe(result.integratedSha);
    expect(queue.snapshot(scope)).toMatchObject({
      activeTaskKey: null,
      blocked: null,
      entries: [{ status: 'integrated', attempt: 1 }],
    });
  });
});
