/**
 * Receitas de instalação 1-clique das CLIs — produto multi-cliente: uma
 * máquina fresca precisa ficar operacional pelo próprio app, sem terminal.
 *
 * Doutrina de segurança: as receitas vivem EM CÓDIGO (nunca em JSON editável
 * pelo usuário — instalar software é superfície sensível), rodam por argv sem
 * shell, e sempre atrás de um diálogo NATIVO mostrando o comando/URL exato
 * (mesma doutrina SEC#4 do confirmExecConfig).
 *
 * Só entram receitas de fonte oficial confirmada (docs do próprio provider);
 * CLI sem canal verificado fica sem botão — chutar nome de pacote é como
 * typosquat vira malware com cara de feature.
 *
 * Canais verificados em 2026-07-16:
 * - claude:   npm @anthropic-ai/claude-code (docs Anthropic)
 * - codex:    npm @openai/codex (pacote oficial OpenAI)
 * - opencode: brew opencode / npm opencode-ai
 * - openclaude: npm @gitlawb/openclaude (docs gitlawb)
 * - kimi:     brew kimi-code / npm @moonshot-ai/kimi-code (platform.kimi.ai)
 * - grok:     npm @xai-official/grok (pacote oficial xAI)
 * - agy:      script oficial https://antigravity.google/cli/install.sh
 *             (antigravity.google/docs/cli/install) — baixado e executado
 *             via bash SEM pipe de shell.
 *             No Windows, a variante oficial é install.ps1 e roda pelo
 *             PowerShell; nunca enviamos install.sh para powershell.exe.
 *
 * Canais verificados em 2026-09-10:
 * - devin:    script oficial https://cli.devin.ai/install.sh — inspecionado
 *             antes do uso: baixa de BASE_URL=https://static.devin.ai/cli com
 *             sha256 conferido contra manifest.json, instala em
 *             $XDG_DATA_HOME/devin/cli/_versions/<versão> e cria o link
 *             ~/.local/bin/devin. No Windows, a documentação oficial usa
 *             https://static.devin.ai/cli/setup.ps1 via PowerShell.
 *
 * Canais verificados em 2026-09-27:
 * - minimax-code: npm @minimax-ai/code (README oficial MiniMax-AI/minimax-code).
 *             O npm 12 bloqueia scripts de instalação por padrão e a CLI
 *             precisa do better-sqlite3 nativo: o comando do README libera
 *             os dois pacotes. Atualização é `mcode update`, que refaz esse
 *             mesmo passo — o `npm install -g --prefix` genérico perderia
 *             as flags e deixaria o SQLite quebrado.
 */

import { codexWindowsPrefixFits, codexWindowsShortPrefix } from './codex-windows-prefix';

interface ArgvInstallRecipe {
  readonly kind: 'argv';
  /** Comando exato (argv, sem shell). */
  readonly argv: readonly string[];
  /** Per-install location overrides for package managers with movable stores. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * F-520: comando de ATUALIZAÇÃO quando difere do install — `brew install`
   * com a fórmula já presente é no-op exit 0 (mentiria "atualizada");
   * `brew upgrade` resolve. npm não precisa: `npm install -g pkg` sempre
   * instala a latest. Script recipes atualizam por natureza.
   */
  readonly updateArgv?: readonly string[];
  /** Runner exigido no PATH (pré-checado antes do confirm nativo). */
  readonly runner: string;
  /** Instrução honesta quando o runner falta na máquina do cliente. */
  readonly runnerHint: string;
}

interface ScriptInstallRecipe {
  readonly kind: 'script';
  /** Instalador oficial: baixado via HTTPS para arquivo temporário e
   * executado com bash — nunca `curl | sh` (sem shell no meio). */
  readonly scriptUrl: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly runner: string;
  readonly runnerHint: string;
  /** F-749: canal oficial do fornecedor aceito na atualização diária. */
  readonly automaticUpdate?: boolean;
}

