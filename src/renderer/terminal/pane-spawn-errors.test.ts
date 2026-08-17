import { describe, expect, it } from 'vitest';
import {
  clearPaneSpawnError,
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
});
