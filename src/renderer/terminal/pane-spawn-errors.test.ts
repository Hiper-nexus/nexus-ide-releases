import { describe, expect, it } from 'vitest';
import {
  clearPaneSpawnError,
  peekPaneSpawnRelogin,
  recordPaneSpawnError,
  takePaneSpawnError,
} from './pane-spawn-errors';

describe('pane spawn errors', () => {
  it('take devolve o erro gravado uma única vez e limpa o registro', () => {
    recordPaneSpawnError(
      'pane-1',
      'exclusive auth family claude-shared-login already has a live orchestrator',
    );
    expect(takePaneSpawnError('pane-1')).toBe(
      'exclusive auth family claude-shared-login already has a live orchestrator',
    );
    expect(takePaneSpawnError('pane-1')).toBeNull();
  });

  it('pane sem erro gravado devolve null', () => {
    expect(takePaneSpawnError('pane-nunca-visto')).toBeNull();
  });

  it('clear apaga sem consumir e um novo erro sobrescreve o anterior', () => {
    recordPaneSpawnError('pane-2', 'primeiro');
    clearPaneSpawnError('pane-2');
    expect(takePaneSpawnError('pane-2')).toBeNull();
    recordPaneSpawnError('pane-2', 'segundo');
    expect(takePaneSpawnError('pane-2')).toBe('segundo');
  });

  it('guarda a conta a reautenticar só junto do erro da mesma tentativa (F-1637)', () => {
    const relogin = { adapterId: 'claude', accountId: 'acct-b', accountLabel: 'conta b' };
    recordPaneSpawnError('pane-3', 'A sessão de “conta b” expirou', relogin);
    expect(peekPaneSpawnRelogin('pane-3')).toEqual(relogin);
    // A tentativa seguinte, com outro motivo, não herda o botão da anterior.
    recordPaneSpawnError('pane-3', 'cli_missing');
    expect(peekPaneSpawnRelogin('pane-3')).toBeNull();
    recordPaneSpawnError('pane-3', 'A sessão de “conta b” expirou', relogin);
    clearPaneSpawnError('pane-3');
    expect(peekPaneSpawnRelogin('pane-3')).toBeNull();
  });

  it('formato fora do contrato não vira botão', () => {
    recordPaneSpawnError('pane-4', 'x', { adapterId: 'claude', accountId: '../../etc', accountLabel: 'x' });
    expect(peekPaneSpawnRelogin('pane-4')).toBeNull();
    recordPaneSpawnError('pane-4', 'x', { adapterId: 'claude', accountId: 'acct-b', accountLabel: 'x', token: 'y' });
    expect(peekPaneSpawnRelogin('pane-4')).toBeNull();
    takePaneSpawnError('pane-4');
  });
});
