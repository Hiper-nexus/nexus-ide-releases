import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import type { ProjectExecutionScope } from '../../shared/types';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  configureWorkspaceMemory,
  disposeWorkspaceMemoryStores,
  getWorkspaceMemoryStore,
} from './workspace-memory';
import { workspaceMemoryContextBlock } from './workspace-memory-context';

const dirs: string[] = [];
let scope: ProjectExecutionScope;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-inj-root-'));
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-inj-db-'));
  dirs.push(root, baseDir);
  scope = {
    version: 1,
    installationId: 'installation-inj',
    projectId: 'project-inj',
    checkoutId: 'checkout-inj',
    rootRealPath: root,
    identitySource: 'manifest',
  };
  configureWorkspaceMemory({ baseDir });
  getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.workspaceMemory, true);
});

afterEach(() => {
  disposeWorkspaceMemoryStores();
  getFeatureFlagRegistry().clearOverride(FEATURE_FLAG_IDS.workspaceMemory);
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('workspaceMemoryContextBlock (bloco reutilizável do hook)', () => {
  it('retorna null com o banco do projeto vazio', () => {
    expect(
      workspaceMemoryContextBlock(scope, 'Implemente o fluxo de login agora'),
    ).toBeNull();
  });

  it('retorna null com a flag de memória desligada', () => {
    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.workspaceMemory, false);
    getWorkspaceMemoryStore(scope).retain({
      content: '# Preferência\n\nSempre use pnpm neste projeto.',
      kind: 'preference',
      scope: 'workspace',
      source: 'trusted:operator-preference',
    });
    expect(
      workspaceMemoryContextBlock(scope, 'Implemente o fluxo de login agora'),
    ).toBeNull();
  });

  it('monta o bloco <workspace-memory> com os hits relevantes', () => {
    getWorkspaceMemoryStore(scope).retain({
      content: '# Preferência\n\nSempre use pnpm neste projeto.',
      kind: 'preference',
      scope: 'workspace',
      source: 'trusted:operator-preference',
    });
    const block = workspaceMemoryContextBlock(
      scope,
      'Como instalo dependências? Prefiro o padrão do projeto.',
    );
    expect(block).toContain('<workspace-memory');
    expect(block).toContain('</workspace-memory>');
    expect(block).toContain('Sempre use pnpm neste projeto');
  });

  it('não duplica quando o prompt já traz o bloco', () => {
    getWorkspaceMemoryStore(scope).retain({
      content: '# Preferência\n\nSempre use pnpm neste projeto.',
      kind: 'preference',
      scope: 'workspace',
      source: 'trusted:operator-preference',
    });
    expect(
      workspaceMemoryContextBlock(
        scope,
        '<workspace-memory phase="execution">x</workspace-memory> faça isso',
      ),
    ).toBeNull();
  });

  it('símbolos citados depois do preâmbulo continuam alcançando sua memória', () => {
    getWorkspaceMemoryStore(scope).retain({
      content: 'billingChargeOnce já implementa a idempotência necessária.', kind: 'fact',
      source: 'trusted:architecture-rule',
    });
    const block = workspaceMemoryContextBlock(scope,
      'APENAS leitura diagnóstico sem editar arquivos abrir helpers operador pediu revisão geral detalhada cuidadosa independente. Rastreie billingChargeOnce.');
    expect(block).toContain('billingChargeOnce já implementa');
  });

  it('falha aberto para null quando o banco não está configurado', () => {
    disposeWorkspaceMemoryStores();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      workspaceMemoryContextBlock(scope, 'Implemente o fluxo de login agora'),
    ).toBeNull();
    warn.mockRestore();
  });
});
