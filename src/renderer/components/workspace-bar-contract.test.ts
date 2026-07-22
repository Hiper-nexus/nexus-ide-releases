// Copyright (c) 2026 Lovecast Inc. — MIT License
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('workspace bar discoverability contract', () => {
  it('keeps current workspace identity and new-workspace action visible', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'components/WorkspaceBar.tsx'),
      'utf8',
    );
    const css = fs.readFileSync(path.join(ROOT, 'styles/base.css'), 'utf8');

    expect(source).toContain('Workspace ativo');
    expect(source).toContain('workspace-bar__new-workspace');
    expect(source).toContain('aria-label="Novo workspace"');
    expect(source).toContain('{workspace.path}');
    expect(css).toMatch(/\.workspace-bar__new-workspace\s*\{/);
    expect(css).toMatch(/\.term-host--history::after\s*\{/);
    expect(css).toContain('DIGITE PARA VOLTAR AO VIVO');
  });
});
