import { describe, expect, it } from 'vitest';
import {
  fileRole,
  projectChangedFiles,
} from './mission-changed-files';

describe('projectChangedFiles — a entrega em linguagem de gente', () => {
  it('separa arquivo de identificador opaco', () => {
    // Payload real do app (23/08): artifactRefs traz CAMINHOS, apesar de o
    // contrato tipá-los como id.
    const p = projectChangedFiles([
      'index.html',
      'docs/plan.md',
      '9f2c1ab34de5f6079a8b1c2d3e4f5061',
      'handoff-sem-extensao',
    ]);
    expect(p.files.map((f) => f.path)).toEqual(['index.html', 'docs/plan.md']);
    expect(p.opaqueRefs).toEqual([
      '9f2c1ab34de5f6079a8b1c2d3e4f5061',
      'handoff-sem-extensao',
    ]);
  });

  it('a raiz do projeto vem primeiro — é o que a pessoa quer ver', () => {
    const p = projectChangedFiles([
      'docs/superpowers/plans/2026-08-22-secao.md',
      'index.html',
      'src/app.tsx',
    ]);
    expect(p.files[0]?.path).toBe('index.html');
  });

  it('nomeia o papel sem mostrar extensão crua', () => {
    expect(fileRole('index.html')).toBe('página');
    expect(fileRole('style.css')).toBe('estilo');
    expect(fileRole('app.tsx')).toBe('código');
    expect(fileRole('plan.md')).toBe('documento');
    expect(fileRole('config.json')).toBe('configuração');
    expect(fileRole('logo.svg')).toBe('imagem');
    expect(fileRole('coisa.xyz')).toBe('arquivo');
  });

  it('não repete o mesmo caminho', () => {
    const p = projectChangedFiles(['index.html', 'index.html', ' index.html ']);
    expect(p.files).toHaveLength(1);
  });

  it('lista vazia não quebra', () => {
    expect(projectChangedFiles([])).toEqual({ files: [], opaqueRefs: [] });
  });
});
