import type { InitialPromptChannel } from '../../shared/cli-initial-prompt';

/**
 * Linha de comando do Windows (F-670/F-671).
 *
 * O CreateProcess aceita 32.767 caracteres na linha INTEIRA (executável,
 * flags, config de hooks e o brief, já com aspas e escapes). Um `.cmd`/`.bat`
 * passa pelo `cmd.exe`, que corta o argumento na primeira quebra de linha,
 * expande `%VAR%` e para em 8.191. O brief só fica no argv quando a linha
 * final é segura; senão sai dele e é entregue depois do boot.
 */

/** Teto com folga abaixo dos 32.767 do CreateProcess. */
export const WINDOWS_COMMAND_LINE_SAFE_LIMIT = 32_000;

/** Um argumento como o MSVCRT o reconstrói (mesma regra do libuv). */
export function quoteWindowsArg(arg: string): string {
  if (arg.length > 0 && !/[ \t\n\v"]/u.test(arg)) return arg;
  let quoted = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      quoted += '\\'.repeat(backslashes) + char;
    }
    backslashes = 0;
  }
  return quoted + '\\'.repeat(backslashes * 2) + '"';
}

/** Tamanho da linha de comando que o processo recebe. */
export function windowsCommandLineLength(file: string, args: readonly string[]): number {
  return [file, ...args].map(quoteWindowsArg).join(' ').length;
}

export function isWindowsBatchLauncher(file: string): boolean {
  return /\.(?:cmd|bat)$/iu.test(file);
}

export type WindowsArgvPromptPlacement =
  | { readonly defer: false }
  | {
      readonly defer: true;
      readonly reason: 'batch-launcher' | 'command-line-too-long';
      /** argv sem o brief (e sem a flag dele no canal interactive-flag). */
      readonly args: string[];
    };

/**
 * Decide se o brief que já está em `args` pode ficar lá. Canal one-shot não
 * tem como receber o brief depois do boot: quem chama recusa o spawn.
 */
export function windowsArgvPromptPlacement(input: {
  readonly file: string;
  readonly args: readonly string[];
  readonly prompt: string;
  readonly channel: InitialPromptChannel;
}): WindowsArgvPromptPlacement {
  const reason = isWindowsBatchLauncher(input.file)
    ? 'batch-launcher'
    : windowsCommandLineLength(input.file, input.args) > WINDOWS_COMMAND_LINE_SAFE_LIMIT
      ? 'command-line-too-long'
      : null;
  if (!reason) return { defer: false };
  const index = input.args.lastIndexOf(input.prompt);
  if (index < 0) return { defer: false };
  const args = [...input.args];
  const flag =
    input.channel.kind === 'interactive-flag' && index > 0 && args[index - 1] === input.channel.flag;
  args.splice(flag ? index - 1 : index, flag ? 2 : 1);
  return { defer: true, reason, args };
}
