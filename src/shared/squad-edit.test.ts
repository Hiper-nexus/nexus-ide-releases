import { describe, expect, it } from 'vitest';
import { applySquadEdit, duplicateSquad, type EditableSquad } from './squad-edit';

const builtin: EditableSquad = {
  id: 'nexus-full',
  name: 'Full-Stack',
  createdAt: '1000',
  builtin: true,
  orchestratorInstructions: 'orquestre',
  agents: [
    { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', model: 'claude-sonnet-5' },
    { id: 'exec', agentName: 'Executor', category: 'executor', cli: 'codex', model: 'gpt-5.5' },
  ],
};

const userSquad: EditableSquad = { ...builtin, id: 'meu-time', builtin: false, name: 'Meu Time' };

describe('applySquadEdit', () => {
  it('edita um squad de usuário no lugar (mesmo id, builtin false)', () => {
    const out = applySquadEdit(userSquad, { name: 'Meu Time 2' }, 'user-2');
    expect(out.id).toBe('meu-time'); // preserva id
    expect(out.name).toBe('Meu Time 2');
    expect(out.builtin).toBe(false);
  });

  it('editar um builtin cria uma CÓPIA (novo id, builtin false) — builtins são gerenciados pelo app', () => {
    const out = applySquadEdit(builtin, { name: 'Full-Stack Custom' }, 'novo-123');
    expect(out.id).toBe('novo-123');
    expect(out.id).not.toBe('nexus-full');
    expect(out.builtin).toBe(false);
    expect(out.name).toBe('Full-Stack Custom');
  });

  it('aplica patch de roster preservando o resto', () => {
    const newRoster = [
      { id: 'orch', agentName: 'Maestro', category: 'orchestrator' as const, cli: 'kimi', model: 'kimi-code/kimi-for-coding' },
    ];
    const out = applySquadEdit(userSquad, { agents: newRoster }, 'x');
    expect(out.agents).toHaveLength(1);
    expect(out.agents[0].cli).toBe('kimi');
    expect(out.orchestratorInstructions).toBe('orquestre');
  });

  it('não muta o squad de origem (imutabilidade)', () => {
    const snapshot = JSON.stringify(userSquad);
    applySquadEdit(userSquad, { name: 'outro' }, 'x');
    expect(JSON.stringify(userSquad)).toBe(snapshot);
  });

  it('rejeita roster sem orquestrador', () => {
    expect(() =>
      applySquadEdit(userSquad, {
        agents: [{ id: 'e', agentName: 'E', category: 'executor', cli: 'codex' }],
      }, 'x'),
    ).toThrow(/orquestrador/i);
  });

  it('rejeita nome vazio', () => {
    expect(() => applySquadEdit(userSquad, { name: '   ' }, 'x')).toThrow(/nome/i);
  });
});

describe('duplicateSquad', () => {
  it('duplica com novo id, builtin false e sufixo no nome', () => {
    const out = duplicateSquad(builtin, 'dup-1');
    expect(out.id).toBe('dup-1');
    expect(out.builtin).toBe(false);
    expect(out.name).toContain('Full-Stack');
    expect(out.name).not.toBe('Full-Stack'); // sufixo distingue
    expect(out.agents).toEqual(builtin.agents);
  });
});
