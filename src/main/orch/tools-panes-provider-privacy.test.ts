import { describe, expect, it, vi } from 'vitest';

// REGRESSAO: `nexus_pane_list_providers` devolvia `listAdapterInfos()` verbatim,
// e essa lista carrega `resolvedBinPath` — caminho ABSOLUTO do binario, que na
// pratica contem o nome de usuario do sistema operacional. Todo agente que
// listasse providers recebia esse dado, sem que nenhuma decisao dependesse
// dele: para escolher provider basta saber se esta instalado.
//
// O teste projeta o campo a partir do REGISTRY REAL (mock do modulo) em vez de
// afirmar sobre um objeto de fixture, porque o defeito era justamente repassar
// a forma do registry sem projetar.
vi.mock('../adapters/adapter-registry', () => ({
  listAdapterInfos: () => [
    {
      id: 'codex',
      label: 'Codex',
      installed: true,
      models: ['gpt-5.6-codex'],
      resolvedBinPath: '/Users/pessoa-real/.local/bin/codex',
    },
  ],
}));

import { buildPaneTools } from './tools-panes';

describe('nexus_pane_list_providers — privacidade', () => {
  it('nao devolve o caminho absoluto do binario (revela o usuario do SO)', async () => {
    const tool = buildPaneTools().find(
      (candidate) => candidate.name === 'nexus_pane_list_providers',
    );
    expect(tool).toBeDefined();

    const result = (await tool!.handler({}, {} as never, {} as never)) as
      ReadonlyArray<Record<string, unknown>>;

    expect(result).toHaveLength(1);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('pessoa-real');
    expect(serialized).not.toContain('/Users/');
    expect(result[0]).not.toHaveProperty('resolvedBinPath');
  });

  it('preserva o que a decisao de fato usa', async () => {
    const tool = buildPaneTools().find(
      (candidate) => candidate.name === 'nexus_pane_list_providers',
    );
    const result = (await tool!.handler({}, {} as never, {} as never)) as
      ReadonlyArray<Record<string, unknown>>;

    expect(result[0]).toMatchObject({
      id: 'codex',
      label: 'Codex',
      installed: true,
      models: ['gpt-5.6-codex'],
    });
  });

  // A projecao e campo a campo justamente para que campo novo do registry NAO
  // vaze por omissao. Filtro por exclusao (rest-spread) daria a garantia
  // inversa, entao o teste fixa o CONJUNTO EXATO de chaves: campo novo aqui
  // quebra o teste e obriga uma decisao consciente sobre expor ou nao.
  it('fixa o conjunto exato de chaves — campo novo nao entra por omissao', async () => {
    const tool = buildPaneTools().find(
      (candidate) => candidate.name === 'nexus_pane_list_providers',
    );
    const result = (await tool!.handler({}, {} as never, {} as never)) as
      ReadonlyArray<Record<string, unknown>>;

    expect(Object.keys(result[0]).sort()).toEqual(
      [
        'autonomousWorkspaceWriteCapable',
        'icon',
        'id',
        'idleTimeoutMs',
        'installCommand',
        'installed',
        'kind',
        'label',
        'loginHint',
        'missionControlCapable',
        'models',
        'orchestrationEvidence',
        'orchestratorCapable',
        'taskHandoffCapable',
      ].sort(),
    );
  });
});
