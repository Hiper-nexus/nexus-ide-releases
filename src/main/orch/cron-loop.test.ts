import { describe, expect, it } from 'vitest';
import {
  createCronJob,
  matchesCron,
  nextCronAfter,
  parseCronJobs,
  parseCronJobsBudgeted,
  parseCronExpr,
  shouldFire,
  type CronJob,
} from './cron-loop';

it('parses cron arrays cooperatively in order and refuses malformed trailing data', async () => {
  const jobs = Array.from({ length: 70 }, (_, index) => createCronJob({ name: `job ${index}`, schedule: '* * * * *', brief: 'quoted " } ] text' }, 0, () => `job-${index}`));
  let heartbeat = false;
  const pulse = new Promise<void>((resolve) => setImmediate(() => { heartbeat = true; resolve(); }));
  const parsed = await parseCronJobsBudgeted(JSON.stringify(jobs));
  expect(heartbeat).toBe(true);
  expect(parsed.map((job) => job.id)).toEqual(jobs.map((job) => job.id));
  await pulse;
  await expect(parseCronJobsBudgeted('[{},]')).rejects.toThrow();
  await expect(parseCronJobsBudgeted('[]{}')).rejects.toThrow();
});

describe('parseCronExpr', () => {
  it('aceita 5 campos e reconhece *', () => {
    const f = parseCronExpr('30 9 * * 1');
    expect(f.minute).toEqual([30]);
    expect(f.hour).toEqual([9]);
    expect(f.dom).toBe('*');
    expect(f.dow).toEqual([1]);
  });

  it('expande listas, ranges e steps', () => {
    expect(parseCronExpr('0,30 * * * *').minute).toEqual([0, 30]);
    expect(parseCronExpr('0 9-11 * * *').hour).toEqual([9, 10, 11]);
    expect(parseCronExpr('*/15 * * * *').minute).toEqual([0, 15, 30, 45]);
  });

  it('rejeita contagem de campos errada e valores fora de faixa', () => {
    expect(() => parseCronExpr('* * *')).toThrow();
    expect(() => parseCronExpr('99 * * * *')).toThrow();
    expect(() => parseCronExpr('* 25 * * *')).toThrow();
  });
});

describe('matchesCron', () => {
  // 2026-07-06 é uma segunda-feira (dow=1).
  const monday0930 = new Date('2026-07-06T09:30:00');

  it('casa quando todos os campos batem', () => {
    expect(matchesCron(parseCronExpr('30 9 6 7 1'), monday0930)).toBe(true);
  });

  it('não casa quando o minuto difere', () => {
    expect(matchesCron(parseCronExpr('31 9 * * *'), monday0930)).toBe(false);
  });

  it('DOM e DOW: casa se QUALQUER um bate quando ambos restritos (cron clássico)', () => {
    // dom=6 bate, dow=3 (quarta) não — casa mesmo assim (OR).
    expect(matchesCron(parseCronExpr('30 9 6 * 3'), monday0930)).toBe(true);
    // nenhum bate → false
    expect(matchesCron(parseCronExpr('30 9 7 * 3'), monday0930)).toBe(false);
  });
});

describe('nextCronAfter', () => {
  it('encontra o próximo minuto que casa', () => {
    const from = new Date('2026-07-06T09:30:15');
    const next = nextCronAfter(parseCronExpr('*/15 * * * *'), from);
    // próximo múltiplo de 15 após 09:30 é 09:45
    expect(next?.getHours()).toBe(9);
    expect(next?.getMinutes()).toBe(45);
    expect(next?.getSeconds()).toBe(0);
  });

  it('avança de dia quando necessário', () => {
    const from = new Date('2026-07-06T23:59:00');
    const next = nextCronAfter(parseCronExpr('0 0 * * *'), from);
    expect(next?.getDate()).toBe(7);
    expect(next?.getHours()).toBe(0);
  });
});

describe('shouldFire', () => {
  const job = (over: Partial<CronJob> = {}): CronJob => ({
    id: 'c1',
    name: 'nightly',
    schedule: '0 0 * * *',
    brief: 'roda os testes',
    status: 'active',
    workspacePath: '/ws',
    projectId: 'project-a',
    checkoutId: 'checkout-a',
    createdAt: 1,
    updatedAt: 1,
    nextFireAt: new Date('2026-07-06T00:00:00').getTime(),
    ...over,
  });

  it('dispara quando venceu e está dentro da janela', () => {
    const now = new Date('2026-07-06T00:00:30').getTime();
    expect(shouldFire(job(), now, 5 * 60_000).fire).toBe(true);
  });

  it('não dispara antes do horário', () => {
    const now = new Date('2026-07-05T23:59:00').getTime();
    expect(shouldFire(job(), now, 5 * 60_000).fire).toBe(false);
  });

  it('pula (não dispara) quando está atrasado além do teto de stale', () => {
    const now = new Date('2026-07-06T02:00:00').getTime(); // 2h atrasado
    const res = shouldFire(job(), now, 5 * 60_000);
    expect(res.fire).toBe(false);
    expect(res.stale).toBe(true);
  });

  it('job pausado nunca dispara', () => {
    const now = new Date('2026-07-06T00:00:10').getTime();
    expect(shouldFire(job({ status: 'paused' }), now, 5 * 60_000).fire).toBe(false);
  });
});

describe('createCronJob', () => {
  it('persists the project and checkout identity supplied by the caller', () => {
    const created = createCronJob(
      {
        name: 'nightly',
        schedule: '0 0 * * *',
        brief: 'run tests',
        workspacePath: '/workspace/a',
        projectId: 'project-a',
        checkoutId: 'checkout-a',
        agentName: 'qa',
      },
      new Date('2026-07-05T12:00:00').getTime(),
      () => 'cron-1',
    );

    expect(created).toMatchObject({
      workspacePath: '/workspace/a',
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      executionMode: 'shared',
    });
  });
});

describe('parseCronJobs', () => {
  it('accepts a legacy missing execution mode without making it local', () => {
    const parsed = parseCronJobs([
      {
        id: 'legacy',
        name: 'legacy',
        schedule: '0 0 * * *',
        brief: 'review',
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    expect(parsed[0].executionMode).toBeUndefined();
  });

  it('rejects malformed storage instead of silently returning no jobs', () => {
    expect(() => parseCronJobs({ jobs: [] })).toThrow();
    expect(() =>
      parseCronJobs([
        {
          id: 'bad',
          name: 'bad',
          schedule: '0 0 * * *',
          brief: 'review',
          status: 'active',
          executionMode: 'device-ish',
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    ).toThrow();
  });
});
