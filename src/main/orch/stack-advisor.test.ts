// @vitest-environment node
import { describe, expect, it } from 'vitest';

/**
 * F-776 — stack-advisor: o Nexus decide stack por política (registro na
 * hora, recusa de descontinuado com evidência, versão fixada), não por
 * hábito. Estes testes amarram a skill empacotada e a carta de engenharia.
 */
import { BUNDLED_MANIFESTS } from './skill-mirror';
import { ENGINEERING_CHARTER } from './engineering-charter';

describe('stack-advisor bundled skill (F-776)', () => {
  it('está registrada em BUNDLED_MANIFESTS com SKILL.md', () => {
    const manifest = BUNDLED_MANIFESTS['stack-advisor'];
    expect(manifest).toBeDefined();
    expect(manifest['SKILL.md']).toBeDefined();
    expect(manifest['SKILL.md']!.encoding).toBe('utf8');
  });

  it('manda consultar o registro na hora da decisão', () => {
    const body = BUNDLED_MANIFESTS['stack-advisor']!['SKILL.md']!.content;
    expect(body).toContain('npm view');
    expect(body).toContain('crates.io/api/v1/crates');
    expect(body).toContain('pypi.org/pypi');
  });

  it('recusa fail-closed pacote deprecated/abandonado/sem licença', () => {
    const body = BUNDLED_MANIFESTS['stack-advisor']!['SKILL.md']!.content;
    expect(body).toContain('deprecated');
    expect(body).toContain('18 months');
  });

  it('define o formato fixo de saída da decisão', () => {
    const body = BUNDLED_MANIFESTS['stack-advisor']!['SKILL.md']!.content;
    expect(body).toContain('justificativa');
    expect(body).toContain('fontes');
  });
});

describe('engineering charter — Stack & dependencies (F-776)', () => {
  it('obriga consulta ao registro na hora, recusa de descontinuado e pin de versão', () => {
    expect(ENGINEERING_CHARTER).toContain('npm view');
    expect(ENGINEERING_CHARTER).toContain('deprecated');
  });

  it('manda escolher a stack pelo stack-advisor em projeto novo', () => {
    expect(ENGINEERING_CHARTER).toContain('stack-advisor');
  });
});
