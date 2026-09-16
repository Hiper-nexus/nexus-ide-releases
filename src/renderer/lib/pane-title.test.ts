import { describe, expect, it } from 'vitest';
import { normalizePaneTitle } from './pane-title';

describe('normalizePaneTitle', () => {
  it.each([
    ['⠋ nexus-ide', 'nexus-ide', 'busy'],
    ['⠙ nexus-ide', 'nexus-ide', 'busy'],
    ['⠹ Brief…', 'Brief…', 'busy'],
    ['⠸ Brief…', 'Brief…', 'busy'],
    ['⠼ Brief…', 'Brief…', 'busy'],
    ['⠴ Brief…', 'Brief…', 'busy'],
    ['⠦ Brief…', 'Brief…', 'busy'],
    ['⠧ Brief…', 'Brief…', 'busy'],
    ['⠇ Brief…', 'Brief…', 'busy'],
    ['⠏ Brief…', 'Brief…', 'busy'],
    ['⠿ workspace', 'workspace', 'busy'],
    ['◐ Brief…', 'Brief…', 'busy'],
    ['◑ Brief…', 'Brief…', 'busy'],
    ['◒ Brief…', 'Brief…', 'busy'],
    ['◓ Brief…', 'Brief…', 'busy'],
    ['✳ Pondering…', 'Pondering…', 'busy'],
    ['✻ Pondering…', 'Pondering…', 'busy'],
    ['✽ Pondering…', 'Pondering…', 'busy'],
    ['✶ Pondering…', 'Pondering…', 'busy'],
    ['✢ Pondering…', 'Pondering…', 'busy'],
    ['· nexus-ide', 'nexus-ide', 'idle'],
  ] as const)('normaliza %j -> título %j, atividade %j', (raw, title, activity) => {
    expect(normalizePaneTitle(raw)).toEqual({ title, activity });
  });

  it('não mexe em títulos sem glifo de status inicial', () => {
    expect(normalizePaneTitle('nexus-ide')).toEqual({ title: 'nexus-ide', activity: null });
    expect(normalizePaneTitle('zsh')).toEqual({ title: 'zsh', activity: null });
  });

  it('só reconhece o glifo quando está na frente — não confunde com o texto', () => {
    expect(normalizePaneTitle('nexus-ide ⠋')).toEqual({
      title: 'nexus-ide ⠋',
      activity: null,
    });
  });

  it('colapsa espaços internos repetidos', () => {
    expect(normalizePaneTitle('  nexus-ide   worktree  ')).toEqual({
      title: 'nexus-ide worktree',
      activity: null,
    });
  });

  it('colapsa o espaço entre o glifo e o texto', () => {
    expect(normalizePaneTitle('⠋   nexus-ide')).toEqual({
      title: 'nexus-ide',
      activity: 'busy',
    });
  });

  it('retorna título vazio para string vazia ou só espaços', () => {
    expect(normalizePaneTitle('')).toEqual({ title: '', activity: null });
    expect(normalizePaneTitle('   ')).toEqual({ title: '', activity: null });
  });

  it('retorna título vazio quando a mensagem é só o glifo', () => {
    expect(normalizePaneTitle('⠋')).toEqual({ title: '', activity: 'busy' });
    expect(normalizePaneTitle('·')).toEqual({ title: '', activity: 'idle' });
  });
});
