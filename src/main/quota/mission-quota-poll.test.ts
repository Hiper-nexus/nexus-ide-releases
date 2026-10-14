import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MISSION_QUOTA_POLL_MS,
  startMissionQuotaPoll,
  stopMissionQuotaPoll,
} from './mission-quota-poll';

/**
 * F-1483: com missão viva o Main relê a cota das contas (também as inativas)
 * a cada 5 min, mesmo com a janela fechada — a troca de conta e a cadeia
 * A → B → C dependem de leitura fresca. Sem missão, nenhuma leitura.
 */
describe('F-1483: poll de cota no Main enquanto há missão', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    stopMissionQuotaPoll();
    vi.useRealTimers();
  });

  it('sem missão viva, nenhuma leitura', async () => {
    const refresh = vi.fn(async () => undefined);
    startMissionQuotaPoll({ hasLiveMission: () => false, refresh });
    await vi.advanceTimersByTimeAsync(3 * MISSION_QUOTA_POLL_MS);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('com missão viva, uma leitura por volta', async () => {
    const refresh = vi.fn(async () => undefined);
    startMissionQuotaPoll({ hasLiveMission: () => true, refresh });
    await vi.advanceTimersByTimeAsync(MISSION_QUOTA_POLL_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * MISSION_QUOTA_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('volta com a leitura anterior em voo não empilha outra', async () => {
    let finish!: () => void;
    const refresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    startMissionQuotaPoll({ hasLiveMission: () => true, refresh });
    await vi.advanceTimersByTimeAsync(3 * MISSION_QUOTA_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(MISSION_QUOTA_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('falha da leitura não derruba o poll; parar encerra as voltas', async () => {
    const refresh = vi.fn(async () => { throw new Error('provedor fora do ar'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      startMissionQuotaPoll({ hasLiveMission: () => true, refresh });
      await vi.advanceTimersByTimeAsync(2 * MISSION_QUOTA_POLL_MS);
      expect(refresh).toHaveBeenCalledTimes(2);
      stopMissionQuotaPoll();
      await vi.advanceTimersByTimeAsync(2 * MISSION_QUOTA_POLL_MS);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});
