import { describe, expect, it } from 'vitest';
import {
  missionTitleFromGoal,
  retargetSquadInstructions,
} from './mission-identity';

describe('missionTitleFromGoal', () => {
  it('usa a primeira linha com conteúdo do objetivo', () => {
    expect(
      missionTitleFromGoal(
        '\n  Refatorar as dashboards do sistema\ncom gráficos novos',
        'Squad Velho',
      ),
    ).toBe('Refatorar as dashboards do sistema');
  });

  it('trunca objetivos longos com reticências', () => {
    const goal = 'a'.repeat(200);
    const title = missionTitleFromGoal(goal, 'fallback');
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title.endsWith('…')).toBe(true);
  });

  it('cai no fallback só com objetivo vazio', () => {
    expect(missionTitleFromGoal('   \n  ', 'Clone Overclock')).toBe(
      'Clone Overclock',
    );
  });
});

describe('retargetSquadInstructions', () => {
  it('remove a seção "# Missão" antiga e declara o objetivo vigente', () => {
    const stale = [
      '# Missão',
      'Clone Overclock — Terminal IDE Multi-CLI (macOS)',
      'Construir paridade de features.',
      '',
      '## Processo',
      'Use PREVC e delegue em paralelo.',
    ].join('\n');
    const result = retargetSquadInstructions(stale, 'Refatorar dashboards');
    expect(result).toContain('# Missão\nRefatorar dashboards');
    expect(result).not.toContain('Clone Overclock');
    expect(result).toContain('## Processo');
    expect(result).toContain('Use PREVC e delegue em paralelo.');
  });

  it('preserva instruções sem seção de missão antiga', () => {
    const clean = '## Processo\nSempre rode os testes.';
    const result = retargetSquadInstructions(clean, 'Novo objetivo');
    expect(result).toBe(`# Missão\nNovo objetivo\n\n${clean}`);
  });

  it('instruções vazias viram só o bloco do objetivo', () => {
    expect(retargetSquadInstructions('  ', 'Objetivo X')).toBe(
      '# Missão\nObjetivo X',
    );
  });

  it('instruções que são só a missão antiga viram só o objetivo novo', () => {
    const onlyStale = '# Missão\nObjetivo antigo do squad';
    expect(retargetSquadInstructions(onlyStale, 'Objetivo novo')).toBe(
      '# Missão\nObjetivo novo',
    );
  });
});
