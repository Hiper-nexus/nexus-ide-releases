import { describe, expect, it, vi } from 'vitest';
import { runCronTick, type CronRuntimeDeps } from './cron-runtime';
import type { CronJob } from './cron-loop';

function job(over: Partial<CronJob> = {}): CronJob {
  return {
    id: 'c1',
    name: 'nightly',
    schedule: '0 0 * * *',
    brief: 'roda os testes',
    status: 'active',
    workspacePath: '/ws',
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
      now: () => now,
    },
  };
}

describe('runCronTick', () => {
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
});
