import { describe, expect, it } from 'vitest';
import { TRIAL_WARNING_DAYS, trialNotice } from './trial-notice';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-10T15:00:00Z');
const zone = { timeZone: 'America/Sao_Paulo' };
const trial = (ms: number, access = 'trial') => ({ access, trialEndsAt: new Date(NOW + ms).toISOString() });

describe('aviso de fim do teste no app', () => {
  it('só avisa quando faltam no máximo 3 dias e o acesso ainda é o teste', () => {
    expect(TRIAL_WARNING_DAYS).toBe(3);
    expect(trialNotice(trial(3 * DAY + 1000), NOW, zone)).toBeNull();
    expect(trialNotice(trial(10 * DAY), NOW, zone)).toBeNull();
    expect(trialNotice(trial(DAY, 'pro'), NOW, zone)).toBeNull();
    expect(trialNotice(trial(DAY, 'suspended'), NOW, zone)).toBeNull();
    expect(trialNotice({ access: 'trial', trialEndsAt: null }, NOW, zone)).toBeNull();
    expect(trialNotice({ access: 'trial', trialEndsAt: 'lixo' }, NOW, zone)).toBeNull();
  });

  it('conta os dias como a pessoa conta: em N dias, amanhã, hoje com a hora', () => {
    expect(trialNotice(trial(3 * DAY), NOW, zone)).toMatchObject({ daysLeft: 3, label: 'Faltam 3 dias' });
    expect(trialNotice(trial(2 * DAY - 1000), NOW, zone)).toMatchObject({ daysLeft: 2, label: 'Faltam 2 dias' });
    const tomorrow = trialNotice(trial(DAY), NOW, zone)!;
    expect(tomorrow.label).toBe('Termina amanhã');
    expect(tomorrow.detail).toMatch(/amanhã às 12:00/);
    const today = trialNotice(trial(5 * 3_600_000), NOW, zone)!;
    expect(today.label).toBe('Termina hoje');
    expect(today.detail).toMatch(/hoje às 17:00/);
  });

  it('o teste que já passou do fim não vira aviso aqui: quem manda é a tela de acesso', () => {
    expect(trialNotice(trial(-1000), NOW, zone)).toBeNull();
    expect(trialNotice(trial(-DAY, 'inactive'), NOW, zone)).toBeNull();
  });
});
