import { describe, expect, it } from 'vitest';
import {
  cliInstallRecipeCandidates,
  cliInstallRecipeFor,
  cliInstallCommandFor,
  describeInstallRecipe,
  compatibleManualInstallCommand,
  selectInstallRecipe,
  selectCliRepairRecipe,
  selectCliUpdateRecipe,
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
  it.each(['darwin', 'linux', 'win32'] as const)('updates the recognized Qwen npm installation on %s', (platform) => {
    const prefix = platform === 'win32' ? 'C:/Users/operator/npm' : '/home/operator/.npm-global';
    const binPath = platform === 'win32' ? `${prefix}/qwen.cmd` : `${prefix}/bin/qwen`;
    const realBinPath = `${prefix}/${platform === 'win32' ? '' : 'lib/'}node_modules/@qwen-code/qwen-code/cli.js`;
    expect(selectCliUpdateRecipe({ adapterId: 'qwen', platform, binPath, realBinPath,
      isRunnerResolvable: () => true })).toMatchObject({ ok: true,
      recipe: { argv: ['npm', 'install', '-g', '--prefix', prefix, '--allow-scripts=@qwen-code/qwen-code', '@qwen-code/qwen-code'] } });
  });

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
      '--allow-scripts=@gitlawb/openclaude',
      '@gitlawb/openclaude',
    ]);
  });

  // F-1571: o npm 12 bloqueia scripts de instalação por padrão e sai com 0 —
  // o Claude Code ficava com o stub de 500 bytes e todo pane morria no boot.
  it('toda receita npm libera os scripts só do próprio pacote, que fica por último', () => {
    let npmRecipes = 0;
    for (const id of [...ARGV_IDS, 'qwen', 'mimo-code', 'minimax-code']) {
      for (const platform of ['darwin', 'linux', 'win32'] as const) {
        for (const recipe of cliInstallRecipeCandidates(id, platform)) {
          if (recipe.kind !== 'argv' || recipe.runner !== 'npm') continue;
          npmRecipes++;
          const pkg = recipe.argv.at(-1)!;
          const allowed = recipe.argv.filter((arg) => arg.startsWith('--allow-scripts='));
          expect(allowed).toHaveLength(1);
          const list = allowed[0]!.slice('--allow-scripts='.length).split(',');
          // Só o pacote da CLI; o MiniMax soma o better-sqlite3 do README oficial.
          expect(list).toEqual(id === 'minimax-code' ? [pkg, 'better-sqlite3'] : [pkg]);
        }
      }
    }
    expect(npmRecipes).toBeGreaterThan(10);
    expect(cliInstallCommandFor('claude', 'win32'))
      .toBe('npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code');
  });

  it('F-1648: installs Muse on a Mac with bash but no Node/npm or Homebrew', () => {
    const selected = selectInstallRecipe(cliInstallRecipeCandidates('muse', 'darwin'), runner => runner === 'bash');
    expect(selected).toMatchObject({ ok: true, recipe: {
      kind: 'script', runner: 'bash', scriptUrl: 'https://dev.meta.ai/install.sh',
      env: { MUSE_LOGIN: '0', MUSE_NO_MODIFY_PATH: '1' },
    } });
  });

  it('F-1648: prefers native Muse even when Homebrew is available', () => {
    const selected = selectInstallRecipe(cliInstallRecipeCandidates('muse', 'darwin'), () => true);
    expect(selected).toMatchObject({ ok: true, recipe: { kind: 'script', runner: 'bash' } });
  });

  it('F-1648: keeps the official Muse cask as backup when bash is absent', () => {
    const selected = selectInstallRecipe(cliInstallRecipeCandidates('muse', 'darwin'), runner => runner === 'brew');
    expect(selected).toMatchObject({ ok: true, recipe: {
      kind: 'argv', argv: ['brew', 'install', '--cask', 'muse-code'],
    } });
  });

  it('F-1648: preserves no-login/no-profile-write settings in confirmation and manual install', () => {
    const recipe = cliInstallRecipeFor('muse', 'darwin')!;
    expect(describeInstallRecipe(recipe)).toContain('MUSE_LOGIN="0"');
    expect(describeInstallRecipe(recipe)).toContain('MUSE_NO_MODIFY_PATH="1"');
    expect(cliInstallCommandFor('muse', 'darwin')).toBe(
      "curl -fsSL https://dev.meta.ai/install.sh | 'env' 'MUSE_LOGIN=0' 'MUSE_NO_MODIFY_PATH=1' 'bash'",
    );
  });

  it('F-1648: reports only bash/Homebrew prerequisites when neither runner exists', () => {
    const selected = selectInstallRecipe(cliInstallRecipeCandidates('muse', 'darwin'), () => false);
    expect(selected).toMatchObject({ ok: false, missingRunnerHints: [
      expect.stringContaining('bash'), expect.stringContaining('Homebrew'),
    ] });
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
  it('claude prefere instalador nativo no macOS mesmo quando npm está disponível (F-210)', () => {
    const candidates = cliInstallRecipeCandidates('claude', 'darwin');
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates[1]?.kind).toBe('argv');
    const fallback = candidates[0];
    expect(fallback?.kind).toBe('script');
    if (fallback?.kind === 'script') {
      expect(fallback.scriptUrl).toBe('https://claude.ai/install.sh');
    }
    expect(selectInstallRecipe(candidates, () => true)).toMatchObject({ ok: true, recipe: { kind: 'script' } });
    expect(cliInstallRecipeFor('claude', 'win32')).toMatchObject({ kind: 'argv', runner: 'npm' });
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

describe('updating the CLI that Nexus launches', () => {
  it('updates the native Claude launcher even when npm is available', () => {
    const selected = selectCliUpdateRecipe({
      adapterId: 'claude',
      platform: 'darwin',
      binPath: '/Users/operator/.local/bin/claude',
      realBinPath: '/Users/operator/.local/share/claude/versions/2.1.278',
      isRunnerResolvable: () => true,
    });
    expect(selected).toMatchObject({
      ok: true,
      recipe: {
        kind: 'argv',
        argv: ['/Users/operator/.local/bin/claude', 'update'],
      },
    });
  });

  it('updates an npm Claude binary through that binary, not a second npm prefix', () => {
    const selected = selectCliUpdateRecipe({
      adapterId: 'claude',
      platform: 'darwin',
      binPath: '/Users/operator/.npm-global/bin/claude',
      realBinPath: '/Users/operator/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
      isRunnerResolvable: () => true,
    });
    expect(selected).toMatchObject({
      ok: true,
      recipe: {
        argv: ['/Users/operator/.npm-global/bin/claude', 'update'],
        // F-1571: o `npm install -g` que o `claude update` roda lê a liberação
        // do ambiente; sem ela o npm 12 deixa o stub no lugar do binário.
        env: { npm_config_allow_scripts: '@anthropic-ai/claude-code' },
      },
    });
  });

  it('the native Claude self-update does not carry npm configuration (F-1571)', () => {
    const selected = selectCliUpdateRecipe({
      adapterId: 'claude',
      platform: 'darwin',
      binPath: '/Users/operator/.local/bin/claude',
      realBinPath: '/Users/operator/.local/share/claude/versions/2.1.278',
      isRunnerResolvable: () => true,
    });
    expect(selected?.ok && selected.recipe.kind === 'argv' ? selected.recipe.env : 'not-argv').toBeUndefined();
  });

  describe('F-1571: reparo de uma CLI npm que parou de responder', () => {
    const winget =
      'C:\\Users\\Operator\\AppData\\Local\\Microsoft\\WinGet\\Packages\\' +
      'OpenJS.NodeJS.22_Microsoft.Winget.Source_8wekyb3d8bbwe\\node-v22.23.2-win-x64';

    it('reinstala o Claude npm do Windows no mesmo prefixo com o postinstall liberado', () => {
      expect(selectCliRepairRecipe({
        adapterId: 'claude',
        platform: 'win32',
        binPath: `${winget}\\claude.cmd`,
        realBinPath: `${winget}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`,
        isRunnerResolvable: () => true,
      })).toMatchObject({
        ok: true,
        recipe: {
          runner: 'npm',
          argv: ['npm', 'install', '-g', '--prefix', winget.replaceAll('\\', '/'),
            '--allow-scripts=@anthropic-ai/claude-code', '@anthropic-ai/claude-code'],
        },
      });
    });

    it('preserva as flags fixas da receita npm (MiniMax: registry e scripts nativos)', () => {
      const selected = selectCliRepairRecipe({
        adapterId: 'minimax-code',
        platform: 'linux',
        binPath: '/home/operator/.npm-global/bin/mcode',
        realBinPath: '/home/operator/.npm-global/lib/node_modules/@minimax-ai/code/dist/cli.js',
        isRunnerResolvable: () => true,
      });
      expect(selected?.ok && selected.recipe.kind === 'argv' ? selected.recipe.argv : null).toEqual([
        'npm', 'install', '-g', '--prefix', '/home/operator/.npm-global',
        '--registry=https://registry.npmjs.org/', '--ignore-scripts=false', '--include=optional',
        '--allow-scripts=@minimax-ai/code,better-sqlite3', '@minimax-ai/code',
      ]);
    });

    it('nunca inventa reparo fora de uma instalação npm reconhecida', () => {
      expect(selectCliRepairRecipe({
        adapterId: 'claude', platform: 'darwin',
        binPath: '/Users/operator/.local/bin/claude',
        realBinPath: '/Users/operator/.local/share/claude/versions/2.1.278',
        isRunnerResolvable: () => true,
      })).toBeNull();
      expect(selectCliRepairRecipe({
        adapterId: 'claude', platform: 'linux',
        binPath: '/home/operator/.local/share/pnpm/claude',
        realBinPath: '/home/operator/.local/share/pnpm/global/5/.pnpm/@anthropic-ai+claude-code@2.1.303/node_modules/@anthropic-ai/claude-code/cli.js',
        isRunnerResolvable: () => true,
      })).toBeNull();
      expect(selectCliRepairRecipe({
        adapterId: 'agy', platform: 'darwin',
        binPath: '/Users/operator/.local/bin/agy', realBinPath: '/Users/operator/.local/bin/agy',
        isRunnerResolvable: () => true,
      })).toBeNull();
    });
  });

  it('uses Homebrew for a Claude cask installation', () => {
    const selected = selectCliUpdateRecipe({
      adapterId: 'claude',
      platform: 'darwin',
      binPath: '/opt/homebrew/bin/claude',
      realBinPath: '/opt/homebrew/Caskroom/claude-code/2.1.278/claude',
      isRunnerResolvable: (runner) => runner === '/opt/homebrew/bin/brew',
    });
    expect(selected).toMatchObject({
      ok: true,
      recipe: { argv: ['/opt/homebrew/bin/brew', 'upgrade', '--cask', 'claude-code'] },
    });
  });

  it('updates a native Kimi binary instead of installing another Kimi with Homebrew', () => {
    const selected = selectCliUpdateRecipe({
      adapterId: 'kimi',
      platform: 'darwin',
      binPath: '/Users/operator/.local/bin/kimi',
      realBinPath: '/Users/operator/.kimi-code/bin/kimi',
      isRunnerResolvable: () => true,
    });
    expect(selected).toMatchObject({
      ok: true,
      recipe: { argv: ['/Users/operator/.local/bin/kimi', 'upgrade', '--yes'] },
    });
  });

  it('updates the npm prefix that owns the active Codex binary', () => {
    const selected = selectCliUpdateRecipe({
      adapterId: 'codex',
      platform: 'darwin',
      binPath: '/Users/operator/.npm-global/bin/codex',
      realBinPath: '/Users/operator/.npm-global/lib/node_modules/@openai/codex/bin/codex.js',
      isRunnerResolvable: () => true,
    });
    expect(selected).toMatchObject({
      ok: true,
      recipe: {
        argv: ['npm', 'install', '-g', '--prefix', '/Users/operator/.npm-global', '--allow-scripts=@openai/codex', '@openai/codex'],
      },
    });
  });

  it('updates the npm owner when Codex is launched through an external symlink', () => {
    const realBinPath = '/Users/operator/.hermes/node/lib/node_modules/@openai/codex/bin/codex.js';
    const selected = selectCliUpdateRecipe({
      adapterId: 'codex',
      platform: 'darwin',
      binPath: '/Users/operator/.local/bin/codex',
      realBinPath,
      resolveRealPath: (candidate) => candidate === '/Users/operator/.hermes/node/bin/codex'
        ? realBinPath : null,
      isRunnerResolvable: () => true,
    });
    expect(selected).toMatchObject({
      ok: true,
      recipe: { argv: ['npm', 'install', '-g', '--prefix', '/Users/operator/.hermes/node', '--allow-scripts=@openai/codex', '@openai/codex'] },
    });
  });

  it('rejects an external launcher when the npm prefix owns a different binary', () => {
    expect(selectCliUpdateRecipe({
      adapterId: 'codex',
      platform: 'darwin',
      binPath: '/Users/operator/.local/bin/codex',
      realBinPath: '/Users/operator/.hermes/node/lib/node_modules/@openai/codex/bin/codex.js',
      resolveRealPath: () => '/other/codex.js',
      isRunnerResolvable: () => true,
    })).toBeNull();
  });

  it('reruns the official installer for a standalone Codex (F-929)', () => {
    // Instalado via chatgpt.com/codex/install.sh: ~/.local/bin/codex é symlink
    // para ~/.codex/packages/standalone/releases/<versão>/bin/codex. Antes
    // caía no `return null` → "Não reconheci o canal da CLI usada pelo pane".
    const selected = selectCliUpdateRecipe({
      adapterId: 'codex',
      platform: 'darwin',
      binPath: '/Users/operator/.local/bin/codex',
      realBinPath: '/Users/operator/.codex/packages/standalone/releases/0.160.0/bin/codex',
      userHome: '/Users/operator',
      isRunnerResolvable: (runner) => runner === 'bash',
    });
    expect(selected).toMatchObject({
      ok: true,
      recipe: { kind: 'script', scriptUrl: 'https://chatgpt.com/codex/install.sh' },
    });
    if (selected?.ok) {
      expect(describeInstallRecipe(selected.recipe)).toContain('chatgpt.com/codex/install.sh');
    }
  });

  it('updates a Homebrew-cask Codex with brew upgrade --cask (F-929)', () => {
    const selected = selectCliUpdateRecipe({
      adapterId: 'codex',
      platform: 'darwin',
      binPath: '/opt/homebrew/bin/codex',
      realBinPath: '/opt/homebrew/Caskroom/codex/0.160.0/codex',
      isRunnerResolvable: () => true,
    });
    expect(selected).toMatchObject({
      ok: true,
      recipe: { argv: ['/opt/homebrew/bin/brew', 'upgrade', '--cask', 'codex'] },
    });
  });

  it('updates a native Grok launcher whose real binary lives under downloads', () => {
    expect(selectCliUpdateRecipe({
      adapterId: 'grok',
      platform: 'darwin',
      binPath: '/Users/operator/.grok/bin/grok',
      realBinPath: '/Users/operator/.grok/downloads/grok-1.0.43-macos-aarch64',
      userHome: '/Users/operator',
      isRunnerResolvable: () => true,
    })).toMatchObject({
      ok: true,
      recipe: { argv: ['/Users/operator/.grok/bin/grok', 'update'] },
    });
  });

  it('keeps the owning npm prefix for a Windows Codex shim', () => {
    const selected = selectCliUpdateRecipe({
      adapterId: 'codex',
      platform: 'win32',
      binPath: 'C:\\Users\\Operator\\AppData\\Roaming\\npm\\codex.cmd',
      realBinPath: 'C:\\Users\\Operator\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
      isRunnerResolvable: () => true,
    });
    expect(selected).toMatchObject({
      ok: true,
      recipe: {
        argv: ['npm', 'install', '-g', '--prefix', 'C:/Users/Operator/AppData/Roaming/npm', '--allow-scripts=@openai/codex', '@openai/codex'],
      },
    });
  });

  it('moves a Windows Codex out of a prefix too long for its tool host (F-688)', () => {
    const winget =
      'C:\\Users\\Administrador\\AppData\\Local\\Microsoft\\WinGet\\Packages\\' +
      'OpenJS.NodeJS.22_Microsoft.Winget.Source_8wekyb3d8bbwe\\node-v22.23.2-win-x64';
    const selected = selectCliUpdateRecipe({
      adapterId: 'codex',
      platform: 'win32',
      binPath: `${winget}\\codex.cmd`,
      realBinPath: `${winget}\\node_modules\\@openai\\codex\\bin\\codex.js`,
      userHome: 'C:\\Users\\Administrador',
      isRunnerResolvable: () => true,
    });
    expect(selected).toMatchObject({
      ok: true,
      recipe: {
        argv: ['npm', 'install', '-g', '--prefix', 'C:\\Users\\Administrador\\.local\\bin', '--allow-scripts=@openai/codex', '@openai/codex'],
      },
    });
  });

  it('does not turn a project-local Windows npm CLI into a global installation', () => {
    expect(selectCliUpdateRecipe({
      adapterId: 'codex',
      platform: 'win32',
      binPath: 'C:\\project\\node_modules\\.bin\\codex.cmd',
      realBinPath: 'C:\\project\\node_modules\\@openai\\codex\\bin\\codex.js',
      isRunnerResolvable: () => true,
    })).toBeNull();
  });

  it('uses WinGet for a WinGet-managed Claude binary', () => {
    const selected = selectCliUpdateRecipe({
      adapterId: 'claude',
      platform: 'win32',
      binPath: 'C:\\Users\\Operator\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe',
      realBinPath: 'C:\\Users\\Operator\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe',
      isRunnerResolvable: (runner) => runner === 'winget',
    });
    expect(selected).toMatchObject({
      ok: true,
      recipe: { argv: ['winget', 'upgrade', '--id', 'Anthropic.ClaudeCode', '--exact'] },
    });
  });

  it('uses the installed AGY executable updater on macOS and Windows', () => {
    for (const [platform, binPath] of [
      ['darwin', '/Users/operator/.local/bin/agy'],
      ['win32', 'C:\\Users\\Operator\\AppData\\Local\\agy\\bin\\agy.exe'],
    ] as const) {
      const selected = selectCliUpdateRecipe({
        adapterId: 'agy', platform, binPath, realBinPath: binPath,
        isRunnerResolvable: () => true,
      });
      expect(selected).toMatchObject({
        ok: true,
        recipe: { argv: [binPath, 'update'] },
      });
    }
  });

  it('uses the official PowerShell installer for a Windows Devin launcher', () => {
    const binPath = 'C:\\Users\\Operator\\AppData\\Local\\devin\\cli\\bin\\devin.exe';
    const selected = selectCliUpdateRecipe({
      adapterId: 'devin', platform: 'win32', binPath, realBinPath: binPath,
      windowsLocalAppData: 'C:\\Users\\Operator\\AppData\\Local',
      installationDistribution: 'irm-iex',
      isRunnerResolvable: (runner) => runner === 'powershell',
    });
    expect(selected).toMatchObject({
      ok: true,
      recipe: { kind: 'powershell-script', scriptUrl: 'https://static.devin.ai/cli/setup.ps1' },
    });
  });

  it('declines Devin installs the public script would update at another Windows root or channel', () => {
    const base = {
      adapterId: 'devin', platform: 'win32' as const,
      windowsLocalAppData: 'C:\\Users\\Operator\\AppData\\Local',
      isRunnerResolvable: () => true,
    };
    const custom = 'D:\\custom\\devin\\cli\\bin\\devin.exe';
    expect(selectCliUpdateRecipe({ ...base, binPath: custom, realBinPath: custom })).toBeNull();
    const standard = 'C:\\Users\\Operator\\AppData\\Local\\devin\\cli\\bin\\devin.exe';
    expect(selectCliUpdateRecipe({
      ...base, binPath: standard, realBinPath: standard,
      installationDistribution: 'enterprise-portal',
    })).toBeNull();
    const legacy = 'C:\\Users\\Operator\\AppData\\Local\\devin\\bin\\devin.exe';
    expect(selectCliUpdateRecipe({
      ...base, binPath: legacy, realBinPath: legacy,
    })?.ok).toBe(true);
  });

  it('binds macOS Devin installer to the XDG data root owning its active launcher', () => {
    const selected = selectCliUpdateRecipe({
      adapterId: 'devin', platform: 'darwin',
      userHome: '/Users/operator',
      binPath: '/Users/operator/.local/bin/devin',
      realBinPath: '/Users/operator/custom/share/devin/cli/_versions/3000.11.1/bin/devin',
      installationDistribution: 'curl-bash',
      isRunnerResolvable: () => true,
    });
    expect(selected).toMatchObject({
      ok: true,
      recipe: { kind: 'script', env: { XDG_DATA_HOME: '/Users/operator/custom/share' } },
    });
  });

  it('does not replace an enterprise Devin installation with the public macOS channel', () => {
    const base = {
      adapterId: 'devin', platform: 'darwin' as const,
      userHome: '/Users/operator',
      binPath: '/Users/operator/.local/bin/devin',
      realBinPath: '/Users/operator/.local/share/devin/cli/_versions/3000.11.1/bin/devin',
      isRunnerResolvable: () => true,
    };
    expect(selectCliUpdateRecipe({
      ...base, installationDistribution: 'enterprise-portal',
    })).toBeNull();
    expect(selectCliUpdateRecipe(base)).toBeNull();
    expect(selectCliUpdateRecipe({
      ...base,
      binPath: '/Users/other/.local/bin/devin',
      installationDistribution: 'curl-bash',
    })).toBeNull();
  });

  it('uses brew upgrade for the installed OpenCode formula', () => {
    const selected = selectCliUpdateRecipe({
      adapterId: 'opencode',
      platform: 'darwin',
      binPath: '/opt/homebrew/bin/opencode',
      realBinPath: '/opt/homebrew/Cellar/opencode/1.18.30_2/bin/opencode',
      isRunnerResolvable: (runner) => runner === '/opt/homebrew/bin/brew',
    });
    expect(selected).toMatchObject({
      ok: true,
      recipe: { argv: ['/opt/homebrew/bin/brew', 'upgrade', 'opencode'] },
    });
  });

  it('updates the Homebrew prefix that owns the active binary', () => {
    const selected = selectCliUpdateRecipe({
      adapterId: 'opencode',
      platform: 'darwin',
      binPath: '/usr/local/bin/opencode',
      realBinPath: '/usr/local/Cellar/opencode/1.18.30/bin/opencode',
      isRunnerResolvable: (runner) => runner === '/usr/local/bin/brew',
    });
    expect(selected).toMatchObject({
      ok: true,
      recipe: { argv: ['/usr/local/bin/brew', 'upgrade', 'opencode'] },
    });
  });

  it('pins uv tool and bin directories to the installed Aider copy', () => {
    const selected = selectCliUpdateRecipe({
      adapterId: 'aider',
      platform: 'darwin',
      binPath: '/Users/operator/.local/bin/aider',
      realBinPath: '/Users/operator/custom/uv/tools/aider-chat/bin/aider',
      isRunnerResolvable: () => true,
    });
    expect(selected).toMatchObject({
      ok: true,
      recipe: {
        env: {
          UV_TOOL_DIR: '/Users/operator/custom/uv/tools',
          UV_TOOL_BIN_DIR: '/Users/operator/.local/bin',
        },
      },
    });
  });

  it.each([
    ['grok', '/Users/operator/.local/bin/grok', '/Users/operator/.grok/bin/grok-1.0.40', ['/Users/operator/.local/bin/grok', 'update']],
    ['agy', '/Users/operator/.local/bin/agy', '/Users/operator/.local/bin/agy', ['/Users/operator/.local/bin/agy', 'update']],
    ['aider', '/Users/operator/.local/bin/aider', '/Users/operator/.local/share/uv/tools/aider-chat/bin/aider', ['uv', 'tool', 'install']],
    ['muse', '/opt/homebrew/bin/muse', '/opt/homebrew/Caskroom/muse-code/1.3.0/muse', ['/opt/homebrew/bin/brew', 'upgrade', '--cask', 'muse-code']],
  ] as const)('updates the installed %s channel', (adapterId, binPath, realBinPath, expectedArgv) => {
    const selected = selectCliUpdateRecipe({
      adapterId, platform: 'darwin', binPath, realBinPath,
      isRunnerResolvable: () => true,
    });
    expect(selected?.ok).toBe(true);
    if (selected?.ok) {
      if (expectedArgv) expect(selected.recipe.kind === 'argv' && selected.recipe.argv.slice(0, expectedArgv.length)).toEqual(expectedArgv);
      else expect(selected.recipe.kind).toBe('script');
    }
  });

  it('does not update an unrelated install when the current channel is unknown', () => {
    expect(selectCliUpdateRecipe({
      adapterId: 'codex',
      platform: 'darwin',
      binPath: '/private/custom/codex',
      realBinPath: '/private/custom/codex',
      isRunnerResolvable: () => true,
    })).toBeNull();
  });
});
