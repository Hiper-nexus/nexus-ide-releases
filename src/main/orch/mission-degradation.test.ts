import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  LEGITIMATE_MISSION_BLOCKS,
  describeMissionDegradation,
} from './mission-degradation';

/**
 * Doutrina D1 — NUNCA BLOQUEIE, SEMPRE DEGRADE.
 *
 * Quase toda morte do operador em 06/08 foi falta de capacidade respondida com
 * PAREDE, quando havia um resultado menor porém FUNCIONANDO disponível. Um
 * bloqueio só é legítimo quando não existe resultado menor — e aí precisa ser
 * acionável.
 */
describe('describeMissionDegradation', () => {
  it('nomeia o que foi reduzido, para quê e por quê', () => {
    const aviso = describeMissionDegradation({
      what: 'inventário do projeto',
      reducedTo: 'escritor único no próprio checkout',
      why: 'não consegui mapear áreas do repositório',
      recoverable: true,
    });

    expect(aviso).toContain('escritor único');
    expect(aviso).toContain('não consegui mapear');
  });

  it('degradação irrecuperável é dita como tal, não maquiada', () => {
    const aviso = describeMissionDegradation({
      what: 'provider de imagem',
      reducedTo: 'entrega sem foto',
      why: 'nenhuma credencial configurada',
      recoverable: false,
    });

    expect(aviso).toMatch(/não reversível|irrevers/i);
  });
});

describe('GUARDA DE BUILD — bloqueio novo exige tier degradado', () => {
  /**
   * Este teste é a doutrina virando lei. Um `throw` novo com código nomeado no
   * caminho da missão QUEBRA O BUILD a menos que entre na allowlist — e entrar
   * na allowlist exige justificar por que não existe resultado menor.
   *
   * Sem isto, D1 é prosa: daqui a três meses alguém adiciona uma parede e
   * ninguém percebe até o operador bater nela.
   */
  const MISSION_PATH_FILES = [
    'guided-mission-planner.ts',
    'mission-kickoff.ts',
    'guided-mission-prevc.ts',
  ];

  it('todo código de bloqueio no caminho da missão está na allowlist', () => {
    const encontrados = new Set<string>();
    for (const file of MISSION_PATH_FILES) {
      const full = path.join(__dirname, file);
      if (!fs.existsSync(full)) continue;
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(/"([a-z][a-z_]{6,50}):/g)) {
        encontrados.add(m[1]!);
      }
    }

    const forasteiros = [...encontrados].filter(
      (code) => !LEGITIMATE_MISSION_BLOCKS.has(code),
    );

    expect(
      forasteiros,
      'Bloqueio novo no caminho da missão sem tier degradado. Defina a ' +
        'degradação em mission-degradation.ts, ou justifique a entrada em ' +
        'LEGITIMATE_MISSION_BLOCKS explicando por que NÃO existe resultado ' +
        'menor funcionando. Ver docs/analysis/2026-08-06-degradar-nunca-errar.md.',
    ).toEqual([]);
  });

  it('a allowlist não é vazia nem irrestrita — ela nomeia exceções', () => {
    expect(LEGITIMATE_MISSION_BLOCKS.size).toBeGreaterThan(0);
    expect(LEGITIMATE_MISSION_BLOCKS.size).toBeLessThan(40);
  });
});
