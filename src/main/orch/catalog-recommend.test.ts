import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JevResult } from '../jev/jev-client';
import type { CatalogEntry } from './catalog-contract';
import {
  CATALOG_AREA_RULES,
  __resetCatalogRecommendationsForTests,
  areaCandidates,
  buildCatalogPickQuestion,
  catalogQuestionKey,
  detectCatalogAreas,
  parseCatalogPick,
  recommendCatalogItems,
} from './catalog-recommend';

const agent = (slug: string): CatalogEntry => {
  const parts = slug.split('/');
  return { kind: 'agent', slug, name: parts[parts.length - 1], category: parts[0] };
};
const skill = (slug: string): CatalogEntry => ({ ...agent(slug), kind: 'skill' });

const rule = (id: string) => CATALOG_AREA_RULES.find((candidate) => candidate.id === id)!;

function write(root: string, rel: string, content = ''): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('áreas do projeto pelos próprios arquivos (F-757)', () => {
  let root: string;
  let outside: string;
  let link: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-catrec-root-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-catrec-outside-'));
    link = path.join(root, 'linked');
  });

  afterEach(() => {
    // O link sai antes da remoção recursiva (F-663).
    fs.rmSync(link, { recursive: false, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('lê o monorepo como o hipergo: web React, API Go, OpenTofu e compose', async () => {
    write(root, 'package.json', JSON.stringify({ workspaces: ['apps/web'], devDependencies: { '@redocly/cli': '1' } }));
    write(
      root,
      'apps/web/package.json',
      JSON.stringify({
        dependencies: { react: '19', tailwindcss: '4' },
        devDependencies: { vitest: '3' },
      }),
    );
    write(root, 'go.work', 'go 1.26\n');
    write(root, 'infra/opentofu/main.tf', 'terraform {}\n');
    write(root, 'deploy/compose/docker-compose.yml', 'services: {}\n');
    // Dependência instalada não é stack do projeto.
    write(root, 'node_modules/next/package.json', JSON.stringify({ dependencies: { next: '15' } }));
    // Link que sai do projeto também não.
    write(outside, 'Cargo.toml', '[package]\n');
    fs.symlinkSync(outside, link, 'junction');

    const areas = await detectCatalogAreas(root);
    expect(areas.map((area) => [area.label, area.evidence])).toEqual([
      ['React', 'apps/web/package.json'],
      ['Tailwind CSS', 'apps/web/package.json'],
      ['API com OpenAPI', 'package.json'],
      ['Testes', 'apps/web/package.json'],
      ['Go', 'go.work'],
      ['Docker', 'deploy/compose/docker-compose.yml'],
      ['Infra como código', 'infra/opentofu/main.tf'],
    ]);
  });

  it('Python: o framework sai do requirements, não do nome da pasta', async () => {
    write(root, 'requirements.txt', 'fastapi==0.115\nuvicorn\n');
    write(root, 'django-notes/README.md', 'notas');
    const labels = (await detectCatalogAreas(root)).map((area) => area.label);
    expect(labels).toEqual(['Python', 'FastAPI']);
  });

  it('Gemfile do fastlane de um app mobile não é Ruby; o de um app Rails é', async () => {
    // Medido no nexus-ide: mobile/Gemfile (fastlane) virava a área Ruby.
    write(root, 'mobile/package.json', JSON.stringify({ dependencies: { expo: '54' } }));
    write(root, 'mobile/app.json', '{}');
    write(root, 'mobile/Gemfile', "gem 'fastlane'\n");
    write(root, 'mobile/fastlane/Fastfile', '');
    expect((await detectCatalogAreas(root)).map((area) => area.label)).toEqual(['App mobile']);

    write(root, 'backend/Gemfile', "gem 'rails'\n");
    write(root, 'backend/config.ru', '');
    const ruby = (await detectCatalogAreas(root)).find((area) => area.label === 'Ruby');
    expect(ruby?.evidence).toBe('backend/Gemfile');
  });

  it('pasta vazia não tem área', async () => {
    expect(await detectCatalogAreas(root)).toEqual([]);
  });
});

describe('candidatos por área', () => {
  const agents = [
    agent('development-team/expert-react-frontend-engineer'),
    agent('web-tools/react-performance-optimizer'),
    agent('development-team/react-specialist'),
    agent('mobile/react-native-expert'),
    agent('development-team/frontend-developer'),
  ];

  it('casa pelo nome, tira React Native da área React e põe primeiro quem começa pela área', () => {
    expect(areaCandidates(rule('react'), agents, new Set()).map((entry) => entry.name)).toEqual([
      'react-specialist',
      'react-performance-optimizer',
      'expert-react-frontend-engineer',
    ]);
  });

  it('o que já está instalado (ou já vem com o Nexus) não vira opção', () => {
    const excluded = new Set(['agent:react-specialist']);
    expect(areaCandidates(rule('react'), agents, excluded).map((entry) => entry.name)).not.toContain(
      'react-specialist',
    );
  });

  it('nome repetido em duas categorias aparece uma vez; no máximo 12 opções', () => {
    const many = Array.from({ length: 20 }, (_, index) => skill(`cat${index % 2}/test-kit-${Math.floor(index / 2)}`));
    const options = areaCandidates(rule('testing'), many, new Set());
    expect(options).toHaveLength(10);
    expect(new Set(options.map((entry) => entry.name)).size).toBe(10);
    const wide = Array.from({ length: 30 }, (_, index) => skill(`qa/test-kit-${index}`));
    expect(areaCandidates(rule('testing'), wide, new Set())).toHaveLength(12);
  });
});

describe('pergunta e resposta', () => {
  const options = [agent('development-team/react-specialist'), agent('web-tools/react-performance-optimizer')];

  it('opções por posição, com none', () => {
    const question = buildCatalogPickQuestion({ label: 'React' }, 'agent', options);
    expect(question.type).toBe('choice');
    expect(Object.keys((question as { criteria: Record<string, string> }).criteria)).toEqual(['o1', 'o2', 'none']);
    expect(catalogQuestionKey('node-backend', 'skill')).toBe('node_backend_skill');
  });

  it('aceita só escolha dentro das opções com confiança ≥ 0,7', () => {
    const answer = (choice: string, confidence: number) =>
      ({ type: 'choice', choice, confidence, probabilities: {} }) as const;
    expect(parseCatalogPick(answer('o2', 0.83), options)?.entry.name).toBe('react-performance-optimizer');
    expect(parseCatalogPick(answer('none', 0.95), options)).toBeNull();
    expect(parseCatalogPick(answer('o1', 0.69), options)).toBeNull();
    expect(parseCatalogPick(answer('o3', 0.9), options)).toBeNull();
    expect(parseCatalogPick(undefined, options)).toBeNull();
  });
});

describe('recommendCatalogItems', () => {
  const index = {
    agents: [agent('development-team/react-specialist'), agent('development-team/golang-pro'), agent('x/go-mcp-expert')],
    skills: [skill('development/react-best-practices'), skill('development/golang-pro'), skill('development/test-fixing')],
    provenance: { repository: 'davila7/claude-code-templates', commitSha: 'a'.repeat(40) },
  };
  const areas = [
    { id: 'react', label: 'React', evidence: 'apps/web/package.json' },
    { id: 'go', label: 'Go', evidence: 'go.work' },
  ];
  const result = (answers: JevResult['answers']): JevResult => ({
    model: 'jev-test',
    answers,
    usage: { input_tokens: 100, output_tokens: 5 },
    route: { provider: 'jev', model: 'jev-test', policyVersion: 'jev-clef-v1', evidence: 'manual', reason: 'test' },
  });
  const choice = (option: string, confidence: number) =>
    ({ type: 'choice', choice: option, confidence, probabilities: {} }) as const;

  beforeEach(() => __resetCatalogRecommendationsForTests());

  function deps(judge: ReturnType<typeof vi.fn>) {
    return {
      judge: judge as never,
      enabled: () => true,
      hasKey: () => true,
      record: vi.fn(() => ''),
      detectAreas: async () => areas,
      now: () => 1_000,
    };
  }

  it('um lote só; ao modelo vão só os rótulos e os nomes, nunca o caminho', async () => {
    const judge = vi.fn(async (_input: unknown) =>
      result({
        react_agent: choice('o1', 0.88),
        react_skill: choice('o1', 0.74),
        go_agent: choice('none', 0.9),
        go_skill: choice('o1', 0.66),
      }),
    );
    const out = await recommendCatalogItems({
      root: '/w/hipergo',
      index,
      installed: [{ kind: 'skill', name: 'test-fixing' }],
      deps: deps(judge),
    });
    expect(judge).toHaveBeenCalledTimes(1);
    const input = judge.mock.calls[0]![0] as { state: unknown; questions: Record<string, unknown>; surface: string };
    expect(input.surface).toBe('catalogPick');
    expect((input as { orderCheck?: unknown }).orderCheck).toEqual({ minConfidence: 0.7 });
    expect(input.state).toEqual({ stack: ['React', 'Go'] });
    expect(Object.keys(input.questions)).toEqual(['react_agent', 'react_skill', 'go_agent', 'go_skill']);
    const sent = JSON.stringify(input);
    expect(sent).not.toContain('package.json');
    expect(sent).not.toContain('hipergo');
    expect(sent).not.toContain('test-fixing');
    expect(out).toEqual({
      ok: true,
      areas,
      provider: 'jev',
      decidedAt: 1_000,
      recommendations: [
        {
          kind: 'agent',
          slug: 'development-team/react-specialist',
          name: 'react-specialist',
          category: 'development-team',
          areas: ['React'],
          evidence: ['apps/web/package.json'],
          confidence: 0.88,
        },
        {
          kind: 'skill',
          slug: 'development/react-best-practices',
          name: 'react-best-practices',
          category: 'development',
          areas: ['React'],
          evidence: ['apps/web/package.json'],
          confidence: 0.74,
        },
      ],
    });
  });

  it('a mesma resposta vale 24 h; Recalcular pergunta de novo', async () => {
    const judge = vi.fn(async () => result({ react_agent: choice('o1', 0.9) }));
    const d = deps(judge);
    await recommendCatalogItems({ root: '/w/p', index, installed: [], deps: d });
    await recommendCatalogItems({ root: '/w/p', index, installed: [], deps: d });
    expect(judge).toHaveBeenCalledTimes(1);
    await recommendCatalogItems({ root: '/w/p', index, installed: [], refresh: true, deps: d });
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('sem superfície, sem credencial, sem área ou sem resposta: motivo, nunca exceção', async () => {
    const judge = vi.fn(async () => null);
    const base = { root: '/w/p', index, installed: [] };
    expect(await recommendCatalogItems({ ...base, deps: { ...deps(judge), enabled: () => false } })).toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(await recommendCatalogItems({ ...base, deps: { ...deps(judge), hasKey: () => false } })).toEqual({
      ok: false,
      reason: 'no-credential',
    });
    expect(
      await recommendCatalogItems({ ...base, deps: { ...deps(judge), detectAreas: async () => [] } }),
    ).toEqual({ ok: false, reason: 'no-areas', areas: [] });
    expect(judge).not.toHaveBeenCalled();
    expect(await recommendCatalogItems({ ...base, deps: deps(judge) })).toMatchObject({
      ok: false,
      reason: 'no-answer',
    });
    const throwing = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await recommendCatalogItems({ ...base, refresh: true, deps: deps(throwing) })).toMatchObject({
      ok: false,
      reason: 'no-answer',
    });
  });
});
