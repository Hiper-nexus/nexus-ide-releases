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
 */

interface ArgvInstallRecipe {
  readonly kind: 'argv';
  /** Comando exato (argv, sem shell). */
  readonly argv: readonly string[];
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
  readonly runner: string;
  readonly runnerHint: string;
}

interface PowerShellScriptInstallRecipe {
  readonly kind: 'powershell-script';
  /** Instalador oficial PowerShell, baixado antes de executar. */
  readonly scriptUrl: string;
  readonly runner: 'powershell';
  readonly runnerHint: string;
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

function scriptRecipe(scriptUrl: string): ScriptInstallRecipe {
  return Object.freeze({
    kind: 'script' as const,
    scriptUrl,
    runner: 'bash',
    runnerHint: BASH_HINT,
  });
}

function powershellRecipe(scriptUrl: string): PowerShellScriptInstallRecipe {
  return Object.freeze({
    kind: 'powershell-script' as const,
    scriptUrl,
    runner: 'powershell' as const,
    runnerHint: POWERSHELL_HINT,
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
    // Fallback: instalador nativo oficial da Anthropic (docs "Set up Claude
    // Code") — cobre máquina sem Node E o clássico EACCES do npm -g.
    darwin: [npmRecipe('@anthropic-ai/claude-code'), scriptRecipe('https://claude.ai/install.sh')],
    linux: [npmRecipe('@anthropic-ai/claude-code'), scriptRecipe('https://claude.ai/install.sh')],
    win32: [npmRecipe('@anthropic-ai/claude-code')],
  },
  codex: {
    // Fallback: formula oficial no homebrew-core.
    darwin: [npmRecipe('@openai/codex'), brewRecipe('codex')],
    linux: [npmRecipe('@openai/codex')],
    win32: [npmRecipe('@openai/codex')],
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
    darwin: [scriptRecipe('https://cli.devin.ai/install.sh')],
    linux: [scriptRecipe('https://cli.devin.ai/install.sh')],
    win32: [powershellRecipe('https://static.devin.ai/cli/setup.ps1')],
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

/** Resumo do que será executado — vai no diálogo nativo de confirmação. */
export function describeInstallRecipe(recipe: CliInstallRecipe): string {
  if (recipe.kind === 'argv') return recipe.argv.join(' ');
  return `baixar e executar o instalador oficial: ${recipe.scriptUrl}`;
}
