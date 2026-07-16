import { describe, expect, it } from 'vitest';
import {
  cliInstallRecipeFor,
  describeInstallRecipe,
} from './cli-install-recipes';

const ARGV_IDS = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'omp',
  'kimi',
  'grok',
] as const;

describe('cli install recipes', () => {
  it('covers the fresh-client core on macOS', () => {
    for (const id of [...ARGV_IDS, 'agy']) {
      expect(cliInstallRecipeFor(id, 'darwin')).not.toBeNull();
    }
  });

  it('argv recipes are shell-safe: no metacharacters, runner = argv[0]', () => {
    const platforms: NodeJS.Platform[] = ['darwin', 'linux', 'win32'];
    for (const id of ARGV_IDS) {
      for (const platform of platforms) {
        const recipe = cliInstallRecipeFor(id, platform);
        if (!recipe) continue;
        expect(recipe.kind).toBe('argv');
        if (recipe.kind !== 'argv') continue;
        expect(recipe.argv.length).toBeGreaterThanOrEqual(2);
        for (const word of recipe.argv) {
          expect(word).not.toMatch(/[;&|<>$`\\\s]/);
        }
        expect(recipe.runner).toBe(recipe.argv[0]);
        expect(recipe.runnerHint.length).toBeGreaterThan(10);
      }
    }
  });

  it('script recipes point at the official HTTPS installer only', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const recipe = cliInstallRecipeFor('agy', platform);
      expect(recipe?.kind).toBe('script');
      if (recipe?.kind !== 'script') continue;
      expect(recipe.scriptUrl).toBe('https://antigravity.google/cli/install.sh');
      expect(describeInstallRecipe(recipe)).toContain('antigravity.google');
    }
    // Windows do agy usa PowerShell (irm|iex) — sem receita até termos um
    // caminho sem pipe de shell.
    expect(cliInstallRecipeFor('agy', 'win32')).toBeNull();
  });

  it('never invents recipes for CLIs without a verified channel', () => {
    // GLM/LongCat autenticam por token (sem CLI própria a instalar); aider
    // usa instalador próprio ainda não verificado.
    for (const id of ['aider', 'glm', 'longcat', 'desconhecido']) {
      expect(cliInstallRecipeFor(id, 'darwin')).toBeNull();
    }
  });
});
