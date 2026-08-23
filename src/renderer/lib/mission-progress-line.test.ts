import { describe, expect, it } from 'vitest';
import {
  elapsedLabel,
  qualitativeProgress,
  MISSION_BACKGROUND_NOTICE,
} from './mission-progress-line';

const agent = (id: string, category: string, state: string) =>
  ({ id, category, state }) as never;

describe('qualitativeProgress — sinal quando não há contador', () => {
  it('conta só quem trabalha, não o coordenador', () => {
    const p = qualitativeProgress([
      agent('o', 'orchestrator', 'busy'),
      agent('a', 'executor', 'busy'),
      agent('b', 'executor', 'idle'),
    ]);
    expect(p?.line).toBe('1 de 2 trabalhando agora');
  });

  it('equipe parada não mente que está trabalhando', () => {
    const p = qualitativeProgress([
      agent('a', 'executor', 'idle'),
      agent('b', 'executor', 'idle'),
    ]);
    expect(p?.line).toBe('A equipe (2) está organizando o trabalho');
  });

  it('sem equipe devolve null — inventar seria pior', () => {
    expect(qualitativeProgress([])).toBeNull();
    expect(qualitativeProgress([agent('o', 'orchestrator', 'busy')])).toBeNull();
  });
});

describe('elapsedLabel — tempo em linguagem de gente', () => {
  it('escala de segundos a horas', () => {
    const t0 = 1_000_000;
    expect(elapsedLabel(t0, t0 + 30_000)).toBe('há menos de um minuto');
    expect(elapsedLabel(t0, t0 + 60_000)).toBe('há 1 minuto');
    expect(elapsedLabel(t0, t0 + 5 * 60_000)).toBe('há 5 minutos');
    expect(elapsedLabel(t0, t0 + 60 * 60_000)).toBe('há 1 hora');
    expect(elapsedLabel(t0, t0 + 3 * 60 * 60_000)).toBe('há 3 horas');
  });

  it('relógio torto não produz tempo negativo', () => {
    expect(elapsedLabel(2_000_000, 1_000_000)).toBeNull();
  });
});

describe('a frase que tira a ansiedade', () => {
  it('diz que o trabalho não depende da tela aberta', () => {
    expect(MISSION_BACKGROUND_NOTICE).toContain('Pode fechar esta tela');
    expect(MISSION_BACKGROUND_NOTICE).toContain('continua');
  });
});
