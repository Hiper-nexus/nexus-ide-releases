import { describe, expect, it } from 'vitest';
import {
  MISSION_LIFECYCLE_LABELS,
  missionLifecycleLabel,
} from './mission-lifecycle-copy';

describe('missionLifecycleLabel', () => {
  it('pedido humano real continua Precisa de você', () => {
    expect(MISSION_LIFECYCLE_LABELS.blocked_user).toBe('Precisa de você');
    expect(missionLifecycleLabel('blocked_user', true, 'open-question')).toBe(
      'Precisa de você',
    );
  });

  it('leftover isolado e Encerrar não herdam Precisa de você', () => {
    expect(missionLifecycleLabel('blocked_user', false, 'session-sleeping')).toBe(
      'Dormindo',
    );
    expect(missionLifecycleLabel('blocked_user', false, 'runtime-closed')).toBe(
      'Parou',
    );
    expect(missionLifecycleLabel('blocked_user', false, 'session-dead')).toBe(
      'Dormindo',
    );
  });

  it('done civil é Pronto mesmo se um reason session-dead sobrar', () => {
    expect(missionLifecycleLabel('completed')).toBe('Pronto');
    expect(missionLifecycleLabel('completed', false, 'session-dead')).toBe(
      'Pronto',
    );
  });

  it('missão completed ainda aguardando revisão humana não diz Pronto', () => {
    expect(
      missionLifecycleLabel('completed', false, undefined, true),
    ).toBe('Aguardando você');
    expect(
      missionLifecycleLabel('completed', false, 'session-dead', true),
    ).toBe('Aguardando você');
  });

  it('failed civil é Falhou mesmo se um reason session-dead sobrar', () => {
    expect(missionLifecycleLabel('failed', false, 'session-dead')).toBe(
      'Falhou',
    );
  });
});
