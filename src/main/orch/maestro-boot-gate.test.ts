import { describe, expect, it } from 'vitest';
import {
  detectMaestroAuthStall,
  isMaestroOnboardingHold,
  maestroKickoffBlockReason,
} from './maestro-boot-gate';

describe('maestro-boot-gate', () => {
  it('detecta OAuth paste-code e não trata como onboarding genérico', () => {
    const tail =
      'Browser opened. Paste code here if prompted >\nWaiting…';
    expect(detectMaestroAuthStall(tail)).toMatch(/OAuth|auth login/i);
    expect(maestroKickoffBlockReason(tail)?.kind).toBe('auth');
  });

  it('detecta theme picker como onboarding hold (kickoff bloqueado)', () => {
    const tail =
      'Choose the text style that looks best with your terminal\n' +
      '1. Default\n2. ANSI';
    expect(isMaestroOnboardingHold(tail)).toBe(true);
    expect(detectMaestroAuthStall(tail)).toBeNull();
    expect(maestroKickoffBlockReason(tail)?.kind).toBe('onboarding');
  });

  it('composer limpo → sem bloqueio de kickoff', () => {
    expect(
      maestroKickoffBlockReason('Claude Code v2\n❯ ready to work'),
    ).toBeNull();
  });
});
