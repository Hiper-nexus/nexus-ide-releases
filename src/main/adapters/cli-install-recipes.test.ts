import { describe, expect, it } from 'vitest';
import {
  cliInstallRecipeCandidates,
  cliInstallRecipeFor,
  cliInstallCommandFor,
  describeInstallRecipe,
  compatibleManualInstallCommand,
  selectInstallRecipe,
} from './cli-install-recipes';

const ARGV_IDS = [
  'claude',
  'codex',
  'opencode',
  'openclaude',
  'kimi',
  'grok',
  'aider',
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
        // Valida TODOS os candidatos (cascata); script-kind é validado no
        // teste de instaladores oficiais HTTPS.
        for (const recipe of cliInstallRecipeCandidates(id, platform)) {
          if (recipe.kind !== 'argv') continue;
          expect(recipe.argv.length).toBeGreaterThanOrEqual(2);
          for (const word of recipe.argv) {
            expect(word).not.toMatch(/[;&|<>$`\\\s]/);
          }
          expect(recipe.runner).toBe(recipe.argv[0]);
          expect(recipe.runnerHint.length).toBeGreaterThan(10);
        }
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
    const agyWindows = cliInstallRecipeFor('agy', 'win32');
    expect(agyWindows?.kind).toBe('powershell-script');
    if (agyWindows?.kind === 'powershell-script') {
      expect(agyWindows.scriptUrl).toBe('https://antigravity.google/cli/install.ps1');
      expect(cliInstallCommandFor('agy', 'win32')).toBe(
        'irm https://antigravity.google/cli/install.ps1 | iex',
      );
    }
    const devinWindows = cliInstallRecipeFor('devin', 'win32');
    expect(devinWindows?.kind).toBe('powershell-script');
    if (devinWindows?.kind === 'powershell-script') {
      expect(devinWindows.scriptUrl).toBe('https://static.devin.ai/cli/setup.ps1');
    }
  });

  it('installs OpenClaude from the official gitlawb npm package', () => {
    const recipe = cliInstallRecipeFor('openclaude', 'darwin');
    expect(recipe?.kind).toBe('argv');
    if (recipe?.kind !== 'argv') return;
    expect(recipe.argv).toEqual([
      'npm',
      'install',
      '-g',
      '@gitlawb/openclaude',
    ]);
  });

  it('installs Muse via official Homebrew cask', () => {
    const recipe = cliInstallRecipeFor('muse', 'darwin');
    expect(recipe?.kind).toBe('argv');
    if (recipe?.kind === 'argv') {
      expect(recipe.argv).toEqual(['brew', 'install', '--cask', 'muse-code']);
    }
  });

  it('never invents recipes for CLIs without a verified channel', () => {
    // GLM/LongCat autenticam por token (sem CLI própria a instalar).
    for (const id of ['gemini', 'gemini-cli', 'glm', 'longcat', 'desconhecido']) {
      expect(cliInstallRecipeFor(id, 'darwin')).toBeNull();
    }
  });

  it('mantém o comando manual separado por shell', () => {
    expect(
      compatibleManualInstallCommand(
        'curl -fsSL https://example.test/install.sh | bash',
        'win32',
      ),
    ).toBeNull();
    expect(compatibleManualInstallCommand('brew install muse-code', 'win32')).toBeNull();
    expect(
      compatibleManualInstallCommand('irm https://example.test/install.ps1 | iex', 'win32'),
    ).toBe('irm https://example.test/install.ps1 | iex');
    expect(
      compatibleManualInstallCommand('irm https://example.test/install.ps1 | iex', 'darwin'),
    ).toBeNull();
  });

  it('não publica receita Unix/Homebrew no catálogo Windows', () => {
    expect(cliInstallRecipeFor('muse', 'win32')).toBeNull();
    expect(cliInstallCommandFor('muse', 'win32')).toBeNull();
    expect(cliInstallCommandFor('agy', 'win32')).not.toMatch(/install\.sh|bash/iu);
    expect(cliInstallCommandFor('devin', 'win32')).not.toMatch(/install\.sh|bash/iu);
  });
});

describe('candidatos em cascata (máquina sem runner primário)', () => {
  it('claude tem fallback de instalador oficial por script (sem Node/npm)', () => {
    const candidates = cliInstallRecipeCandidates('claude', 'darwin');
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates[0]?.kind).toBe('argv');
    const fallback = candidates[1];
    expect(fallback?.kind).toBe('script');
    if (fallback?.kind === 'script') {
      expect(fallback.scriptUrl).toBe('https://claude.ai/install.sh');
    }
  });

  it('selectInstallRecipe cai para o candidato cujo runner existe', () => {
    // Caso de campo: "mandei instalar e não instalou nenhuma" — máquina sem
    // npm; antes o fluxo desistia com a dica do runner primário.
    const candidates = cliInstallRecipeCandidates('claude', 'darwin');
    const semNpm = selectInstallRecipe(candidates, (runner) => runner === 'bash');
    expect(semNpm).toMatchObject({ ok: true });
    if (semNpm?.ok) expect(semNpm.recipe.kind).toBe('script');

    const comNpm = selectInstallRecipe(candidates, (runner) => runner === 'npm');
    if (comNpm?.ok) expect(comNpm.recipe.runner).toBe('npm');
  });

  it('sem nenhum runner, devolve as dicas únicas de todos os canais', () => {
    const candidates = cliInstallRecipeCandidates('kimi', 'darwin');
    const nada = selectInstallRecipe(candidates, () => false);
    expect(nada).toMatchObject({ ok: false });
    if (nada && !nada.ok) {
      expect(nada.missingRunnerHints.length).toBeGreaterThanOrEqual(2);
      expect(nada.missingRunnerHints.join(' ')).toMatch(/Homebrew/);
      expect(nada.missingRunnerHints.join(' ')).toMatch(/npm/);
    }
  });

  it('CLI sem receita devolve null (nunca inventa canal)', () => {
    expect(selectInstallRecipe(cliInstallRecipeCandidates('glm', 'darwin'), () => true)).toBeNull();
  });
});