interface PowerShellScriptInstallRecipe {
  readonly kind: 'powershell-script';
  /** Instalador oficial PowerShell, baixado antes de executar. */
  readonly scriptUrl: string;
  readonly runner: 'powershell';
  readonly runnerHint: string;
  /**
   * F-747: executável (relativo a %LOCALAPPDATA%) que o script sobrescreve
   * com `Copy-Item -Force`. Com um pane rodando a CLI, o Windows recusa a
   * cópia; o runner o renomeia antes (renomear um .exe em uso é permitido).
   */
  readonly replacesLocalAppDataExecutable?: string;
  /** F-749: canal oficial do fornecedor aceito na atualização diária. */
  readonly automaticUpdate?: boolean;
}

export type CliInstallRecipe =
  | ArgvInstallRecipe
  | ScriptInstallRecipe
  | PowerShellScriptInstallRecipe;

const NPM_HINT =
  'Este instalador usa o npm. Instale o Node.js primeiro (nodejs.org) e tente de novo.';
const BREW_HINT =
  'Este instalador usa o Homebrew. Instale-o primeiro (brew.sh) e tente de novo.';
const BASH_HINT =
  'Este instalador usa o bash, que não foi encontrado nesta máquina.';
const POWERSHELL_HINT =
  'Este instalador usa o PowerShell, que não foi encontrado nesta máquina.';

function npmRecipe(pkg: string): ArgvInstallRecipe {
  return Object.freeze({
    kind: 'argv' as const,
    argv: Object.freeze(['npm', 'install', '-g', pkg]),
    runner: 'npm',
    runnerHint: NPM_HINT,
  });
}

/** O pacote fica por último: o updater lê o alvo npm do fim do argv. */
function minimaxCodeNpmRecipe(): ArgvInstallRecipe {
  return Object.freeze({
    kind: 'argv' as const,
    argv: Object.freeze([
      'npm', 'install', '-g',
      '--registry=https://registry.npmjs.org/',
      '--ignore-scripts=false',
      '--include=optional',
      '--allow-scripts=@minimax-ai/code,better-sqlite3',
      '@minimax-ai/code',
    ]),
    runner: 'npm',
    runnerHint: NPM_HINT,
  });
}

function brewRecipe(formula: string): ArgvInstallRecipe {
  return Object.freeze({
    kind: 'argv' as const,
    argv: Object.freeze(['brew', 'install', formula]),
    updateArgv: Object.freeze(['brew', 'upgrade', formula]),
    runner: 'brew',
    runnerHint: BREW_HINT,
  });
}

function brewCaskRecipe(cask: string): ArgvInstallRecipe {
  return Object.freeze({
    kind: 'argv' as const,
    argv: Object.freeze(['brew', 'install', '--cask', cask]),
    updateArgv: Object.freeze(['brew', 'upgrade', '--cask', cask]),
    runner: 'brew',
    runnerHint: BREW_HINT,
  });
}

function scriptRecipe(
  scriptUrl: string,
  options: { readonly automaticUpdate?: boolean } = {},
): ScriptInstallRecipe {
  return Object.freeze({
    kind: 'script' as const,
    scriptUrl,
    runner: 'bash',
    runnerHint: BASH_HINT,
    ...(options.automaticUpdate ? { automaticUpdate: true } : {}),
  });
}

function powershellRecipe(
  scriptUrl: string,
  options: {
    readonly replacesLocalAppDataExecutable?: string;
    readonly automaticUpdate?: boolean;
  } = {},
): PowerShellScriptInstallRecipe {
  return Object.freeze({
    kind: 'powershell-script' as const,
    scriptUrl,
    runner: 'powershell' as const,
    runnerHint: POWERSHELL_HINT,
    ...(options.replacesLocalAppDataExecutable
      ? { replacesLocalAppDataExecutable: options.replacesLocalAppDataExecutable }
      : {}),
    ...(options.automaticUpdate ? { automaticUpdate: true } : {}),
  });
}

function uvRecipe(pkg: string): ArgvInstallRecipe {
  return Object.freeze({
    kind: 'argv' as const,
    argv: Object.freeze([
      'uv',
      'tool',
      'install',
      '--force',
      '--python',
      'python3.12',
      '--with',
      'pip',
      pkg,
    ]),
    runner: 'uv',
    runnerHint:
      'Este instalador usa o uv. Instale-o primeiro (docs.astral.sh/uv) e tente de novo.',
  });
}

