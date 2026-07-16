import { describe, expect, it } from 'vitest';
import { cliInstallRecipeFor } from './cli-install-recipes';

describe('cli install recipes', () => {
  it('covers the fresh-client core on macOS', () => {
    for (const id of ['claude', 'codex', 'gemini', 'opencode', 'omp']) {
      expect(cliInstallRecipeFor(id, 'darwin')).not.toBeNull();
    }
  });

  it('argv is shell-safe: absolute command words, no metacharacters', () => {
    const platforms: NodeJS.Platform[] = ['darwin', 'linux', 'win32'];
    for (const id of ['claude', 'codex', 'gemini', 'opencode', 'omp']) {
      for (const platform of platforms) {
        const recipe = cliInstallRecipeFor(id, platform);
        if (!recipe) continue;
        expect(recipe.argv.length).toBeGreaterThanOrEqual(2);
        for (const word of recipe.argv) {
          expect(word).not.toMatch(/[;&|<>$`\\\s]/);
        }
        expect(recipe.runner).toBe(recipe.argv[0]);
        expect(recipe.runnerHint.length).toBeGreaterThan(10);
      }
    }
  });

  it('never invents recipes for CLIs without a verified channel', () => {
    // agy/kimi/grok/aider usam instaladores próprios ainda não verificados —
    // chutar nome de pacote é vetor de typosquat.
    for (const id of ['agy', 'kimi', 'grok', 'aider', 'glm', 'longcat']) {
      expect(cliInstallRecipeFor(id, 'darwin')).toBeNull();
    }
  });
});
