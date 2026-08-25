import { describe, expect, it } from 'vitest';
import {
  missionChromeTitle,
  missionTitleFromGoal,
  retargetSquadInstructions,
} from './mission-identity';

describe('missionChromeTitle', () => {
  it('título curto sobrevive', () => {
    expect(missionChromeTitle('Publicar o Nexus canônico')).toBe(
      'Publicar o Nexus canônico',
    );
  });

  it('objetivo colado com URL vira o hostname, não o dump (F-012)', () => {
    const raw =
      'https://admin.wordnet.com.vc/admin/conteudo aqui dentro deste painel. nao ta legal a ui nao ta. de forma facil de entender tipo e aqui que vai ter toda parte de gestao';
    expect(missionChromeTitle(raw)).toBe('admin.wordnet.com.vc');
    expect(missionChromeTitle(raw)).not.toMatch(/https?:\/\//u);
    expect(missionChromeTitle(raw)).not.toMatch(/painel/i);
  });

  it('URL no meio do pedido sai; o pedido curto fica', () => {
    expect(
      missionChromeTitle('Corrigir login em https://app.example.com/settings'),
    ).toBe('Corrigir login em');
  });

  it('vazio vira Missão', () => {
    expect(missionChromeTitle('   ')).toBe('Missão');
  });
});

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
    expect(missionTitleFromGoal('   \n  ', 'Clone Reference ADE')).toBe(
      'Clone Reference ADE',
    );
  });
});

describe('retargetSquadInstructions', () => {
  it('remove a seção "# Missão" antiga e declara o objetivo vigente', () => {
    const stale = [
      '# Missão',
      'Clone Reference ADE — Terminal IDE Multi-CLI (macOS)',
      'Construir paridade de features.',
      '',
      '## Processo',
      'Use PREVC e delegue em paralelo.',
    ].join('\n');
    const result = retargetSquadInstructions(stale, 'Refatorar dashboards');
    expect(result).toContain('# Missão\nRefatorar dashboards');
    expect(result).not.toContain('Clone Reference ADE');
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
