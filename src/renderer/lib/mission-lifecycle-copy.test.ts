import { describe, expect, it } from 'vitest';
import {
  MISSION_LIFECYCLE_LABELS,
  missionLifecycleLabel,
  missionRecoveryNavigationLabel,
} from './mission-lifecycle-copy';

describe('missionRecoveryNavigationLabel', () => {
  it('points sleeping and technically blocked missions toward recovery', () => {
    expect(missionRecoveryNavigationLabel('blocked_user', 'session-sleeping')).toBe('Abrir para retomar');
    expect(missionRecoveryNavigationLabel('running', 'session-dead')).toBe('Abrir para retomar');
    expect(missionRecoveryNavigationLabel('blocked_technical')).toBe('Abrir para retomar');
  });

  it('does not offer recovery for ended missions with stale reasons or a live user question', () => {
    expect(missionRecoveryNavigationLabel('completed', 'session-dead')).toBeNull();
    expect(missionRecoveryNavigationLabel('failed', 'session-sleeping')).toBeNull();
    expect(missionRecoveryNavigationLabel('stopping', 'runtime-closed')).toBeNull();
    expect(missionRecoveryNavigationLabel('blocked_user', 'open-question')).toBeNull();
    expect(missionRecoveryNavigationLabel('running')).toBeNull();
  });
});

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

  it('completed anuncia a entrega pronta para revisar sem sugerir trabalho bloqueado', () => {
    expect(
      missionLifecycleLabel('completed', false, undefined, true),
    ).toBe('Pronto para revisar');
    expect(
      missionLifecycleLabel('completed', false, 'session-dead', true),
    ).toBe('Pronto para revisar');
  });

  it('running com Maestro ocioso é Aguardando — vivo esperando não é Trabalhando', () => {
    expect(
      missionLifecycleLabel('running', false, 'awaiting-instruction'),
    ).toBe('Aguardando');
    // O motivo vence o aviso de atenção: ocioso não é "Trabalhando · aviso".
    expect(
      missionLifecycleLabel('running', true, 'awaiting-instruction'),
    ).toBe('Aguardando');
  });

  it('running sem motivo de espera segue Trabalhando', () => {
    expect(missionLifecycleLabel('running')).toBe('Trabalhando');
    expect(missionLifecycleLabel('running', true)).toBe('Trabalhando · aviso');
  });

  it('failed civil é Falhou mesmo se um reason session-dead sobrar', () => {
    expect(missionLifecycleLabel('failed', false, 'session-dead')).toBe(
      'Falhou',
    );
  });
});
