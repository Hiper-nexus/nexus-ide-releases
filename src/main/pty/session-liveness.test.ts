import { describe, expect, it } from 'vitest';
import {
  classifySessionLiveness,
  fastLaneResumeForLiveness,
  fenceBlocksOrchestratorSpawn,
} from './session-liveness';

/**
 * Rodada 2 R1 — as travas da doutrina (família deadlock cerca×fast-lane,
 * 17/08): as duas perguntas ("cerca bloqueia?" × "fast-lane dá watch?")
 * respondem com a MESMA tabela; ninguém simplifica a cerca sem passar por
 * aqui e ler o porquê.
 */
describe('classifySessionLiveness', () => {
  it('busy/idle/spawning são live', () => {
    expect(classifySessionLiveness('busy')).toBe('live');
    expect(classifySessionLiveness('idle')).toBe('live');
    expect(classifySessionLiveness('spawning')).toBe('live');
  });

  it('exited/hibernated são exited (prova física pendente)', () => {
    expect(classifySessionLiveness('exited')).toBe('exited');
    expect(classifySessionLiveness('hibernated')).toBe('exited');
  });

  it('null/undefined/desconhecido são unverifiable — nunca "morto"', () => {
    expect(classifySessionLiveness(null)).toBe('unverifiable');
    expect(classifySessionLiveness(undefined)).toBe('unverifiable');
    expect(classifySessionLiveness('estado-futuro' as never)).toBe(
      'unverifiable',
    );
  });
});

describe('contrato da cerca (trava de regressão)', () => {
  it('bloqueia spawn sobre QUALQUER liveness registrada', () => {
    expect(fenceBlocksOrchestratorSpawn('live')).toBe(true);
    expect(fenceBlocksOrchestratorSpawn('exited')).toBe(true);
    expect(fenceBlocksOrchestratorSpawn('unverifiable')).toBe(true);
  });
});

describe('decisão do fast-lane', () => {
  it('live → watch; exited/unverifiable → respawn', () => {
    expect(fastLaneResumeForLiveness('live')).toBe('watch');
    expect(fastLaneResumeForLiveness('exited')).toBe('respawn');
    expect(fastLaneResumeForLiveness('unverifiable')).toBe('respawn');
  });
});
