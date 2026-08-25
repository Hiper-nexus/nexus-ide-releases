import { describe, expect, it } from 'vitest';
import { missionBoardHeading } from './mission-board-heading';

describe('missionBoardHeading', () => {
  it('título curto sobrevive intacto', () => {
    expect(missionBoardHeading('Publicar o Nexus canônico')).toBe(
      'Publicar o Nexus canônico',
    );
  });

  it('objetivo colado com URL não vira cartaz no header (F-010)', () => {
    const raw =
      'https://admin.wordnet.com.vc/admin/conteudo aqui dentro deste painel. nao ta legal a ui nao ta. de forma facil de entender tipo e aqui que vai ter toda parte de gestao';
    const heading = missionBoardHeading(raw);
    expect(heading).not.toMatch(/^https?:\/\//u);
    expect(heading.length).toBeLessThanOrEqual(96);
    expect(heading).toMatch(/painel/i);
  });

  it('colapsa quebras de linha do objetivo', () => {
    expect(missionBoardHeading('linha um\n\nlinha dois')).toBe(
      'linha um linha dois',
    );
  });

  it('vazio vira Missão', () => {
    expect(missionBoardHeading('   ')).toBe('Missão');
  });
});
