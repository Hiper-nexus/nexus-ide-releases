import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ORCHESTRATOR_ADOPTION_TTL_MS,
  clearOrchestratorAdoption,
  decideOrchestratorAdoption,
  orchestratorAdoptionRefusalMessage,
  reserveOrchestratorAdoption,
  resetOrchestratorAdoptionsForTest,
  takeOrchestratorAdoption,
  type OrchestratorAdoptionReservation,
} from './orchestrator-adoption';

function reservation(
  patch: Partial<OrchestratorAdoptionReservation> = {},
): OrchestratorAdoptionReservation {
  return {
    missionId: 'mission-1',
    paneId: 'pane-1',
    sessionId: 'pty-1',
    adapterId: 'codex',
    grantAuthority: vi.fn(() => true),
    expiresAt: 10_000,
    ...patch,
  };
}

beforeEach(() => {
  resetOrchestratorAdoptionsForTest();
});

describe('reserva de adoção', () => {
  it('a leitura DESTRÓI a reserva — nunca duas adoções do mesmo pedido', () => {
    reserveOrchestratorAdoption(reservation());

    expect(takeOrchestratorAdoption('mission-1')?.paneId).toBe('pane-1');
    expect(takeOrchestratorAdoption('mission-1')).toBeNull();
  });

  it('cada missão tem a sua; ler uma não consome a outra', () => {
    reserveOrchestratorAdoption(reservation({ missionId: 'm1', paneId: 'p1' }));
    reserveOrchestratorAdoption(reservation({ missionId: 'm2', paneId: 'p2' }));

    expect(takeOrchestratorAdoption('m1')?.paneId).toBe('p1');
    expect(takeOrchestratorAdoption('m2')?.paneId).toBe('p2');
  });

  it('um start abortado pode devolver a autorização', () => {
    reserveOrchestratorAdoption(reservation());
    clearOrchestratorAdoption('mission-1');

    expect(takeOrchestratorAdoption('mission-1')).toBeNull();
  });

  it('a janela é de 2 minutos', () => {
    expect(ORCHESTRATOR_ADOPTION_TTL_MS).toBe(120_000);
  });
});

describe('decideOrchestratorAdoption — fail-safe numa direção só', () => {
  const base = {
    now: 1_000,
    sessionIsLive: true,
    adapterCanOrchestrate: true,
  };

  it('reserva viva + sessão viva + CLI capaz → adota', () => {
    const chosen = reservation();
    const decision = decideOrchestratorAdoption({ ...base, reservation: chosen });
    expect(decision).toEqual({ kind: 'adopt', reservation: chosen });
  });

  it('sem reserva → arranque normal, nunca erro', () => {
    expect(
      decideOrchestratorAdoption({ ...base, reservation: null }),
    ).toEqual({ kind: 'spawn', refusal: 'no-reservation' });
  });

  it('reserva vencida não adota — o painel indicado já não é o mesmo pedido', () => {
    expect(
      decideOrchestratorAdoption({
        ...base,
        now: 10_001,
        reservation: reservation({ expiresAt: 10_000 }),
      }),
    ).toEqual({ kind: 'spawn', refusal: 'expired' });
  });

  it('sessão morta NUNCA é adotada — viraria missão running com Maestro mudo', () => {
    expect(
      decideOrchestratorAdoption({
        ...base,
        sessionIsLive: false,
        reservation: reservation(),
      }),
    ).toEqual({ kind: 'spawn', refusal: 'session-dead' });
  });

  it('CLI que não sabe coordenar não é adotado, mesmo vivo', () => {
    expect(
      decideOrchestratorAdoption({
        ...base,
        adapterCanOrchestrate: false,
        reservation: reservation({ adapterId: 'aider' }),
      }),
    ).toEqual({ kind: 'spawn', refusal: 'adapter-cannot-orchestrate' });
  });

  it('expiração é exclusiva: exatamente no limite já venceu', () => {
    expect(
      decideOrchestratorAdoption({
        ...base,
        now: 10_000,
        reservation: reservation({ expiresAt: 10_000 }),
      }).kind,
    ).toBe('spawn');
  });
});

describe('aviso ao operador', () => {
  it('toda recusa tem frase — adoção que não acontece não é silenciosa', () => {
    for (const refusal of [
      'no-reservation',
      'expired',
      'session-dead',
      'adapter-cannot-orchestrate',
      'authority-refused',
    ] as const) {
      const message = orchestratorAdoptionRefusalMessage(refusal);
      expect(message).toContain('não assumiu a missão');
      expect(message).toContain('coordenador próprio');
    }
  });

  it('a frase nomeia o motivo concreto, não um genérico', () => {
    expect(orchestratorAdoptionRefusalMessage('session-dead')).toContain(
      'não estava mais rodando',
    );
    expect(
      orchestratorAdoptionRefusalMessage('adapter-cannot-orchestrate'),
    ).toContain('Claude ou Codex');
  });
});
