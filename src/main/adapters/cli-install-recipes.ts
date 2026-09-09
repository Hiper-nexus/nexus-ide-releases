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
 */

interface ArgvInstallRecipe {
  readonly kind: 'argv';
  /** Comando exato (argv, sem shell). */
  readonly argv: readonly string[];
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

export type CliInstallRecipe = ArgvInstallRecipe | ScriptInstallRecipe;

const NPM_HINT =
  'Este instalador usa o npm. Instale o Node.js primeiro (nodejs.org) e tente de novo.';
const BREW_HINT =
  'Este instalador usa o Homebrew. Instale-o primeiro (brew.sh) e tente de novo.';
const BASH_HINT =
  'Este instalador usa o bash, que não foi encontrado nesta máquina.';

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
  agy: {
    darwin: [scriptRecipe('https://antigravity.google/cli/install.sh')],
    linux: [scriptRecipe('https://antigravity.google/cli/install.sh')],
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
