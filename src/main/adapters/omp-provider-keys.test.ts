import { describe, expect, it } from 'vitest';
import { buildOmpInheritedKeyEnv } from './omp-provider-keys';

describe('omp inherited key env', () => {
  it('injeta só as chaves que existem, com os nomes que o omp reconhece', () => {
    const vault: Record<string, string> = {
      glm: 'glm-secreta',
      openrouter: 'or-secreta',
    };
    const env = buildOmpInheritedKeyEnv((id) => vault[id] ?? null);
    expect(env).toEqual({
      ZAI_API_KEY: 'glm-secreta',
      ZHIPUAI_API_KEY: 'glm-secreta',
      OPENROUTER_API_KEY: 'or-secreta',
    });
  });

  it('vault vazio → env vazio (nunca variável vazia)', () => {
    expect(buildOmpInheritedKeyEnv(() => null)).toEqual({});
  });

  it('nunca injeta credencial de assinatura (só upstreams de API key)', () => {
    const seen: string[] = [];
    buildOmpInheritedKeyEnv((id) => {
      seen.push(id);
      return null;
    });
    // Assinaturas OAuth (claude/codex/gemini CLIs) ficam fora por design.
    expect(seen).not.toContain('claude');
    expect(seen).not.toContain('codex');
    expect(seen).toContain('glm');
    expect(seen).toContain('moonshot');
  });
});
