import { describe, expect, it } from 'vitest';
import { normalizeWorkspaceVoiceName, resolveWorkspaceByVoiceName } from './workspace-name-resolver';

const ws = (name: string, path: string, lastOpenedAt = 1) => ({ name, path, lastOpenedAt });

describe('workspace voice resolver', () => {
  it('remove termos de comando, acentos e pontuação', () => {
    expect(normalizeWorkspaceVoiceName('Abra o projeto Núcleo-IDE')).toBe('nucleo ide');
  });

  it('resolve pelo nome ou basename do caminho em Windows, Linux e macOS', () => {
    expect(resolveWorkspaceByVoiceName('abre a pasta nexus ide', [ws('Nexus', '/Users/me/nexus-ide')])).toMatchObject({ kind: 'match' });
    expect(resolveWorkspaceByVoiceName('cashback', [ws('Produto', 'C:\\dev\\cashback')])).toMatchObject({ kind: 'match' });
  });

  it('não escolhe silenciosamente quando há empate', () => {
    const result = resolveWorkspaceByVoiceName('api', [ws('API', '/a/api'), ws('API', '/b/api')]);
    expect(result).toMatchObject({ kind: 'ambiguous' });
  });

  it('não transforma desconhecido em novo workspace', () => {
    expect(resolveWorkspaceByVoiceName('inexistente', [ws('Nexus', '/nexus')])).toEqual({ kind: 'not-found' });
  });
});
