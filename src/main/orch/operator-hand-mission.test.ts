import { describe, expect, it, vi } from 'vitest';
import {
  announceTabMissionLeader,
  operatorHandMissionContract,
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

describe('operatorHandMissionContract — a categoria de entrega nasce no contrato (F-785)', () => {
  it('consulta materializa lane consult', () => {
    const contract = operatorHandMissionContract(
      'Investigar por que o login está lento',
      undefined,
      [],
    );
    expect(contract.lane).toBe('consult');
  });

  it('sincronização Git somente operacional materializa lane ops', () => {
    // Campo 03/10: "atualiza o repositório local com o GitHub" nasceu standard
    // e o done foi recusado sem arquivo, embora o gate aceite ops com nota.
    expect(
      operatorHandMissionContract('Atualiza o repositório local com o GitHub', undefined, []).lane,
    ).toBe('ops');
    expect(
      operatorHandMissionContract('Sync', 'Sincronizar git com git merge --ff-only origin/main', []).lane,
    ).toBe('ops');
  });

  it('pedido misto ("sincronize e corrija") NÃO usa a exceção — lane standard', () => {
    const contract = operatorHandMissionContract(
      'Sincronize o repositório e corrija o bug do login',
      undefined,
      [],
    );
    expect(contract.lane).toBe('standard');
  });

  it('trabalho de código neutro continua standard', () => {
    const contract = operatorHandMissionContract(
      'Implementar a sincronização de dados em tempo real',
      undefined,
      [],
    );
    expect(contract.lane).toBe('standard');
  });
});
