/**
 * Como cada CLI recebe o PRIMEIRO prompt de uma missão.
 *
 * Isto existia como corrente de `if (adapter.id === 'kimi' || …)` dentro do
 * pty-manager, escrita de cabeça. Custou caro nos dois sentidos: o kimi estava
 * na lista sem aceitar posicional (o pane cuspia o help e ficava mudo), e grok,
 * cursor-agent, muse e qoder ficavam de fora mesmo aceitando — cada um
 * dependendo de colagem pós-boot, que é o canal que falha contra TUI fria.
 *
 * A regra agora é: quem declara, manda; quem não declara, herda do BINÁRIO —
 * porque o contrato é do binário, não do nome do adapter. glm, longcat e
 * deepseek rodam o mesmo `claude`; sakana roda `codex` por um wrapper. Todos
 * herdam o contrato do executável que realmente sobe.
 *
 * A tabela abaixo não é palpite: saiu da linha `Usage:` de cada binário
 * instalado nesta máquina (11/08).
 */

export type InitialPromptChannel =
  /** Prompt vai como último argumento e a TUI SEGUE interativa. */
  | { readonly kind: 'positional' }
  /** Prompt vai com flag interativa e a TUI SEGUE interativa (ex.: --prompt-interactive no agy). */
  | { readonly kind: 'interactive-flag'; readonly flag: string }
  /**
   * A CLI só aceita prompt num modo não-interativo (`-p`, `--print`, `run`).
   * Serve para worker one-shot; NUNCA para um pane que precisa continuar vivo.
   */
  | { readonly kind: 'oneshot'; readonly args: readonly string[] }
  /** Sem canal de argv: entrega por colagem depois do boot. */
  | { readonly kind: 'paste' };

/**
 * Binários cuja linha de uso declara prompt posicional:
 *   claude   → `claude [options] [command] [prompt]`
 *   codex    → `codex [OPTIONS] [PROMPT]`
 *   grok     → `grok [OPTIONS] [PROMPT] [COMMAND]`
 *   agent    → `agent [options] [command] [prompt...]`  (cursor-agent)
 *   muse     → `muse [OPTIONS] [PROMPT]`
 *   qodercli → `qodercli [options] [command] [query...]`
 *   devin    → `devin [OPTIONS] [PATH]... [-- <PROMPT>...]`
 */
const POSITIONAL_BINARIES: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'codex-fugu',
  'grok',
  'cursor-agent',
  'agent',
  'muse',
  'qodercli',
  'devin',
]);

export interface InitialPromptSource {
  /** `spawn.initialPrompt` declarado pelo adapter, quando houver. */
  readonly declared?: 'positional' | 'interactive-flag' | 'oneshot' | 'paste' | null;
  /** Flag usada quando declared === 'interactive-flag' (ex.: '--prompt-interactive'). */
  readonly interactiveFlag?: string | null;
  /** Argumentos do modo one-shot (ex.: ['--print'], ['-p'], ['run']). */
  readonly oneshotArgs?: readonly string[] | null;
  /** `spawn.interactive` — só o binário importa aqui. */
  readonly interactive?: readonly string[] | null;
}

/** Nome do executável, sem diretório nem extensão. */
export function spawnBinaryName(
  interactive: readonly string[] | null | undefined,
): string {
  const raw = (interactive?.[0] ?? '').trim();
  if (raw.length === 0) return '';
  const last = raw.split(/[\\/]/u).pop() ?? raw;
  return last.replace(/\.(exe|cmd|bat)$/iu, '').toLowerCase();
}

export function initialPromptChannel(
  source: InitialPromptSource,
): InitialPromptChannel {
  const declared = source.declared ?? null;
  if (declared === 'positional') return { kind: 'positional' };
  if (declared === 'interactive-flag') {
    return {
      kind: 'interactive-flag',
      flag: source.interactiveFlag || '--prompt-interactive',
    };
  }
  if (declared === 'paste') return { kind: 'paste' };
  if (declared === 'oneshot') {
    const args = (source.oneshotArgs ?? []).filter(
      (arg) => typeof arg === 'string' && arg.trim().length > 0,
    );
    // One-shot sem os argumentos que ligam o modo é contrato incompleto —
    // melhor colar depois do boot do que subir um pane que ignora o prompt.
    return args.length > 0 ? { kind: 'oneshot', args } : { kind: 'paste' };
  }
  const bin = spawnBinaryName(source.interactive);
  return POSITIONAL_BINARIES.has(bin)
    ? { kind: 'positional' }
    : { kind: 'paste' };
}

/**
 * Anexa o primeiro prompt ao argv DEPOIS da política governada. Posicional
 * fica no fim; `run` (OpenCode) é subcomando e vai na frente. Colagem não
 * mexe no argv.
 */
export function applyInitialPromptToArgv(
  args: readonly string[],
  channel: InitialPromptChannel,
  prompt: string,
): string[] {
  const next = [...args];
  if (channel.kind === 'positional') {
    const isDevin = next.some((a) => a === 'devin' || a.endsWith('/devin'));
    if (isDevin && !next.includes('--')) {
      next.push('--', prompt);
    } else {
      next.push(prompt);
    }
    return next;
  }
  if (channel.kind === 'interactive-flag') {
    next.push(channel.flag, prompt);
    return next;
  }
  if (channel.kind === 'oneshot') {
    for (const flag of channel.args) {
      if (
        next.includes(flag) ||
        next.some((arg) => arg.startsWith(`${flag}=`))
      ) {
        throw new Error(
          `initial prompt conflicts with provider settings extraArgs (${flag})`,
        );
      }
    }
    if (channel.args.length === 1 && channel.args[0] === 'run') {
      next.unshift('run');
      next.push(prompt);
      return next;
    }
    next.push(...channel.args, prompt);
    return next;
  }
  return next;
}

/**
 * O pane de missão precisa continuar vivo para o operador digitar nele.
 * Canais posicionais e flags interativas atendem isso; one-shot fecha depois da tarefa.
 */
export function acceptsInteractiveInitialPrompt(
  source: InitialPromptSource,
): boolean {
  const kind = initialPromptChannel(source).kind;
  return kind === 'positional' || kind === 'interactive-flag';
}
