import { describe, expect, it } from 'vitest';
import {
  buildPullRequestFieldsPrompt,
  generateLocalPullRequestFields,
  inferLinkedIssueNumber,
  parseGeneratedPullRequestFields,
} from './pull-request-generation';

describe('inferLinkedIssueNumber', () => {
  it('lê #N do subject do commit', () => {
    expect(
      inferLinkedIssueNumber('feature/x', [
        { hash: 'abc', subject: 'fix login (#42)' },
      ]),
    ).toBe(42);
  });

  it('lê fix/123-foo da branch', () => {
    expect(inferLinkedIssueNumber('fix/123-login', [])).toBe(123);
  });

  it('lê prefixo numérico da branch', () => {
    expect(inferLinkedIssueNumber('88-dark-mode', [])).toBe(88);
  });

  it('não inventa issue', () => {
    expect(inferLinkedIssueNumber('feature/login', [])).toBeNull();
  });
});

describe('generateLocalPullRequestFields', () => {
  it('usa o subject do commit e seções Problem/Solution', () => {
    const draft = generateLocalPullRequestFields({
      branch: 'feature/login',
      base: 'main',
      commits: [
        { hash: 'aaa', subject: 'fix: guard null on submit' },
        { hash: 'bbb', subject: 'test: cover empty form' },
      ],
    });
    expect(draft.title).toBe('fix: guard null on submit');
    expect(draft.base).toBe('main');
    expect(draft.draft).toBe(false);
    expect(draft.body).toContain('## Problem');
    expect(draft.body).toContain('## Solution');
    expect(draft.body).toContain('- fix: guard null on submit');
    expect(draft.body).toContain('- test: cover empty form');
    expect(draft.body).not.toMatch(/Fixes #/);
  });

  it('anexa Fixes #N quando a issue é conhecida', () => {
    const draft = generateLocalPullRequestFields({
      branch: 'fix/9-typo',
      base: 'trunk',
      commits: [{ hash: 'ccc', subject: 'typo in README' }],
    });
    expect(draft.body).toContain('Fixes #9');
    expect(draft.base).toBe('trunk');
  });

  it('humaniza a branch quando não há commits', () => {
    const draft = generateLocalPullRequestFields({
      branch: 'feature/dark-mode',
      base: 'main',
      commits: [],
    });
    expect(draft.title).toBe('Dark mode');
    expect(draft.body).toContain('feature/dark-mode');
  });
});

describe('parseGeneratedPullRequestFields', () => {
  it('parseia JSON compacto e tira o ponto final do título', () => {
    const parsed = parseGeneratedPullRequestFields(
      '{"base":"main","title":"Add login.","body":"## Problem\\nok","draft":false}',
      { base: 'develop' },
    );
    expect(parsed).toEqual({
      base: 'main',
      title: 'Add login',
      body: '## Problem\nok',
      draft: false,
    });
  });

  it('aceita fence ```json e cai no fallback se o JSON for inválido', () => {
    const fenced = parseGeneratedPullRequestFields(
      '```json\n{"base":"trunk","title":"Hi","body":"x","draft":true}\n```',
      { base: 'main' },
    );
    expect(fenced.base).toBe('trunk');
    expect(fenced.draft).toBe(true);

    const bad = parseGeneratedPullRequestFields('not json', {
      base: 'main',
      currentTitle: 'Fallback title',
      currentBody: 'Fallback body',
    });
    expect(bad.title).toBe('Fallback title');
    expect(bad.body).toBe('Fallback body');
  });
});

describe('buildPullRequestFieldsPrompt', () => {
  it('pede JSON e cita a issue ligada', () => {
    const prompt = buildPullRequestFieldsPrompt({
      branch: 'fix/4-x',
      base: 'main',
      linkedIssue: 4,
      commits: [{ hash: 'abcdef0', subject: 'fix x' }],
    });
    expect(prompt).toContain('Fixes #4');
    expect(prompt).toContain('abcdef0 fix x');
    expect(prompt).toContain('"base":"branch-name"');
  });
});
