import { describe, expect, it } from 'vitest';
import {
  BOOT_STALL_MS,
  shouldEscalateStall,
  shouldFlagStall,
  shouldReapNonExecutingBoot,
  STALL_MS,
  STALL_PROBE_GRACE_MS,
} from './stall-watchdog';

const NOW = 10_000_000;

function candidate(overrides: Partial<Parameters<typeof shouldFlagStall>[0]> = {}) {
  return {
    role: 'worker' as const,
    state: 'busy',
    lastActivityAt: NOW - STALL_MS - 1,
    alreadyFlagged: false,
    ...overrides,
  };
}

describe('shouldFlagStall', () => {
  it('flagra worker busy em silêncio além do limite', () => {
    expect(shouldFlagStall(candidate(), NOW)).toBe(true);
  });

  it('não flagra silêncio abaixo do limite', () => {
    expect(shouldFlagStall(candidate({ lastActivityAt: NOW - STALL_MS + 5_000 }), NOW)).toBe(
      false,
    );
  });

  it('nunca flagra orquestrador nem pane do usuário', () => {
    expect(shouldFlagStall(candidate({ role: 'orchestrator' }), NOW)).toBe(false);
    expect(shouldFlagStall(candidate({ role: undefined }), NOW)).toBe(false);
  });

  it('worker idle/exited não é stall — ele terminou ou está esperando', () => {
    expect(shouldFlagStall(candidate({ state: 'idle' }), NOW)).toBe(false);
    expect(shouldFlagStall(candidate({ state: 'exited' }), NOW)).toBe(false);
  });

  it('não re-alerta sessão já sinalizada (anti-spam)', () => {
    expect(shouldFlagStall(candidate({ alreadyFlagged: true }), NOW)).toBe(false);
  });
});

function probed(
  overrides: Partial<Parameters<typeof shouldEscalateStall>[0]> = {},
) {
  return {
    role: 'worker' as const,
    state: 'busy',
    probedAt: NOW - STALL_PROBE_GRACE_MS - 1,
    lastActivityAt: NOW - STALL_MS - STALL_PROBE_GRACE_MS,
    alreadyEscalated: false,
    ...overrides,
  };
}

describe('shouldEscalateStall', () => {
  it('escala quando a probe não foi respondida dentro da carência', () => {
    expect(shouldEscalateStall(probed(), NOW)).toBe(true);
  });

  it('não escala antes da carência da probe vencer', () => {
    expect(
      shouldEscalateStall(
        probed({ probedAt: NOW - STALL_PROBE_GRACE_MS + 5_000 }),
        NOW,
      ),
    ).toBe(false);
  });

  it('probe RESPONDIDA (atividade após a probe) nunca escala', () => {
    expect(
      shouldEscalateStall(probed({ lastActivityAt: NOW - 1_000 }), NOW),
    ).toBe(false);
  });

  it('sem probe enviada não há o que escalar', () => {
    expect(shouldEscalateStall(probed({ probedAt: null }), NOW)).toBe(false);
  });

  it('é idempotente — escala uma vez só', () => {
    expect(shouldEscalateStall(probed({ alreadyEscalated: true }), NOW)).toBe(
      false,
    );
  });

  it('nunca escala não-worker', () => {
    expect(shouldEscalateStall(probed({ role: 'orchestrator' }), NOW)).toBe(
      false,
    );
  });

  it('worker que saiu não escala por esta via (o exit tem dono próprio)', () => {
    expect(shouldEscalateStall(probed({ state: 'exited' }), NOW)).toBe(false);
  });

  it('a carência da probe é menor que o próprio limite de stall', () => {
    expect(STALL_PROBE_GRACE_MS).toBeLessThan(STALL_MS);
    expect(STALL_PROBE_GRACE_MS).toBeGreaterThanOrEqual(60_000);
  });
});

function bootCandidate(
  overrides: Partial<Parameters<typeof shouldReapNonExecutingBoot>[0]> = {},
) {
  return {
    role: 'worker' as const,
    state: 'idle',
    everExecuted: false,
    bootAt: NOW - BOOT_STALL_MS - 1,
    alreadyReaped: false,
    ...overrides,
  };
}

describe('shouldReapNonExecutingBoot', () => {
  it('reapa worker que nasceu e nunca executou além da janela de boot', () => {
    expect(shouldReapNonExecutingBoot(bootCandidate(), NOW)).toBe(true);
  });

  it('não reapa dentro da janela de boot (ainda pode iniciar)', () => {
    expect(
      shouldReapNonExecutingBoot(
        bootCandidate({ bootAt: NOW - BOOT_STALL_MS + 5_000 }),
        NOW,
      ),
    ).toBe(false);
  });

  it('NUNCA reapa worker que executou normalmente (sem falso-positivo)', () => {
    expect(
      shouldReapNonExecutingBoot(bootCandidate({ everExecuted: true }), NOW),
    ).toBe(false);
  });

  it('não reapa worker que já saiu do idle (engajou a tarefa)', () => {
    expect(shouldReapNonExecutingBoot(bootCandidate({ state: 'busy' }), NOW)).toBe(
      false,
    );
    expect(
      shouldReapNonExecutingBoot(bootCandidate({ state: 'waiting' }), NOW),
    ).toBe(false);
  });

  it('nunca reapa orquestrador nem pane do usuário', () => {
    expect(
      shouldReapNonExecutingBoot(bootCandidate({ role: 'orchestrator' }), NOW),
    ).toBe(false);
    expect(
      shouldReapNonExecutingBoot(bootCandidate({ role: undefined }), NOW),
    ).toBe(false);
  });

  it('não re-reapa pane já reapeado (idempotência)', () => {
    expect(
      shouldReapNonExecutingBoot(bootCandidate({ alreadyReaped: true }), NOW),
    ).toBe(false);
  });

  it('ignora pane já morto', () => {
    expect(
      shouldReapNonExecutingBoot(bootCandidate({ state: 'exited' }), NOW),
    ).toBe(false);
  });
});
