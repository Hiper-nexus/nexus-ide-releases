import { describe, expect, it, vi } from 'vitest';
import type { QuotaFleetSnapshot, QuotaWindow } from '../../shared/quota-types';
import {
  MAX_CONFIRMED_COOLDOWN_MS,
  extendConfirmedLimitCooldown,
  raiseConfirmedLimitCooldown,
} from './confirmed-limit-cooldown';

const HIT_AT = 1_000_000;
const NOW = HIT_AT + 1_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const hit = { kind: 'rate-limit' as const, reason: 'Claude StopFailure (limite de uso)', cooldownMs: 900_000,
  confirmed: true, confirmedAt: HIT_AT };

function window(partial: Partial<QuotaWindow>): QuotaWindow {
  return { kind: 'hours', label: '5 Horas', usedRatio: 1, source: 'provider-api', confidence: 'high', ...partial };
}
function deps(updatedAt: number, windows: QuotaWindow[], options: { refreshError?: Error; cooldownUntil?: number } = {}) {
  const setCooldown = vi.fn();
  return {
    setCooldown,
    deps: {
      refresh: async () => {
        if (options.refreshError) throw options.refreshError;
        return { updatedAt, entries: [{ id: 'claude:a', adapterId: 'claude', accountId: 'a', label: 'A',
          installed: true, onCooldown: false, updatedAt, windows }] } as unknown as QuotaFleetSnapshot;
      },
      setCooldown,
      cooldownUntil: () => options.cooldownUntil,
      now: () => NOW,
    },
  };
}
const extend = (d: ReturnType<typeof deps>['deps']) =>
  extendConfirmedLimitCooldown({ adapterId: 'claude', accountId: 'a', hit }, d);

describe('F-1484: cooldown até o reset real do limite confirmado', () => {
  it('estende até o reset da janela geral que estourou (a mais longa)', async () => {
    const d = deps(HIT_AT + 500, [
      window({ kind: 'hours', resetsAt: HIT_AT + 3 * HOUR }),
      window({ kind: 'weekly', label: 'Semanal', resetsAt: HIT_AT + 4 * DAY }),
      window({ kind: 'session', label: 'Sessão', usedRatio: 0.3, resetsAt: HIT_AT + 6 * DAY }),
    ]);
    await expect(extend(d.deps)).resolves.toBe(HIT_AT + 4 * DAY);
    expect(d.setCooldown).toHaveBeenCalledWith('a', HIT_AT + 4 * DAY, hit.reason, undefined);
  });

  it('aceita a leitura que começou no próprio instante do hit', async () => {
    const d = deps(HIT_AT, [window({ resetsAt: HIT_AT + 3 * HOUR })]);
    await expect(extend(d.deps)).resolves.toBe(HIT_AT + 3 * HOUR);
  });

  it('janela por modelo vira bloco escopado do tier, nunca bloqueio global', async () => {
    const d = deps(HIT_AT + 500, [
      window({ kind: 'weekly', label: 'Semanal (Opus)', resetsAt: HIT_AT + 5 * DAY }),
      window({ kind: 'weekly', label: 'Semanal (Modelo X)', resetsAt: HIT_AT + 6 * DAY }),
      window({ kind: 'hours', label: '5 Horas', usedRatio: 0.4, resetsAt: HIT_AT + 2 * HOUR }),
    ]);
    await expect(extend(d.deps)).resolves.toBeNull();
    expect(d.setCooldown).toHaveBeenCalledTimes(1);
    expect(d.setCooldown).toHaveBeenCalledWith('a', HIT_AT + 5 * DAY, hit.reason, 'tier:opus');
  });

  it('tiers vêm da taxonomia canônica do detector (Fable/Mythos inclusive)', async () => {
    const d = deps(HIT_AT + 500, [
      window({ kind: 'weekly', label: 'Semanal (Fable)', resetsAt: HIT_AT + 2 * DAY }),
      window({ kind: 'weekly', label: 'Semanal (Mythos)', resetsAt: HIT_AT + 3 * DAY }),
    ]);
    await expect(extend(d.deps)).resolves.toBeNull();
    expect(d.setCooldown).toHaveBeenCalledWith('a', HIT_AT + 2 * DAY, hit.reason, 'tier:fable');
    expect(d.setCooldown).toHaveBeenCalledWith('a', HIT_AT + 3 * DAY, hit.reason, 'tier:mythos');
  });

  it('teto de 7 dias para o reset declarado', async () => {
    const d = deps(HIT_AT + 500, [window({ kind: 'weekly', label: 'Semanal', resetsAt: HIT_AT + 30 * DAY })]);
    await expect(extend(d.deps)).resolves.toBe(NOW + MAX_CONFIRMED_COOLDOWN_MS);
  });

  it.each([
    ['leitura de antes do hit', deps(HIT_AT - 1, [window({ resetsAt: HIT_AT + HOUR })])],
    ['janela sem reset conhecido', deps(HIT_AT + 500, [window({ resetsAt: undefined })])],
    ['reset inválido', deps(HIT_AT + 500, [window({ resetsAt: Number.NaN })])],
    ['reset no passado', deps(HIT_AT + 500, [window({ resetsAt: HIT_AT - HOUR })])],
    ['nenhuma janela estourada', deps(HIT_AT + 500, [window({ usedRatio: 0.7, resetsAt: HIT_AT + HOUR })])],
    ['reset antes do teto curto', deps(HIT_AT + 500, [window({ resetsAt: HIT_AT + 60_000 })])],
    ['cooldown vigente já é maior', deps(HIT_AT + 500, [window({ resetsAt: HIT_AT + 2 * HOUR })], { cooldownUntil: HIT_AT + 5 * HOUR })],
    ['sonda sem resposta', deps(0, [], { refreshError: new Error('quota indisponível') })],
  ])('%s: nada muda (o cooldown nunca encolhe)', async (_label, d) => {
    await expect(extend(d.deps)).resolves.toBeNull();
    expect(d.setCooldown).not.toHaveBeenCalled();
  });

  it('confirmação depois do texto comitado: o teto curto só entra se o vigente for menor', () => {
    const longer = deps(0, [], { refreshError: new Error('sem leitura'), cooldownUntil: HIT_AT + 5 * HOUR });
    raiseConfirmedLimitCooldown({ adapterId: 'claude', accountId: 'a', hit }, longer.deps);
    expect(longer.setCooldown).not.toHaveBeenCalled();
    const shorter = deps(0, [], { refreshError: new Error('sem leitura'), cooldownUntil: HIT_AT + 60_000 });
    raiseConfirmedLimitCooldown({ adapterId: 'claude', accountId: 'a', hit }, shorter.deps);
    expect(shorter.setCooldown).toHaveBeenCalledWith('a', HIT_AT + hit.cooldownMs, hit.reason, undefined);
  });
});
