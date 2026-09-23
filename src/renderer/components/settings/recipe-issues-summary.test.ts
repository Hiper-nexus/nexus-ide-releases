import { describe, expect, it } from 'vitest';
import type { RecipeLintIssue } from '../../../shared/types';
import {
  recipeIssueKind,
  sortRecipeIssues,
  summarizeRecipeIssues,
} from './recipe-issues-summary';

function issue(partial: Partial<RecipeLintIssue>): RecipeLintIssue {
  return {
    severity: 'error',
    squadId: 'web',
    squadName: 'Web',
    field: 'allowedTools',
    ref: 'nexus_x',
    message: 'm',
    ...partial,
  };
}

describe('summarizeRecipeIssues', () => {
  it('reports verified resources when nothing is pending', () => {
    expect(summarizeRecipeIssues([])).toEqual({
      tone: 'ok',
      label: 'Recursos verificados',
      reason: null,
    });
  });

  it('counts flows (not lint rows), stays neutral and names the main reason', () => {
    const summary = summarizeRecipeIssues([
      issue({ squadId: 'web', ref: 'a' }),
      issue({ squadId: 'web', ref: 'b' }),
      issue({ squadId: 'api', ref: 'c' }),
      issue({ squadId: 'api', field: 'allowedSkills', ref: 'skill-x' }),
    ]);
    expect(summary.tone).toBe('neutral');
    expect(summary.label).toBe('2 fluxos com ajustes pendentes');
    expect(summary.reason).toContain('3 ferramentas citadas não existem');
    expect(summary.reason).toContain('1 outro ajuste');
    expect(summary.reason).toContain('continuam disponíveis');
    expect(summary.label).not.toMatch(/PENDÊNCIAS|pendências/);
  });

  it('uses singular copy for a single flow and reason', () => {
    const summary = summarizeRecipeIssues([issue({ ref: '*' })]);
    expect(summary.label).toBe('1 fluxo com ajustes pendentes');
    expect(summary.reason).toContain('1 agente usa todas as ferramentas');
    expect(summary.reason).not.toContain('outro');
  });
});

describe('recipe issue kinds', () => {
  it('classifies each lint shape', () => {
    expect(recipeIssueKind(issue({ ref: '*' }))).toBe('unrestricted-tools');
    expect(recipeIssueKind(issue({ ref: 'gap:x' }))).toBe('invalid-gap');
    expect(recipeIssueKind(issue({ field: 'allowedSkills', ref: 's' }))).toBe('missing-skill');
    expect(recipeIssueKind(issue({ ref: 't' }))).toBe('missing-tool');
  });

  it('sorts missing resources before policy notes without mutating input', () => {
    const input = [issue({ ref: '*' }), issue({ ref: 't' })];
    const sorted = sortRecipeIssues(input);
    expect(sorted.map((i) => i.ref)).toEqual(['t', '*']);
    expect(input.map((i) => i.ref)).toEqual(['*', 't']);
  });
});
