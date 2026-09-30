import { resetLicensedAccessMock } from '../__tests__/licensed-access';
beforeEach(resetLicensedAccessMock);
import { beforeEach } from 'vitest';
vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
import { requireAccess } from '../license-access';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runCronTick,
  startCronLoop,
  stopCronLoop,
  type CronRuntimeDeps,
} from './cron-runtime';
import type { CronJob } from './cron-loop';

function job(over: Partial<CronJob> = {}): CronJob {
  return {
    id: 'c1',
    name: 'nightly',
    schedule: '0 0 * * *',
    brief: 'roda os testes',
    status: 'active',
    workspacePath: '/ws',
    projectId: 'project-a',
    checkoutId: 'checkout-a',
    agentName: 'qa',
    createdAt: 1,
    updatedAt: 1,
    nextFireAt: new Date('2026-07-06T00:00:00').getTime(),
    ...over,
  };
}

function deps(
  jobs: CronJob[],
  now: number,
  fire = vi.fn(async () => {}),
): { deps: CronRuntimeDeps; saved: CronJob[][]; fire: typeof fire } {
  const saved: CronJob[][] = [];
  return {
    fire,
    saved,
    deps: {
      load: () => jobs,
      save: (j) => saved.push(JSON.parse(JSON.stringify(j))),
      fire,
      executeOccurrence: async (scheduledJob, _scheduledFor, invoke) => {
        try {
          await invoke(scheduledJob);
          return { fired: true, disposition: 'completed' as const };
        } catch (error) {
          return {
            fired: false,
            disposition: 'fire-failed' as const,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      now: () => now,
    },
  };
}

describe('runCronTick', () => {
  afterEach(async () => {
    await stopCronLoop();
    vi.useRealTimers();
  });

  it('dispara job vencido e reavança nextFireAt', async () => {
    const jobs = [job()];
    const now = new Date('2026-07-06T00:00:30').getTime();
    const { deps: d, fire, saved } = deps(jobs, now);
    const fired = await runCronTick(d);
    expect(fired).toBe(1);
    expect(fire).toHaveBeenCalledOnce();
    const after = saved.at(-1)![0];
    expect(after.lastFiredAt).toBe(now);
    // próximo disparo é depois de agora (amanhã 00:00)
    expect(after.nextFireAt!).toBeGreaterThan(now);
  });

  it('não dispara antes do horário', async () => {
    const now = new Date('2026-07-05T12:00:00').getTime();
    const { deps: d, fire } = deps([job()], now);
    expect(await runCronTick(d)).toBe(0);
    expect(fire).not.toHaveBeenCalled();
  });

  it('pula (skip) job muito atrasado sem disparar, mas reavança', async () => {
    const now = new Date('2026-07-06T03:00:00').getTime(); // 3h atrasado
    const { deps: d, fire, saved } = deps([job()], now);
    expect(await runCronTick(d)).toBe(0);
    expect(fire).not.toHaveBeenCalled();
    expect(saved.at(-1)![0].nextFireAt!).toBeGreaterThan(now);
  });

  it('job pausado é ignorado', async () => {
    const now = new Date('2026-07-06T00:00:30').getTime();
    const { deps: d, fire } = deps([job({ status: 'paused' })], now);
    expect(await runCronTick(d)).toBe(0);
    expect(fire).not.toHaveBeenCalled();
  });

  it('erro no fire registra lastError e não derruba o tick', async () => {
    const now = new Date('2026-07-06T00:00:10').getTime();
    const failing = vi.fn(async () => {
      throw new Error('spawn falhou');
    });
    const { deps: d, saved } = deps([job()], now, failing);
    await runCronTick(d);
    expect(saved.at(-1)![0].lastError).toContain('spawn falhou');
  });

  it('schedule inválida registra lastError, sem disparar', async () => {
    const now = Date.now();
    const { deps: d, fire } = deps([job({ schedule: 'lixo' })], now);
    await runCronTick(d);
    expect(fire).not.toHaveBeenCalled();
  });

  it('não dispara quando nextFireAt adulterado não pertence à expressão aprovada', async () => {
    const forgedOccurrence = new Date('2026-07-06T12:00:00').getTime();
    const now = forgedOccurrence + 30_000;
    const fixture = deps(
      [job({ schedule: '0 0 * * *', nextFireAt: forgedOccurrence })],
      now,
    );
    const executeOccurrence = vi.spyOn(fixture.deps, 'executeOccurrence');

    await expect(runCronTick(fixture.deps)).resolves.toBe(0);

    expect(executeOccurrence).not.toHaveBeenCalled();
    expect(fixture.fire).not.toHaveBeenCalled();
    expect(fixture.saved.at(-1)?.[0]).toMatchObject({
      lastError: expect.stringMatching(/nextFireAt.*CTA:/i),
    });
    expect(fixture.saved.at(-1)![0].nextFireAt).toBeGreaterThan(now);
  });

  it('não aceita um nextFireAt deslocado para segundos fora do minuto cron', async () => {
    const forgedOccurrence = new Date('2026-07-06T00:00:45').getTime();
    const now = forgedOccurrence + 5_000;
    const fixture = deps([job({ nextFireAt: forgedOccurrence })], now);

    await expect(runCronTick(fixture.deps)).resolves.toBe(0);

    expect(fixture.fire).not.toHaveBeenCalled();
    expect(fixture.saved.at(-1)?.[0]?.lastError).toMatch(
      /nextFireAt.*CTA:/i,
    );
  });

  it('avança sem catch-up quando o lease remoto está indisponível', async () => {
    const jobs = [job()];
    const now = new Date('2026-07-06T00:00:30').getTime();
    const fixture = deps(jobs, now);
    fixture.deps.executeOccurrence = vi.fn(async () => ({
      fired: false,
      disposition: 'backend-unavailable' as const,
      error: 'remote cron lease backend is not configured',
    }));

    expect(await runCronTick(fixture.deps)).toBe(0);
    expect(fixture.fire).not.toHaveBeenCalled();
    expect(fixture.saved.at(-1)?.[0]).toMatchObject({
      lastError: 'remote cron lease backend is not configured',
    });
    expect(fixture.saved.at(-1)![0].nextFireAt).toBeGreaterThan(now);
  });

  it('preserva o erro durável de uma ocorrência já registrada', async () => {
    const now = new Date('2026-07-06T00:00:30').getTime();
    const fixture = deps([job()], now);
    fixture.deps.executeOccurrence = vi.fn(async () => ({
      fired: false,
      disposition: 'already-recorded' as const,
      error:
        'A ocorrência anterior falhou sem comprovação. CTA: Revise a agenda.',
    }));

    await runCronTick(fixture.deps);

    expect(fixture.saved.at(-1)?.[0]?.lastError).toMatch(/falhou.*CTA:/i);
  });

  it('stopCronLoop aguarda o tick físico em andamento antes de liberar o shutdown', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const occurrenceStarted = vi.fn();
    const pendingOccurrence = new Promise<void>((resolve) => {
      release = resolve;
    });
    const now = new Date('2026-07-06T00:00:30').getTime();
    const fixture = deps([job()], now);
    fixture.deps.executeOccurrence = vi.fn(async () => {
      occurrenceStarted();
      await pendingOccurrence;
      return { fired: true, disposition: 'completed' as const };
    });
    startCronLoop(fixture.deps);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(occurrenceStarted).toHaveBeenCalledOnce();
    let stopped = false;
    const stopping = stopCronLoop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('stopCronLoop solta o shutdown no teto mesmo com tick remoto pendurado', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const hungSync = new Promise<void>((resolve) => {
      release = resolve;
    });
    const now = new Date('2026-07-06T00:00:30').getTime();
    const fixture = deps([job()], now);
    fixture.deps.syncSchedules = vi.fn(() => hungSync);
    startCronLoop(fixture.deps);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.deps.syncSchedules).toHaveBeenCalled();
    let stopped = false;
    void stopCronLoop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    // O primeiro passo do shutdown não pode depender de um backend remoto
    // pendurado: o budget de 3s vence e o quit segue (teto de quit = 45s).
    await vi.advanceTimersByTimeAsync(3_000);
    expect(stopped).toBe(true);

    release();
  });
});


it('refuses a due occurrence before materializing it when license access is denied', async () => {
  vi.mocked(requireAccess).mockReturnValue({ ok: false, reason: 'suspended' });
  const { deps: d } = deps([job()], new Date('2026-07-06T00:00:30').getTime());
  const execute = vi.spyOn(d, 'executeOccurrence');
  expect(await runCronTick(d)).toBe(0);
  expect(execute).not.toHaveBeenCalled();
  expect(d.load()[0].lastError).toContain('license_access_denied');
});
