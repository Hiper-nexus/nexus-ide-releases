import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  WORKSPACE_DESIGN_RULE_HEADING,
  operatorDesignContext,
  withWorkspaceDesignRule,
} from './workspace-design-rule';

const roots: string[] = [];
function workspace() { const root = mkdtempSync(join(tmpdir(), 'nexus-design-rule-')); roots.push(root); return root; }
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function catalog(): string {
  const dir = workspace();
  writeFileSync(join(dir, 'stripe.md'), '---\ndescription: Payments, billing and checkout for a fintech\n---\n# Stripe\n');
  writeFileSync(join(dir, 'linear.md'), '---\ndescription: Issue tracker for engineering teams\n---\n# Linear\n');
  writeFileSync(join(dir, 'README.md'), '# Índice\n');
  return dir;
}

const noCatalog = () => ({ catalogDir: join(workspace(), 'missing') });

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
    const prompt = withWorkspaceDesignRule('Criar uma página', root, undefined, { catalogDir: catalog() });
    expect(prompt).toContain('DESIGN.md');
    expect(prompt).not.toContain('.context/docs/design-system.md');
    expect(prompt).not.toContain('stripe');
  });
  it('gives UI work a discovery rule when there is no applied contract', () => {
    expect(withWorkspaceDesignRule('Redesenhe a interface do dashboard', workspace(), undefined, noCatalog()))
      .toContain('AGENTS.md');
  });
  it('uses the same threshold as the Design Charter: any UI term, no quorum', () => {
    expect(withWorkspaceDesignRule('Faça a página de onboarding', workspace(), undefined, noCatalog()))
      .toContain('AGENTS.md');
  });
  it('does not add UI discovery to unrelated tasks without a design contract', () => {
    const prompt = 'Corrija a paginação SQL do backend';
    expect(withWorkspaceDesignRule(prompt, workspace(), undefined, { catalogDir: catalog() })).toBe(prompt);
  });

  describe('catálogo local de referências (sem contrato aplicado)', () => {
    it('aponta o arquivo da referência que casa com o pedido e lista as outras', () => {
      const dir = catalog();
      const prompt = withWorkspaceDesignRule(
        'Crie a tela de checkout de pagamentos', workspace(), undefined, { catalogDir: dir },
      );
      expect(prompt).toContain(join(dir, 'stripe.md'));
      expect(prompt).toContain('linear');
      expect(prompt).not.toContain('README');
      // Worker não propõe contrato: a sugestão de import é só do operador.
      expect(prompt).not.toContain('nexus_design_system_local_import');
    });

    it('sem evidência de domínio, lista o catálogo e pede para escolher', () => {
      const dir = catalog();
      const prompt = withWorkspaceDesignRule(
        'Redesenhe a interface da tela de perfil', workspace(), undefined, { catalogDir: dir },
      );
      expect(prompt).toContain('linear, stripe');
      expect(prompt).not.toContain('stripe.md');
    });

    it('a referência fixada nas configurações vence o casamento por domínio', () => {
      const prompt = withWorkspaceDesignRule(
        'Crie a tela de checkout de pagamentos', workspace(), undefined,
        { catalogDir: catalog(), pinnedKitId: 'linear' },
      );
      expect(prompt).toContain('linear.md');
      expect(prompt).toContain('fixada');
      expect(prompt).not.toContain('stripe.md');
    });
  });
});

describe('contexto de design do pane do operador', () => {
  it('pedido de UI recebe a regra, a referência sugerida, o import do contrato e a carta', () => {
    const text = operatorDesignContext('Crie a tela de checkout de pagamentos', workspace(), {
      catalogDir: catalog(),
      charter: '# Design Charter (teste)',
    });
    expect(text).toContain(WORKSPACE_DESIGN_RULE_HEADING);
    expect(text).toContain('stripe.md');
    expect(text).toContain('nexus_design_system_local_import({ kitId: "stripe" })');
    expect(text).toContain('# Design Charter (teste)');
  });

  it('com contrato aplicado aponta o contrato e não sugere catálogo', () => {
    const root = workspace();
    writeFileSync(join(root, 'DESIGN.md'), '# Root');
    const text = operatorDesignContext('Redesenhe a tela de login', root, { catalogDir: catalog(), charter: null });
    expect(text).toContain('Leia DESIGN.md');
    expect(text).not.toContain('nexus_design_system_local_import');
  });

  it('pedido que não é de UI, ou relato de bug numa tela, não recebe nada', () => {
    const options = { catalogDir: catalog(), charter: 'carta' };
    expect(operatorDesignContext('Corrija a paginação SQL do backend', workspace(), options)).toBeNull();
    expect(operatorDesignContext('a tela congela quando fecho o pane no macOS', workspace(), options)).toBeNull();
  });
});