type PlatformRecipes = Partial<
  Record<NodeJS.Platform, readonly CliInstallRecipe[]>
>;

/**
 * CANDIDATOS em cascata por CLI (caso de campo: máquina de vizinho sem
 * Node/npm — "mandei instalar e não instalou nenhuma"). O instalador escolhe
 * o primeiro candidato cujo runner existe na máquina; todos os canais são
 * oficiais e verificados.
 */
const RECIPES: Readonly<Record<string, PlatformRecipes>> = Object.freeze({
  claude: {
    // Native is the official recommended macOS install. npm-first collides
    // with native/custom launchers in ~/.local/bin (EEXIST, F-210).
    darwin: [scriptRecipe('https://claude.ai/install.sh'), npmRecipe('@anthropic-ai/claude-code')],
    linux: [npmRecipe('@anthropic-ai/claude-code'), scriptRecipe('https://claude.ai/install.sh')],
    win32: [npmRecipe('@anthropic-ai/claude-code')],
  },
  codex: {
    // Fallback: cask oficial do Homebrew (`brew install --cask codex`); o
    // instalador standalone (chatgpt.com/codex/install.sh) é tratado à parte
    // no updater, que reconhece ~/.codex/packages/standalone.
    darwin: [npmRecipe('@openai/codex'), brewCaskRecipe('codex')],
    linux: [npmRecipe('@openai/codex')],
    win32: [npmRecipe('@openai/codex')],
  },
  'mimo-code': {
    darwin: [npmRecipe('@mimo-ai/cli')],
    linux: [npmRecipe('@mimo-ai/cli')],
    win32: [npmRecipe('@mimo-ai/cli')],
  },
  'minimax-code': {
    darwin: [minimaxCodeNpmRecipe()],
    linux: [minimaxCodeNpmRecipe()],
    win32: [minimaxCodeNpmRecipe()],
  },
  opencode: {
    darwin: [brewRecipe('opencode'), npmRecipe('opencode-ai')],
    linux: [npmRecipe('opencode-ai')],
    win32: [npmRecipe('opencode-ai')],
  },
  openclaude: {
    darwin: [npmRecipe('@gitlawb/openclaude')],
    linux: [npmRecipe('@gitlawb/openclaude')],
    win32: [npmRecipe('@gitlawb/openclaude')],
  },
  kimi: {
    darwin: [brewRecipe('kimi-code'), npmRecipe('@moonshot-ai/kimi-code')],
    linux: [npmRecipe('@moonshot-ai/kimi-code')],
    win32: [npmRecipe('@moonshot-ai/kimi-code')],
  },
  grok: {
    darwin: [npmRecipe('@xai-official/grok')],
    linux: [npmRecipe('@xai-official/grok')],
    win32: [npmRecipe('@xai-official/grok')],
  },
  aider: {
    // Aider publica o pacote aider-chat para uv/PyPI. O uv cria um ambiente
    // isolado e o entrypoint `aider`, sem depender de shell POSIX.
    darwin: [uvRecipe('aider-chat@latest')],
    linux: [uvRecipe('aider-chat@latest')],
    win32: [uvRecipe('aider-chat@latest')],
  },
  agy: {
    darwin: [scriptRecipe('https://antigravity.google/cli/install.sh')],
    linux: [scriptRecipe('https://antigravity.google/cli/install.sh')],
    win32: [powershellRecipe('https://antigravity.google/cli/install.ps1')],
  },
  devin: {
    // F-749: o operador pediu a atualização diária de TODAS as CLIs. O canal
    // do Devin é o script oficial (zip com SHA-256 conferido pelo próprio
    // script), o mesmo do botão "Atualizar CLI".
    darwin: [scriptRecipe('https://cli.devin.ai/install.sh', { automaticUpdate: true })],
    linux: [scriptRecipe('https://cli.devin.ai/install.sh', { automaticUpdate: true })],
    // F-747: `Copy-Item … devin.exe -Force` falha com pane Devin aberto.
    win32: [
      powershellRecipe('https://static.devin.ai/cli/setup.ps1', {
        replacesLocalAppDataExecutable: 'devin/cli/bin/devin.exe',
        automaticUpdate: true,
      }),
    ],
  },
  muse: {
    darwin: [brewCaskRecipe('muse-code')],
  },
});

