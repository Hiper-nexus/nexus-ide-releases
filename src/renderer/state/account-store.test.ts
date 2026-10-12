/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAccountStore } from './account-store';

afterEach(() => { Reflect.deleteProperty(window, 'nexus'); });

describe('account-store falhas de edição (F-1375)', () => {
  it.each([
    ['rename', 'Não consegui renomear a conta.'],
    ['remove', 'Não consegui remover a conta.'],
  ] as const)('traduz o fallback de %s quando a rejeição não é Error', async (action, message) => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { accounts: { [action]: vi.fn().mockRejectedValue(null) } },
    });
    expect(await useAccountStore.getState()[action]('account-a', 'Conta')).toEqual({
      ok: false, error: message,
    });
  });
});
