import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withWorkspaceDesignRule } from './workspace-design-rule';

const roots: string[] = [];
function workspace() { const root = mkdtempSync(join(tmpdir(), 'nexus-design-rule-')); roots.push(root); return root; }
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('workspace design rule', () => {
  it('names the applied contract and requires evidence without injecting its contents', () => {
    const root = workspace();
    mkdirSync(join(root, '.context/docs'), { recursive: true });
    writeFileSync(join(root, '.context/docs/design-system.md'), '# Reviewed style\nPrivate design notes');
    const prompt = withWorkspaceDesignRule('Ajuste a tela de login', root);
    expect(prompt).toContain('.context/docs/design-system.md');
    expect(prompt).toContain('antes de editar');
    expect(prompt).toContain('referência usada');
    expect(prompt).not.toContain('Private design notes');
  });
  it('keeps root authority ahead of imported design and catalog references', () => {
    const root = workspace();
    writeFileSync(join(root, 'DESIGN.md'), '# Root');
    mkdirSync(join(root, '.context/docs'), { recursive: true });
    writeFileSync(join(root, '.context/docs/design-system.md'), '# Imported');
    const prompt = withWorkspaceDesignRule('Criar uma página', root);
    expect(prompt).toContain('DESIGN.md');
    expect(prompt).not.toContain('.context/docs/design-system.md');
  });
  it('gives UI work a discovery rule when there is no applied contract', () => {
    expect(withWorkspaceDesignRule('Redesenhe a interface do dashboard', workspace())).toContain('AGENTS.md');
  });
  it('does not add UI discovery to unrelated tasks without a design contract', () => {
    const prompt = 'Corrija a paginação SQL do backend';
    expect(withWorkspaceDesignRule(prompt, workspace())).toBe(prompt);
  });
});