/** Todos os candidatos (ordem de preferência) para a CLI nesta plataforma. */
export function cliInstallRecipeCandidates(
  adapterId: string,
  platform: NodeJS.Platform = process.platform,
): readonly CliInstallRecipe[] {
  return RECIPES[adapterId]?.[platform] ?? [];
}

export function cliInstallRecipeFor(
  adapterId: string,
  platform: NodeJS.Platform = process.platform,
): CliInstallRecipe | null {
  return RECIPES[adapterId]?.[platform]?.[0] ?? null;
}

/** Retorna o comando exato em formato texto para rodar num terminal interativo. */
export function cliInstallCommandFor(
  adapterId: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const recipe = cliInstallRecipeFor(adapterId, platform);
  if (!recipe) return null;
  if (recipe.kind === 'argv') return recipe.argv.join(' ');
  if (recipe.kind === 'powershell-script') {
    return `irm ${recipe.scriptUrl} | iex`;
  }
  return `curl -fsSL ${recipe.scriptUrl} | bash`;
}

/**
 * Preserva comandos manuais de adapters externos somente quando eles fazem
 * sentido no shell desta plataforma. Um comando Unix (`curl | bash`) ou
 * Homebrew nunca pode aparecer no PowerShell: além de falhar, a UI induz o
 * operador a acreditar que a CLI foi instalada quando nada executou.
 */
