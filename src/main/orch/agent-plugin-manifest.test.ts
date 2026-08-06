import { describe, expect, it } from 'vitest';
import {
  describePluginIngestion,
  readPluginManifest,
  SUPPORTED_PLUGIN_SPEC,
} from './agent-plugin-manifest';

const VALIDO = {
  name: 'design-kit',
  version: '2.1.0',
  description: 'Agentes e skills de design',
  agents: ['ui-designer', 'a11y-architect'],
  skills: ['hallmark'],
};

describe('leitura de manifesto de plugin', () => {
  it('aceita um manifesto bem formado e enumera os componentes', () => {
    const verdict = readPluginManifest(VALIDO);

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.name).toBe('design-kit');
    expect(verdict.entries).toHaveLength(3);
    expect(verdict.degraded).toEqual([]);
  });

  /**
   * A regra mais importante deste arquivo: é aqui que conteúdo escrito por
   * outra pessoa entra. Um throw derrubaria a varredura de catálogo inteira por
   * causa de um diretório de terceiro ruim.
   */
  it.each([
    ['null', null],
    ['string', 'nem json'],
    ['array', [1, 2, 3]],
    ['objeto vazio', {}],
    ['name numérico', { name: 42, agents: ['x'] }],
  ])('nunca lança — %s vira recusa legível', (_rotulo, entrada) => {
    const verdict = readPluginManifest(entrada);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason.length).toBeGreaterThan(0);
  });

  it.each([
    '../../etc/passwd',
    '/absoluto',
    'sub/dir',
    '..',
  ])('recusa nome que é caminho: %s', (nome) => {
    const verdict = readPluginManifest({ ...VALIDO, name: nome });
    expect(verdict.ok).toBe(false);
  });

  it('nome de ITEM que é caminho é descartado, e a perda é declarada', () => {
    const verdict = readPluginManifest({
      ...VALIDO,
      agents: ['bom', '../fora', '/raiz'],
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.entries.map((e) => e.name)).toEqual(['bom', 'hallmark']);
    // Descartar em silêncio seria dizer "instalei tudo" mentindo.
    expect(verdict.degraded.some((d) => d.component === 'agents')).toBe(true);
  });

  /**
   * D1 aplicado à spec: um componente que este Nexus não conhece não invalida o
   * plugin — instala o que entende e DECLARA o que ignorou.
   */
  it('componente desconhecido degrada em vez de invalidar', () => {
    const verdict = readPluginManifest({
      ...VALIDO,
      mcpServers: ['algum-servidor'],
      hooks: ['pretool'],
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.entries).toHaveLength(3);
    expect(verdict.degraded.map((d) => d.component).sort()).toEqual([
      'hooks',
      'mcpServers',
    ]);
  });

  it('metadado solto de uma spec futura não vira alarme', () => {
    const verdict = readPluginManifest({ ...VALIDO, homepage: 'https://x.dev' });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.degraded).toEqual([]);
  });

  it('major diferente é RECUSADA, não adivinhada', () => {
    const verdict = readPluginManifest({ ...VALIDO, specVersion: '2.0.0' });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain(SUPPORTED_PLUGIN_SPEC);
  });

  it('minor mais nova da mesma major é aceita', () => {
    expect(readPluginManifest({ ...VALIDO, specVersion: '1.7.3' }).ok).toBe(true);
  });

  it('plugin sem nenhum componente ingerível é recusado, não aceito vazio', () => {
    const verdict = readPluginManifest({ name: 'vazio', hooks: ['x'] });
    expect(verdict.ok).toBe(false);
  });
});

describe('frase de ingestão', () => {
  it('conta o que entra e nomeia o que ficou de fora', () => {
    const texto = describePluginIngestion(
      readPluginManifest({ ...VALIDO, mcpServers: ['s'] }),
    );

    expect(texto).toContain('design-kit 2.1.0');
    expect(texto).toContain('2 agents');
    expect(texto).toContain('ignorado: mcpServers');
  });

  it('recusa vira frase de recusa', () => {
    expect(describePluginIngestion(readPluginManifest(null))).toContain(
      'Plugin recusado',
    );
  });
});
