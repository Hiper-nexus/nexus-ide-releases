import { describe, expect, it } from 'vitest';
import {
  JEV_UNAVAILABLE_LABEL,
  isJevUnavailableReason,
  parseSpawnRouteConfidence,
  parseSpawnRuleChoice,
  spawnRouteTooltip,
  type SpawnRouteInfo,
} from './spawn-route';

describe('spawn-route', () => {
  it('reconhece só motivos conhecidos', () => {
    expect(isJevUnavailableReason('no-key')).toBe(true);
    expect(isJevUnavailableReason('timeout')).toBe(true);
    expect(isJevUnavailableReason('internal-error')).toBe(true);
    expect(isJevUnavailableReason('whatever')).toBe(false);
    expect(isJevUnavailableReason(undefined)).toBe(false);
  });

  it('tem rótulo pt-BR para todo motivo', () => {
    expect(JEV_UNAVAILABLE_LABEL['no-key']).toBe('sem chave');
    for (const label of Object.values(JEV_UNAVAILABLE_LABEL)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe('parseSpawnRouteConfidence', () => {
  it('copia só as três dimensões conhecidas, arredondadas a 2 casas', () => {
    expect(
      parseSpawnRouteConfidence({ tier: 0.8349, specialty: 0.71, effort: 1, taskText: 'segredo', accountId: 'a1' }),
    ).toEqual({ tier: 0.83, specialty: 0.71, effort: 1 });
  });

  it('descarta número fora de 0..1, não finito e não numérico', () => {
    expect(parseSpawnRouteConfidence({ tier: 1.2, specialty: -0.1, effort: Number.NaN })).toBeUndefined();
    expect(parseSpawnRouteConfidence({ tier: '0.9', specialty: null })).toBeUndefined();
    expect(parseSpawnRouteConfidence({ tier: 0.7, specialty: 7 })).toEqual({ tier: 0.7 });
  });

  it('sem nada aproveitável devolve undefined, nunca objeto vazio', () => {
    expect(parseSpawnRouteConfidence(undefined)).toBeUndefined();
    expect(parseSpawnRouteConfidence(null)).toBeUndefined();
    expect(parseSpawnRouteConfidence('0.9')).toBeUndefined();
    expect(parseSpawnRouteConfidence({})).toBeUndefined();
  });
});

describe('parseSpawnRuleChoice', () => {
  it('aceita "same" e uma escolha só com adapterId/model/effort', () => {
    expect(parseSpawnRuleChoice('same')).toBe('same');
    expect(
      parseSpawnRuleChoice({
        adapterId: 'claude',
        model: 'claude-sonnet-5',
        effort: 'medium',
        reason: 'texto da tarefa',
        accountId: 'conta-1',
      }),
    ).toEqual({ adapterId: 'claude', model: 'claude-sonnet-5', effort: 'medium' });
    expect(parseSpawnRuleChoice({ adapterId: 'codex' })).toEqual({ adapterId: 'codex' });
  });

  it('rejeita o que não é uma escolha: sem adapterId, tipos errados, campos enormes', () => {
    expect(parseSpawnRuleChoice(undefined)).toBeUndefined();
    expect(parseSpawnRuleChoice('other')).toBeUndefined();
    expect(parseSpawnRuleChoice({ model: 'x' })).toBeUndefined();
    expect(parseSpawnRuleChoice({ adapterId: '   ' })).toBeUndefined();
    expect(parseSpawnRuleChoice({ adapterId: 42 })).toBeUndefined();
    expect(parseSpawnRuleChoice({ adapterId: 'x'.repeat(500) })).toBeUndefined();
    // model/effort inválidos só somem; a escolha continua válida.
    expect(parseSpawnRuleChoice({ adapterId: 'codex', model: 7, effort: '' })).toEqual({ adapterId: 'codex' });
  });
});

describe('spawnRouteTooltip', () => {
  it('objeto antigo (sem confiança nem regra) mantém o texto de sempre', () => {
    const legacy: SpawnRouteInfo = { source: 'jev' };
    expect(spawnRouteTooltip(legacy)).toBe('CLI escolhida pelo Jev para esta tarefa');
    expect(spawnRouteTooltip({ source: 'mixed' })).toBe('CLI escolhida pelo Jev para esta tarefa');
  });

  it('heurística sem queda não tem tooltip; queda mantém o texto e ignora o resto', () => {
    expect(spawnRouteTooltip({ source: 'heuristic' })).toBeNull();
    expect(spawnRouteTooltip({ source: 'heuristic', jevUnavailable: 'timeout' })).toBe(
      'CLI escolhida pela heurística — Jev tempo esgotado',
    );
    expect(
      spawnRouteTooltip({ source: 'heuristic', jevUnavailable: 'no-key', confidence: { tier: 0.9 }, ruleChoice: 'same' }),
    ).toBe('CLI escolhida pela heurística — Jev sem chave');
  });

  it('mostra a confiança por dimensão e o que a regra teria escolhido', () => {
    expect(
      spawnRouteTooltip({
        source: 'jev',
        confidence: { tier: 0.82, specialty: 0.71 },
        ruleChoice: { adapterId: 'claude', model: 'sonnet' },
      }),
    ).toBe('CLI escolhida pelo Jev (confiança: tarefa 0,82 · especialidade 0,71). A regra teria escolhido: claude/sonnet.');
  });

  it('só inclui o que existe', () => {
    expect(spawnRouteTooltip({ source: 'mixed', confidence: { effort: 0.6 } })).toBe(
      'CLI escolhida pelo Jev (confiança: esforço 0,60).',
    );
    expect(spawnRouteTooltip({ source: 'jev', ruleChoice: 'same' })).toBe(
      'CLI escolhida pelo Jev. A regra teria escolhido o mesmo.',
    );
    expect(spawnRouteTooltip({ source: 'jev', ruleChoice: { adapterId: 'codex' } })).toBe(
      'CLI escolhida pelo Jev. A regra teria escolhido: codex.',
    );
    expect(
      spawnRouteTooltip({ source: 'jev', ruleChoice: { adapterId: 'codex', model: 'gpt-5', effort: 'low' } }),
    ).toBe('CLI escolhida pelo Jev. A regra teria escolhido: codex/gpt-5 (esforço low).');
  });

  it('confiança vazia não vira "(confiança: )"', () => {
    expect(spawnRouteTooltip({ source: 'jev', confidence: {} })).toBe('CLI escolhida pelo Jev para esta tarefa');
  });

describe('parseSpawnRuleChoice: charset of ids (revisão de segurança, B6)', () => {
  it('drops ids carrying control, bidi or markup characters', () => {
    expect(parseSpawnRuleChoice({ adapterId: 'claude', model: 'sonnet\u202eevil' })).toEqual({ adapterId: 'claude' });
    expect(parseSpawnRuleChoice({ adapterId: 'cl<b>aude' })).toBeUndefined();
    expect(parseSpawnRuleChoice({ adapterId: 'codex', model: 'gpt-5.5[1m]', effort: 'xhigh' })).toEqual({
      adapterId: 'codex', model: 'gpt-5.5[1m]', effort: 'xhigh',
    });
  });
});
});
