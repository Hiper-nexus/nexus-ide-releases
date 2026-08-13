import { describe, expect, it } from 'vitest';
import {
  formatIssueMissionBrief,
  formatIssueMissionTitle,
} from './issue-mission-brief';
import type { ExternalIssue } from './integrations-types';

const issue: ExternalIssue = {
  id: 'gh-12',
  provider: 'github',
  number: 12,
  title: 'Botão de login quebra no mobile',
  url: 'https://github.com/acme/app/issues/12',
  state: 'open',
  labels: ['bug', 'mobile'],
};

describe('issue mission brief', () => {
  it('usa o número e o título', () => {
    expect(formatIssueMissionTitle(issue)).toBe(
      '#12 Botão de login quebra no mobile',
    );
  });

  it('monta um brief com url, labels e Fixes #N', () => {
    const brief = formatIssueMissionBrief(issue);
    expect(brief).toContain('Botão de login quebra no mobile');
    expect(brief).toContain('https://github.com/acme/app/issues/12');
    expect(brief).toContain('bug, mobile');
    expect(brief).toContain('Fixes #12');
  });
});