export function compatibleManualInstallCommand(
  command: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const trimmed = command?.trim() ?? '';
  if (!trimmed) return null;
  const posixShellPipe = /(?:curl|wget)[^\n|]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh)\b/i;
  if (platform === 'win32') {
    if (posixShellPipe.test(trimmed) || /^brew(?:\s|$)/i.test(trimmed)) {
      return null;
    }
    return trimmed;
  }
  if (/^(?:irm|iwr|powershell(?:\.exe)?|pwsh)\b/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export type InstallRecipeSelection =
  | { readonly ok: true; readonly recipe: CliInstallRecipe }
  | { readonly ok: false; readonly missingRunnerHints: readonly string[] };

/**
 * Escolhe o primeiro candidato cujo runner existe. Sem nenhum utilizável,
 * devolve as dicas ÚNICAS (ex.: "instale o Node OU o Homebrew") — o resumo
 * honesto que faltava quando "instalar" silenciosamente não instalava nada.
 */
export function selectInstallRecipe(
  candidates: readonly CliInstallRecipe[],
  isRunnerResolvable: (runner: string) => boolean,
): InstallRecipeSelection | null {
  if (candidates.length === 0) return null;
  for (const recipe of candidates) {
    if (isRunnerResolvable(recipe.runner)) return { ok: true, recipe };
  }
  return {
    ok: false,
    missingRunnerHints: [...new Set(candidates.map((r) => r.runnerHint))],
  };
}

/**
 * An update must target the CLI Nexus will spawn. Claude can coexist as a
 * native and an npm installation, so choosing the first available package
 * manager can update a different binary while leaving the pane unchanged.
 */
export function selectCliUpdateRecipe(input: {
  readonly adapterId: string;
  readonly platform: NodeJS.Platform;
  readonly binPath: string;
  readonly realBinPath: string;
  readonly userHome?: string;
  readonly windowsLocalAppData?: string;
  readonly installationDistribution?: string | null;
  readonly isRunnerResolvable: (runner: string) => boolean;
  readonly resolveRealPath?: (filePath: string) => string | null;
}): InstallRecipeSelection | null {
  const realPath = input.realBinPath.replaceAll('\\', '/');
  const binPath = input.binPath.replaceAll('\\', '/');
  const bindBrew = (
    recipe: ArgvInstallRecipe,
    root: 'Cellar' | 'Caskroom',
    packageName: string,
  ): InstallRecipeSelection | null => {
    const marker = `/${root}/${packageName}/`;
    const index = realPath.indexOf(marker);
    if (index < 0) return null;
    const runner = `${realPath.slice(0, index)}/bin/brew`;
    const updateArgv = recipe.updateArgv ?? recipe.argv;
    return selectInstallRecipe([{
      ...recipe,
      runner,
      argv: [runner, ...updateArgv.slice(1)],
    }], input.isRunnerResolvable);
  };
  const selfUpdate = (args: readonly string[]): InstallRecipeSelection => {
    const recipe: ArgvInstallRecipe = {
      kind: 'argv',
      argv: [input.binPath, ...args],
      runner: input.binPath,
      runnerHint: 'A CLI instalada não está mais executável; reexamine as CLIs.',
    };
    return input.isRunnerResolvable(input.binPath)
      ? { ok: true, recipe }
      : { ok: false, missingRunnerHints: [recipe.runnerHint] };
  };
  if (input.adapterId === 'claude') {
    if (input.platform === 'win32' && (
      /\/Microsoft\/WinGet\/Packages\/Anthropic\.ClaudeCode(?:_[^/]+)?\//iu.test(realPath) ||
      /\/Microsoft\/WinGet\/Links\/claude\.exe$/iu.test(binPath)
    )) {
      return selectInstallRecipe([{
        kind: 'argv',
        argv: ['winget', 'upgrade', '--id', 'Anthropic.ClaudeCode', '--exact'],
        runner: 'winget',
        runnerHint: 'O WinGet não foi encontrado para atualizar esta instalação de Claude.',
      }], input.isRunnerResolvable);
    }
    const brewCask = realPath.match(/\/Caskroom\/(claude-code(?:@latest)?)\//);
    if (input.platform === 'darwin' && brewCask) {
      const recipe = brewCaskRecipe(brewCask[1]);
      return bindBrew(recipe, 'Caskroom', brewCask[1]);
    }
    // Anthropic's own updater knows the installation that invoked it. This
    // covers the native launcher and npm installations with custom prefixes.
    return selfUpdate(['update']);
  }
  if (input.adapterId === 'kimi' && /\/\.kimi-code\/bin\/kimi$/u.test(realPath)) {
    return selfUpdate(['upgrade', '--yes']);
  }
  const home = input.userHome?.replaceAll('\\', '/').replace(/\/$/u, '');
  if (input.adapterId === 'grok' && (
    /\/\.grok\/bin\/grok(?:-[^/]+)?$/u.test(realPath) ||
    (home && binPath === `${home}/.grok/bin/grok` &&
      realPath.startsWith(`${home}/.grok/downloads/grok-`))
  )) {
    return selfUpdate(['update']);
  }
  // Codex instalado pelo instalador standalone (chatgpt.com/codex/install.sh):
  // o binário fica em ~/.codex/packages/standalone/releases/<versão>/bin/codex
  // e ~/.local/bin/codex é só um symlink. Não é npm nem cask, então cairia no
  // `return null` final ("Não reconheci o canal da CLI usada pelo pane"). O
  // próprio instalador é o atualizador: reexecutá-lo baixa a release mais nova
  // in-place. O sinal confiável é o realPath — o binPath ~/.local/bin/codex
  // também é usado por symlinks de instalações npm (vide testes acima).
  if (input.adapterId === 'codex' &&
      /\/\.codex\/packages\/standalone\//u.test(realPath)) {
    return selectInstallRecipe(
      [scriptRecipe('https://chatgpt.com/codex/install.sh', { automaticUpdate: true })],
      input.isRunnerResolvable,
    );
  }
  if (input.adapterId === 'minimax-code') {
    return selfUpdate(['update']);
  }
  if (input.adapterId === 'agy') {
    // Its install scripts exit successfully without touching an existing
    // binary; the installed CLI owns the actual update operation.
    return selfUpdate(['update']);
  }

  const candidates = cliInstallRecipeCandidates(input.adapterId, input.platform);
  if (input.adapterId === 'devin' && input.platform === 'win32') {
    const localRoot = input.windowsLocalAppData?.replaceAll('\\', '/').replace(/\/$/u, '');
    const ownsLauncher = localRoot && [
      `${localRoot}/devin/cli/bin/devin.exe`,
      `${localRoot}/devin/bin/devin.exe`,
    ].some((expected) => expected.toLowerCase() === binPath.toLowerCase());
    if (!ownsLauncher || (input.installationDistribution &&
        input.installationDistribution !== 'irm-iex')) return null;
    return selectInstallRecipe(candidates.filter(
      (recipe) => recipe.kind === 'powershell-script',
    ), input.isRunnerResolvable);
  }
  for (const candidate of candidates) {
    if (candidate.kind === 'argv') {
      const command = candidate.argv[0];
      const target = candidate.argv[candidate.argv.length - 1];
      if (command === 'brew') {
        const root = candidate.argv.includes('--cask') ? 'Caskroom' : 'Cellar';
        const selected = bindBrew(candidate, root, target);
        if (selected) return selected;
        continue;
      }
      if (command === 'npm') {
        const marker = input.platform === 'win32'
          ? `/node_modules/${target}/`
          : `/lib/node_modules/${target}/`;
        const index = realPath.indexOf(marker);
        if (index < 0 || realPath.includes('/.pnpm/')) continue;
        const prefix = realPath.slice(0, index);
        const expectedBinDir = input.platform === 'win32' ? prefix : `${prefix}/bin`;
        const binPath = input.binPath.replaceAll('\\', '/');
        const actualBinDir = binPath.slice(0, binPath.lastIndexOf('/'));
        const isOutsideNpmBin = input.platform === 'win32'
          ? actualBinDir.toLowerCase() !== expectedBinDir.toLowerCase()
          : actualBinDir !== expectedBinDir;
        if (isOutsideNpmBin && (input.platform === 'win32' ||
          input.resolveRealPath?.(`${expectedBinDir}/${binPath.slice(binPath.lastIndexOf('/') + 1)}`)
            !== input.realBinPath)) continue;
        // F-688: Codex num prefixo onde o host de ferramentas passa do
        // MAX_PATH do Windows não tem conserto no lugar — a atualização o
        // reinstala no prefixo curto, que o spawn prefere.
        const targetPrefix = input.platform === 'win32' && input.adapterId === 'codex' &&
          input.userHome && !codexWindowsPrefixFits(prefix.replaceAll('/', '\\'))
          ? codexWindowsShortPrefix(input.userHome)
          : prefix;
        const recipe = {
          ...candidate,
          argv: ['npm', 'install', '-g', '--prefix', targetPrefix, target],
        };
        return selectInstallRecipe([recipe], input.isRunnerResolvable);
      }
      if (command === 'uv' && realPath.includes(`/uv/tools/${target.split('@')[0]}/`)) {
        const toolName = target.split('@')[0];
        const marker = `/uv/tools/${toolName}/`;
        const toolDir = `${realPath.slice(0, realPath.indexOf(marker))}/uv/tools`;
        const binDir = binPath.slice(0, binPath.lastIndexOf('/'));
        return selectInstallRecipe([{
          ...candidate,
          env: { UV_TOOL_DIR: toolDir, UV_TOOL_BIN_DIR: binDir },
        }], input.isRunnerResolvable);
      }
      continue;
    }
    if (candidate.kind === 'script' && input.adapterId === 'devin') {
      const marker = '/devin/cli/_versions/';
      const index = realPath.indexOf(marker);
      const userHome = input.userHome?.replaceAll('\\', '/').replace(/\/$/u, '');
      if (index < 0 || !userHome || binPath !== `${userHome}/.local/bin/devin` ||
          input.installationDistribution !== 'curl-bash') continue;
      return selectInstallRecipe([{
        ...candidate,
        env: { HOME: userHome, XDG_DATA_HOME: realPath.slice(0, index) },
      }], input.isRunnerResolvable);
    }
  }
  return null;
}

/** Resumo do que será executado — vai no diálogo nativo de confirmação. */
export function describeInstallRecipe(recipe: CliInstallRecipe): string {
  if (recipe.kind === 'argv') return recipe.argv.join(' ');
  const environment = recipe.kind === 'script' && recipe.env
    ? ` com ${Object.entries(recipe.env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ')}`
    : '';
  return `baixar e executar o instalador oficial: ${recipe.scriptUrl}${environment}`;
}
