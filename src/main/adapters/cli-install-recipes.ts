/**
 * Receitas de instalação 1-clique das CLIs — produto multi-cliente: uma
 * máquina fresca precisa ficar operacional pelo próprio app, sem terminal.
 *
 * Doutrina de segurança: as receitas vivem EM CÓDIGO (nunca em JSON editável
 * pelo usuário — instalar software é superfície sensível), rodam por argv sem
 * shell, e sempre atrás de um diálogo NATIVO mostrando o comando exato
 * (mesma doutrina SEC#4 do confirmExecConfig).
 *
 * Só entram receitas de fonte oficial confirmada; CLI sem canal de
 * distribuição verificado fica sem botão (nada de chutar nome de pacote —
 * typosquat instala malware com cara de feature).
 */

export interface CliInstallRecipe {
  /** Comando exato (argv, sem shell). */
  readonly argv: readonly string[];
  /** Runner exigido no PATH (pré-checado antes do confirm nativo). */
  readonly runner: string;
  /** Instrução honesta quando o runner falta na máquina do cliente. */
  readonly runnerHint: string;
}

const NPM_HINT =
  'Este instalador usa o npm. Instale o Node.js primeiro (nodejs.org) e tente de novo.';
const BREW_HINT =
  'Este instalador usa o Homebrew. Instale-o primeiro (brew.sh) e tente de novo.';

function npmRecipe(pkg: string): CliInstallRecipe {
  return Object.freeze({
    argv: Object.freeze(['npm', 'install', '-g', pkg]),
    runner: 'npm',
    runnerHint: NPM_HINT,
  });
}

function brewRecipe(formula: string): CliInstallRecipe {
  return Object.freeze({
    argv: Object.freeze(['brew', 'install', formula]),
    runner: 'brew',
    runnerHint: BREW_HINT,
  });
}

type PlatformRecipes = Partial<Record<NodeJS.Platform, CliInstallRecipe>>;

const RECIPES: Readonly<Record<string, PlatformRecipes>> = Object.freeze({
  claude: {
    darwin: npmRecipe('@anthropic-ai/claude-code'),
    linux: npmRecipe('@anthropic-ai/claude-code'),
    win32: npmRecipe('@anthropic-ai/claude-code'),
  },
  codex: {
    darwin: npmRecipe('@openai/codex'),
    linux: npmRecipe('@openai/codex'),
    win32: npmRecipe('@openai/codex'),
  },
  gemini: {
    darwin: npmRecipe('@google/gemini-cli'),
    linux: npmRecipe('@google/gemini-cli'),
    win32: npmRecipe('@google/gemini-cli'),
  },
  opencode: {
    darwin: brewRecipe('opencode'),
    linux: npmRecipe('opencode-ai'),
    win32: npmRecipe('opencode-ai'),
  },
  omp: {
    // Tap oficial do oh-my-pi (mesma instrução que o painel OMP exibia).
    darwin: brewRecipe('can1357/tap/omp'),
  },
});

export function cliInstallRecipeFor(
  adapterId: string,
  platform: NodeJS.Platform = process.platform,
): CliInstallRecipe | null {
  return RECIPES[adapterId]?.[platform] ?? null;
}
