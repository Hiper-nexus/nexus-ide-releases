import { describe, expect, test } from 'vitest';
import {
  generateTaskBranchName,
  slugify,
  validateBranchSlug,
} from './worktree-branch-slug';

describe('slugify', () => {
  test('converts basic text to lowercase hyphenated slug', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  test('strips diacritics and accents (PT-BR support)', () => {
    expect(slugify('Implementação de Autenticação')).toBe('implementacao-de-autenticacao');
  });

  test('truncates at word boundaries when exceeding maxLength', () => {
    const longText = 'this-is-a-very-long-feature-title-that-needs-to-be-truncated-neatly';
    const result = slugify(longText, 30);
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result.endsWith('-')).toBe(false);
  });

  test('handles empty or special-character-only strings', () => {
    expect(slugify('')).toBe('unnamed-task');
    expect(slugify('!@#$%^&*()')).toBe('unnamed-task');
  });
});

describe('validateBranchSlug', () => {
  test('approves valid lowercase alphanumeric branch names with slashes and hyphens', () => {
    expect(validateBranchSlug('task/feat-auth')).toEqual({ valid: true });
    expect(validateBranchSlug('mission/3981-clean-logs')).toEqual({ valid: true });
  });

  test('rejects empty or whitespace branch names', () => {
    expect(validateBranchSlug('').valid).toBe(false);
    expect(validateBranchSlug('   ').valid).toBe(false);
  });

  test('rejects consecutive hyphens or slashes', () => {
    expect(validateBranchSlug('task--broken').valid).toBe(false);
    expect(validateBranchSlug('task//broken').valid).toBe(false);
  });

  test('rejects branch names starting or ending with symbols', () => {
    expect(validateBranchSlug('-leading-hyphen').valid).toBe(false);
    expect(validateBranchSlug('trailing-hyphen-').valid).toBe(false);
    expect(validateBranchSlug('/leading-slash').valid).toBe(false);
  });

  test('rejects HEAD', () => {
    expect(validateBranchSlug('head').valid).toBe(false);
    expect(validateBranchSlug('task/head').valid).toBe(false);
  });
});

describe('generateTaskBranchName', () => {
  test('generates canonical task branch name with prefix and title', () => {
    const branch = generateTaskBranchName({
      prefix: 'task',
      title: 'Fix broken login redirect',
    });
    expect(branch).toBe('task/fix-broken-login-redirect');
  });

  test('includes identifier when provided', () => {
    const branch = generateTaskBranchName({
      prefix: 'mission',
      identifier: 'F-102',
      title: 'Painel de Atividade',
    });
    expect(branch).toBe('mission/f-102-painel-de-atividade');
  });

  test('gracefully recovers with fallback if title produces invalid ref', () => {
    const branch = generateTaskBranchName({
      prefix: 'task',
      title: '???',
    });
    expect(branch.startsWith('task/')).toBe(true);
    expect(validateBranchSlug(branch).valid).toBe(true);
  });
});
