import { describe, expect, it, vi } from 'vitest';
import type { JevResult } from '../jev/jev-client';
import type { SkillAsset } from './impeccable-manifest';
import {
  listBundledSkillCatalog,
  suggestSkillForTask,
} from './jev-skill-suggestion';

const SKILL_MD = (name: string, description: string) => `---
name: ${name}
description: ${description}
---

body of ${name}
`;

function manifest(entries: Record<string, string>): Record<string, SkillAsset> {
  return Object.fromEntries(
    Object.entries(entries).map(([k, content]) => [
      k,
      { content, encoding: 'utf8' as const },
    ]),
  );
}

function jevResult(answers: JevResult['answers']): JevResult {
  return {
    model: 'test-model',
    answers,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

const on = { enabled: () => true, hasKey: () => true };

describe('listBundledSkillCatalog', () => {
  it('parses frontmatter name/description incl. sub-skills, dedupes and caps', () => {
    const catalog = listBundledSkillCatalog(
      {
        pkgA: manifest({
          'SKILL.md': SKILL_MD('root-skill', 'root desc'),
          'helper.md': 'not a skill',
          'sub-one/SKILL.md': SKILL_MD('sub-one', 'sub desc'),
        }),
        pkgB: manifest({
          'SKILL.md': SKILL_MD('root-skill', 'duplicated name — skipped'),
          'other/SKILL.md': SKILL_MD('long', 'x'.repeat(400)),
          'noname/SKILL.md': '---\ndescription: sem nome\n---\nbody',
        }),
      },
      { 'nexus-visual-media': SKILL_MD('nexus-visual-media', 'inline desc') },
    );
    expect(catalog.map((c) => c.name)).toEqual([
      'root-skill',
      'sub-one',
      'long',
      'nexus-visual-media',
    ]);
    expect(catalog[0].pkg).toBe('pkgA');
    expect(catalog[1].pkg).toBe('pkgA');
    expect(catalog[2].pkg).toBe('pkgB');
    expect(catalog[2].description.length).toBe(300);
    expect(catalog[3].pkg).toBe('nexus-visual-media');
  });

  it('parses YAML block scalars (folded `>` and literal `|`) in description', () => {
    const catalog = listBundledSkillCatalog(
      {
        pkg: manifest({
          'SKILL.md': [
            '---',
            'name: folded',
            'description: >',
            '  Build AI-powered software',
            '  with TypeSafe.',
            'other: x',
            '---',
            'body',
          ].join('\n'),
          'lit/SKILL.md': [
            '---',
            'name: literal',
            'description: |',
            '  first line',
            '  second line',
            '---',
            'body',
          ].join('\n'),
        }),
      },
      {},
    );
    expect(catalog[0].description).toBe(
      'Build AI-powered software with TypeSafe.',
    );
    expect(catalog[1].description).toBe('first line second line');
  });

  it('real catalog: typesafe-ai description comes from the folded scalar', () => {
    const entry = listBundledSkillCatalog().find(
      (c) => c.name === 'typesafe-ai',
    );
    expect(entry?.description.startsWith(
      'Build AI-powered software with TypeSafe',
    )).toBe(true);
  });

  it('real bundled catalog has stable order, unique names and no empties', () => {
    const catalog = listBundledSkillCatalog();
    const names = catalog.map((c) => c.name);
    expect(names.length).toBeGreaterThan(5);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    expect(catalog.every((c) => c.description.length <= 300)).toBe(true);
    expect(names).toContain('nexus-visual-media');
    expect(names).toContain('nexus-pet-studio');
  });
});

describe('suggestSkillForTask', () => {
  it('returns the confident pick and records the decision', async () => {
    const record = vi.fn();
    const judge = vi.fn(async (_req: unknown) =>
      jevResult({
        skill: {
          type: 'choice',
          choice: 'impeccable',
          probabilities: { impeccable: 0.9 },
          confidence: 0.9,
        },
      }),
    );
    const suggestion = await suggestSkillForTask('refine the landing page', {
      allowedSkills: null,
      sessionId: 's1',
      deps: { judge, record, ...on },
    });
    expect(suggestion).toEqual({
      name: 'impeccable',
      pkg: 'impeccable',
      confidence: 0.9,
    });
    const request = judge.mock.calls[0][0] as {
      surface?: string;
      questions: Record<string, { criteria: Record<string, unknown> }>;
      state: Record<string, unknown>;
    };
    expect(request.surface).toBe('taskRouting');
    expect(request.questions.skill.criteria).toHaveProperty('none');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'taskRouting',
        decision: 'skill:impeccable',
      }),
    );
  });

  it('returns null when Jev picks none or is not confident', async () => {
    const judgeNone = vi.fn(async (_req: unknown) =>
      jevResult({
        skill: {
          type: 'choice',
          choice: 'none',
          probabilities: { none: 0.95 },
          confidence: 0.95,
        },
      }),
    );
    expect(
      await suggestSkillForTask('fix a typo', {
        allowedSkills: null,
        deps: { judge: judgeNone, record: vi.fn(), ...on },
      }),
    ).toBeNull();

    const judgeLow = vi.fn(async (_req: unknown) =>
      jevResult({
        skill: {
          type: 'choice',
          choice: 'impeccable',
          probabilities: { impeccable: 0.5 },
          confidence: 0.5,
        },
      }),
    );
    expect(
      await suggestSkillForTask('fix a typo', {
        allowedSkills: null,
        deps: { judge: judgeLow, record: vi.fn(), ...on },
      }),
    ).toBeNull();
  });

  it('returns null without calling judge when the surface is off or no key', async () => {
    const judge = vi.fn();
    expect(
      await suggestSkillForTask('task', {
        allowedSkills: null,
        deps: { judge, enabled: () => false, hasKey: () => true, record: vi.fn() },
      }),
    ).toBeNull();
    expect(
      await suggestSkillForTask('task', {
        allowedSkills: null,
        deps: { judge, enabled: () => true, hasKey: () => false, record: vi.fn() },
      }),
    ).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it('allowedSkills removes disallowed skills from the criteria', async () => {
    const judge = vi.fn(async (_req: unknown) =>
      jevResult({
        skill: {
          type: 'choice',
          choice: 'ponytail',
          probabilities: { ponytail: 0.9 },
          confidence: 0.9,
        },
      }),
    );
    const suggestion = await suggestSkillForTask('task', {
      allowedSkills: ['ponytail'],
      deps: { judge, record: vi.fn(), ...on },
    });
    expect(suggestion?.name).toBe('ponytail');
    const request = judge.mock.calls[0][0] as {
      questions: Record<string, { criteria: Record<string, unknown> }>;
    };
    expect(Object.keys(request.questions.skill.criteria).sort()).toEqual([
      'none',
      'ponytail',
    ]);
  });

  it('a package-level grant keeps that package sub-skills in the criteria', async () => {
    const judge = vi.fn(async (_req: unknown) =>
      jevResult({
        skill: {
          type: 'choice',
          choice: 'brainstorming',
          probabilities: { brainstorming: 0.85 },
          confidence: 0.85,
        },
      }),
    );
    const suggestion = await suggestSkillForTask('task', {
      allowedSkills: ['superpowers'],
      deps: { judge, record: vi.fn(), ...on },
    });
    const request = judge.mock.calls[0][0] as {
      questions: Record<string, { criteria: Record<string, unknown> }>;
    };
    const keys = Object.keys(request.questions.skill.criteria);
    expect('brainstorming' in request.questions.skill.criteria).toBe(true);
    expect(keys.every((k) => k === 'none' || k != 'impeccable')).toBe(true);
    expect(suggestion).toMatchObject({ name: 'brainstorming', pkg: 'superpowers' });
  });

  it('fails open to null when judge returns null or throws', async () => {
    expect(
      await suggestSkillForTask('task', {
        allowedSkills: null,
        deps: {
          judge: vi.fn(async (_req: unknown) => null),
          record: vi.fn(),
          ...on,
        },
      }),
    ).toBeNull();
    expect(
      await suggestSkillForTask('task', {
        allowedSkills: null,
        deps: {
          judge: vi.fn(async (_req: unknown) => {
            throw new Error('boom');
          }),
          record: vi.fn(),
          ...on,
        },
      }),
    ).toBeNull();
  });
});
