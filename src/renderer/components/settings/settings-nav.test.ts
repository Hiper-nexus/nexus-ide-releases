import { describe, expect, test } from 'vitest';
import {
  SETTINGS_GROUPS,
  filterSettingsGroups,
  settingsSectionPillar,
  settingsPrimaryPillarOrder,
} from './settings-nav';

describe('SETTINGS_GROUPS', () => {
  test('covers every settings section exactly once (no duplicates, no gaps)', () => {
    const ids = SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => i.id));
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    expect(ids).toContain('account');
    expect(ids).toContain('appearance');
    expect(ids).toContain('shortcuts');
  });

  test('nav é PLANA: seções agrupadas por cabeçalho, todas sempre visíveis', () => {
    // O modelo colapsável ("Mais configurações" → grupo → item) enterrava
    // seções críticas em três cliques — regressão de operador, não volte.
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual([
      'Você',
      'App',
      'Agentes',
      'Agentes · catálogo',
      'Agentes · automação',
      'Sistema',
      'Remoto & mobile',
    ]);
    expect(settingsPrimaryPillarOrder()).toEqual([
      'you',
      'app',
      'agents',
      'system',
    ]);
  });

  test('Remoto & mobile é seção própria com companion e remote à vista', () => {
    const remoteGroup = SETTINGS_GROUPS.find(
      (g) => g.label === 'Remoto & mobile',
    );
    expect(remoteGroup).toBeDefined();
    const ids = remoteGroup?.items.map((i) => i.id);
    expect(ids).toContain('companion-relay');
    expect(ids).toContain('remote');
  });

  test('todo grupo carrega story kicker e pilar', () => {
    for (const group of SETTINGS_GROUPS) {
      expect(group.story?.length).toBeGreaterThan(8);
      expect(group.pillarId).toBeTruthy();
    }
  });

  test('grupos ficam escaneáveis: nenhum acima de 9 itens', () => {
    expect(
      Math.max(...SETTINGS_GROUPS.map((g) => g.items.length)),
    ).toBeLessThanOrEqual(9);
  });

  test('never shows the bare word "Mídia" in two different rows', () => {
    const titles = SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => i.title));
    const midia = titles.filter((t) => t.toLowerCase() === 'mídia');
    expect(midia.length).toBeLessThanOrEqual(1);
  });
});

describe('filterSettingsGroups', () => {
  test.each([
    ['entrar no Claude', 'providers'],
    ['conectar minha IA', 'providers'],
    ['aumentar letra terminal', 'terminal'],
    ['mudar tema', 'appearance'],
    ['configurar microfone', 'voice'],
    ['gastos e limites', 'usage-quota'],
  ])('encontra a intenção "%s" sem exigir o nome técnico', (query, section) => {
    expect(filterSettingsGroups(SETTINGS_GROUPS, query).flatMap(group => group.items.map(item => item.id)))
      .toContain(section);
  });

  test('combina palavras em campos diferentes sem perder palavras desconhecidas', () => {
    const ids = filterSettingsGroups(SETTINGS_GROUPS, 'terminal fonte').flatMap(group => group.items.map(item => item.id));
    expect(ids).toContain('terminal');
    expect(filterSettingsGroups(SETTINGS_GROUPS, 'terminal inexistente')).toEqual([]);
  });

  test('returns all groups unchanged for an empty query', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, '');
    expect(result).toEqual(SETTINGS_GROUPS);
  });

  test('matches on title, case-insensitively', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'voz');
    const ids = result.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain('voice');
    expect(ids).not.toContain('terminal');
  });

  test('matches English aliases without changing Portuguese labels', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'voice');
    const ids = result.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain('voice');
  });

  test('"apelido" encontra Remoto', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'apelido');
    const ids = result.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain('remote');
  });

  test('"celular" encontra o Companion mobile', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'celular');
    const ids = result.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain('companion-relay');
  });

  test('matches appearance by pixel subtitle', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'pixel');
    const ids = result.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain('appearance');
  });

  test('matches on subtitle too', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'shell');
    const ids = result.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain('terminal');
  });

  test('ignores diacritics both ways (query "atalho" finds "Atalhos")', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'atalho');
    const ids = result.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain('shortcuts');
  });

  test('drops groups that have no matching items', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'voz');
    expect(result.every((g) => g.items.length > 0)).toBe(true);
  });

  test('Clef e Cloudflare são encontrados nas chaves de API, nas equipes e na auditoria', () => {
    for (const query of ['clef', 'cloudflare', 'modelos de decisão']) {
      const ids = filterSettingsGroups(SETTINGS_GROUPS, query).flatMap((g) => g.items.map((i) => i.id));
      expect(ids, query).toContain('api-keys');
    }
    for (const query of ['clef', 'decisões dos modelos']) {
      const ids = filterSettingsGroups(SETTINGS_GROUPS, query).flatMap((g) => g.items.map((i) => i.id));
      expect(ids, query).toContain('audit');
    }
    const squads = filterSettingsGroups(SETTINGS_GROUPS, 'clef').flatMap((g) => g.items.map((i) => i.id));
    expect(squads).toContain('squads');
  });

  test('o subtítulo da auditoria fala dos modelos de decisão, não só do Jev', () => {
    const audit = SETTINGS_GROUPS.flatMap((g) => g.items).find((i) => i.id === 'audit');
    expect(audit?.subtitle).toMatch(/Clef/);
  });

  test('returns nothing for a query that matches no section', () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, 'zzzznotathing');
    expect(result).toEqual([]);
  });
});

describe('settingsSectionPillar', () => {
  test('maps every section to an endorphin pillar story', () => {
    for (const id of SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => i.id))) {
      const pillar = settingsSectionPillar(id);
      expect(pillar.story.length).toBeGreaterThan(8);
    }
  });

  test('voice lives under Você; diagnostics under Sistema', () => {
    expect(settingsSectionPillar('voice').id).toBe('you');
    expect(settingsSectionPillar('account').id).toBe('you');
    expect(settingsSectionPillar('diagnostics').id).toBe('system');
    expect(settingsSectionPillar('providers').id).toBe('agents');
  });
});
