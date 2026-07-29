import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_DESIGN_SYSTEM_CHARS,
  readWorkspaceDesignSystem,
} from './design-system-reader';

describe('readWorkspaceDesignSystem', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexus-design-md-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when DESIGN.md is absent (graceful degradation)', () => {
    expect(readWorkspaceDesignSystem(dir)).toBeNull();
  });

  it('returns null when no root is given', () => {
    expect(readWorkspaceDesignSystem(undefined)).toBeNull();
  });

  it('reads the DESIGN.md content from the workspace root', () => {
    writeFileSync(join(dir, 'DESIGN.md'), '# My Design System\n\n- accent: #5e6ad2\n');
    expect(readWorkspaceDesignSystem(dir)).toBe(
      '# My Design System\n\n- accent: #5e6ad2\n',
    );
  });

  it('ignores an empty DESIGN.md', () => {
    writeFileSync(join(dir, 'DESIGN.md'), '   \n  ');
    expect(readWorkspaceDesignSystem(dir)).toBeNull();
  });

  it('truncates an oversized DESIGN.md with a notice', () => {
    const huge = 'x'.repeat(MAX_DESIGN_SYSTEM_CHARS + 5_000);
    writeFileSync(join(dir, 'DESIGN.md'), huge);
    const result = readWorkspaceDesignSystem(dir)!;
    expect(result.length).toBeLessThan(huge.length);
    expect(result.endsWith('\n\n[truncated]')).toBe(true);
    expect(result.startsWith('x'.repeat(MAX_DESIGN_SYSTEM_CHARS))).toBe(true);
  });

  it('reads a realistic Stitch DESIGN.md (frontmatter + sections)', () => {
    const content = `---
name: Linear-design-analysis
colors:
  primary: "#5e6ad2"
  canvas: "#010102"
typography:
  display-xl:
    fontSize: 80px
---

## Overview
Ultra-minimal, precise.

## Colors
Signature lavender on near-black.
`;
    writeFileSync(join(dir, 'DESIGN.md'), content);
    expect(readWorkspaceDesignSystem(dir)).toBe(content);
  });

  it('falls back to .context/docs/design-system.md when root DESIGN.md is absent', () => {
    const nested = join(dir, '.context', 'docs');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'design-system.md'), '# Extracted\n\naccent: #3dd9ff\n');
    expect(readWorkspaceDesignSystem(dir)).toBe('# Extracted\n\naccent: #3dd9ff\n');
  });

  it('prefers root DESIGN.md over the context docs fallback', () => {
    mkdirSync(join(dir, '.context', 'docs'), { recursive: true });
    writeFileSync(join(dir, 'DESIGN.md'), '# Root wins\n');
    writeFileSync(join(dir, '.context', 'docs', 'design-system.md'), '# Fallback\n');
    expect(readWorkspaceDesignSystem(dir)).toBe('# Root wins\n');
  });
});
