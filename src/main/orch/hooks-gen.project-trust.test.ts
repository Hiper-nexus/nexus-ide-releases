import { describe, expect, it } from 'vitest';
import { projectTrustKeys } from './hooks-gen';

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
