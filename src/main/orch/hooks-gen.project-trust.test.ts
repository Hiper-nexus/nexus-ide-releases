import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureNativeClaudeProjectTrust, projectTrustKeys } from './hooks-gen';

const snapshot = vi.hoisted(() => ({ clear: vi.fn() }));
vi.mock('../adapters/claude-config-snapshot', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  clearClaudeConfigSnapshotCache: snapshot.clear,
}));

describe('projectTrustKeys — confiança de pasta do Claude', () => {
  it('no Windows cobre a chave com barra normal que o Claude grava', () => {
    const keys = projectTrustKeys(
      'C:\\Users\\Administrador\\Documents\\Projetos\\saasbarbearia',
      'win32',
    );
    expect(keys).toContain('C:\\Users\\Administrador\\Documents\\Projetos\\saasbarbearia');
    expect(keys).toContain('C:/Users/Administrador/Documents/Projetos/saasbarbearia');
  });

  it('caminho estilo POSIX não ganha variante de barra nem no Windows', () => {
    expect(projectTrustKeys('/nonexistent/work/projeto', 'win32')).toEqual([
      '/nonexistent/work/projeto',
    ]);
  });

  it('fora do Windows não inventa variantes de barra', () => {
    expect(projectTrustKeys('/nonexistent/work/projeto', 'darwin')).toEqual([
      '/nonexistent/work/projeto',
    ]);
  });
});

describe('ensureNativeClaudeProjectTrust', () => {
  it('forgets the in-memory ~/.claude.json snapshot after Nexus rewrites the file (M1)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-trust-'));
    try {
      fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }));
      snapshot.clear.mockClear();
      ensureNativeClaudeProjectTrust(home, '/nonexistent/work/projeto');
      expect(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).projects)
        .toHaveProperty(['/nonexistent/work/projeto']);
      expect(snapshot.clear).toHaveBeenCalled();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
