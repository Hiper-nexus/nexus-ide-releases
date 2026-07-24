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

  it('trunca um nome longo antes de invadir os controles em tela estreita', () => {
    const css = fs.readFileSync(path.join(ROOT, 'styles/base.css'), 'utf8');
    const rule = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      if (start < 0) return '';
      const end = css.indexOf('}', start);
      return css.slice(start, end + 1);
    };

    expect(rule('.workspace-bar__ws')).toContain('flex: 1 1 auto');
    expect(rule('.workspace-bar__name-btn')).toContain('width: 100%');
    expect(rule('.workspace-bar__name-btn')).toContain('overflow: hidden');
    expect(rule('.workspace-bar__context-copy')).toContain('overflow: hidden');
    expect(rule('.workspace-bar__context-copy')).toContain('flex: 1 1 auto');
    expect(rule('.workspace-bar__name')).toContain('display: block');
    expect(rule('.workspace-bar__name')).toContain('width: 100%');
    expect(rule('.workspace-bar__name')).toContain('text-overflow: ellipsis');
  });
});
