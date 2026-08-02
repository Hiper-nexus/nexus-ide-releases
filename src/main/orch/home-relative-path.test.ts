// @vitest-environment node
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OUTSIDE_HOME_LABEL,
  homeRelativeDirOf,
  homeRelativePath,
} from './home-relative-path';

const HOME = path.resolve('/Users/operator');

describe('homeRelativePath', () => {
  it('never returns the OS account name for a path under home', () => {
    const catalog = path.join(HOME, '.design-references');
    expect(homeRelativePath(catalog, HOME)).toBe('~/.design-references');
    expect(homeRelativePath(catalog, HOME)).not.toContain('operator');
    expect(
      homeRelativePath(path.join(HOME, '.claude', 'skills'), HOME),
    ).toBe('~/.claude/skills');
    expect(homeRelativePath(HOME, HOME)).toBe('~');
  });

  it('refuses to print a traversal chain for a path outside home', () => {
    expect(homeRelativePath(path.resolve('/tmp/catalog'), HOME)).toBe(
      OUTSIDE_HOME_LABEL,
    );
    expect(homeRelativePath(path.resolve('/Users/other/x'), HOME)).toBe(
      OUTSIDE_HOME_LABEL,
    );
  });

  it('drops the file name when only the directory is decision-relevant', () => {
    expect(
      homeRelativeDirOf(path.join(HOME, '.claude', 'skills', 'SKILL.md'), HOME),
    ).toBe('~/.claude/skills');
  });
});
