import { describe, expect, it, vi } from 'vitest';
import { assertWorkerBudget } from '../../shared/mission-intent';
import {
  announceTabMissionLeader,
  operatorHandMissionContract,
  operatorHandMissionLane,
  tabMissionLeaderNotice,
} from './operator-hand-mission';

describe('aviso ao pane promovido a orquestrador da aba', () => {
  it('cola uma linha só dizendo qual missão ele orquestra', async () => {
    const inject = vi.fn(async () => {});
    expect(await announceTabMissionLeader('pty-b', 'Missão · Login', inject)).toBe(true);
    expect(inject).toHaveBeenCalledWith('pty-b', expect.stringContaining('Você agora orquestra a Missão · Login'));
    expect(tabMissionLeaderNotice('Missão\n· Login')).not.toContain('\n');
  });

  it('falhar em avisar não derruba nada', async () => {
    const inject = vi.fn(async () => {
      throw new Error('session is gone');
    });
    expect(await announceTabMissionLeader('pty-b', 'Missão · Login', inject)).toBe(false);
  });
});

/**
 * F-810 (B6): a versão anterior deste bloco afirmava `lane: consult` como o
 * comportamento DESEJADO e nunca olhava `maxWorkers` — era justamente a lane
 * que zerava o orçamento e fazia o pane do operador, promovido a orquestrador,
 * recusar todo `nexus_pane_spawn`.
 */
describe('operatorHandMissionContract — a missão hospeda helpers (F-810)', () => {
  // Títulos/abas do relatório de revisão que viravam consult/plan/ops (maxWorkers 0).
  it.each([
    'Missão · Analise o módulo de pagamentos e liste os riscos',
    'Missão · Investigue por que o build falha',
    'Missão · Audite as dependências do projeto',
    'Missão · Mapeie os endpoints da API',
    'Missão · Entender como funciona o checkout',
    'Missão · Planejar a arquitetura do módulo',
    'Investigar por que o login está lento',
    'Deploy',
    'Backups',
    'Servidor',
    'Publicar site',
    'Migrar banco',
    'Atualizar repo',
    'Auditoria',
    'Análise de logs',
    'Diagnóstico do app',
    'Planejamento',
    'Missão · Atualiza o repositório local com o GitHub',
  ])('"%s" nasce standard e com orçamento para abrir worker', (title) => {
    const contract = operatorHandMissionContract(title, undefined, []);

    expect(contract.lane).toBe('standard');
    expect(contract.budgets.maxWorkers).toBeGreaterThan(0);
    expect(assertWorkerBudget(contract, 0)).toEqual({ ok: true });
  });

  it('a descrição também não rebaixa a missão: o pedido de análise abre helper', () => {
    const contract = operatorHandMissionContract(
      'Missão · Login',
      'Analise o fluxo de login e liste os riscos',
      [],
    );
    expect(contract.lane).toBe('standard');
    expect(assertWorkerBudget(contract, 0)).toEqual({ ok: true });
  });

  it('sem a opção, nem a sincronização explícita muda a lane (o pane hospeda o helper)', () => {
    // "+ Pane": o título é o pedido do 1º helper — se fosse ops, o próprio
    // helper que motivou a missão seria recusado (maxWorkers 0).
    const contract = operatorHandMissionContract(
      'Missão · Atualiza o repositório local com o GitHub',
      undefined,
      [],
    );
    expect(contract.lane).toBe('standard');
    expect(assertWorkerBudget(contract, 0)).toEqual({ ok: true });
  });

  it('nexus_mission_create: sincronização explícita do repositório materializa ops (F-785)', () => {
    // Campo 03/10: "atualiza o repositório local com o GitHub" nasceu standard
    // e o done foi recusado sem arquivo, embora o gate aceite ops com nota.
    for (const goal of [
      'Atualiza o repositório local com o GitHub',
      'Sincronizar git com git merge --ff-only origin/main',
    ]) {
      expect(operatorHandMissionContract(goal, undefined, [], { recognizeGitSync: true }).lane).toBe('ops');
    }
    expect(
      operatorHandMissionContract('Sync', 'Sincronizar git com git merge --ff-only origin/main', [], {
        recognizeGitSync: true,
      }).lane,
    ).toBe('ops');
  });

  it.each([
    'Investigar por que o login está lento',
    'Analise o fluxo de login e liste os riscos',
    'Planejar a arquitetura do módulo de pagamentos',
    'Deploy do site no servidor',
    'Sincronize o repositório e corrija o bug do login',
    'Implementar a sincronização de dados em tempo real',
    'Atualize as dependências do repositório',
    'Atualizar o workflow do GitHub Actions',
    'Atualize o README do repositório',
    'Investigue por que o git pull falha',
  ])('nexus_mission_create: "%s" NUNCA vira consult/plan/ops, mesmo com recognizeGitSync', (goal) => {
    const contract = operatorHandMissionContract(goal, undefined, [], { recognizeGitSync: true });

    expect(contract.lane).toBe('standard');
    expect(assertWorkerBudget(contract, 0)).toEqual({ ok: true });
  });

  it('operatorHandMissionLane só devolve ops ou nada', () => {
    expect(operatorHandMissionLane('git pull --ff-only')).toBe('ops');
    expect(operatorHandMissionLane('Analise o fluxo de login')).toBeUndefined();
    expect(operatorHandMissionLane('Planejar a arquitetura')).toBeUndefined();
    expect(operatorHandMissionLane('Deploy')).toBeUndefined();
  });
});
