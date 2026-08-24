/**
 * Login de CLI: qual comando o Nexus digita num terminal para a ferramenta
 * autenticar a si mesma.
 *
 * Doutrina: a autoridade do fluxo de login é SEMPRE a CLI. O Nexus não coleta
 * senha, não abre browser por conta própria e não guarda credencial de
 * assinatura — ele abre um terminal de verdade, roda o comando declarado pelo
 * adapter e sai da frente. Quem grava a sessão (Keychain, ~/.config, cookie do
 * device flow) é a própria ferramenta, exatamente como se o operador tivesse
 * digitado no shell dele.
 */

/** Métodos de auth cujo primeiro run interativo já dispara o login. */
const INTERACTIVE_LOGIN_METHODS: ReadonlySet<string> = new Set([
  'oauth',
  'subscription',
  'device_code',
]);

export interface CliLoginSource {
  /** `auth.loginCommand` declarado pelo adapter (builtin ou do usuário). */
  readonly loginCommand?: string | null;
  /** `auth.method` do adapter. */
  readonly authMethod?: string | null;
  /** `spawn.interactive` do adapter — só o binário é aproveitado. */
  readonly interactive?: readonly string[] | null;
}

/**
 * Um comando de login é digitado cru num PTY. Recusa o que não é uma linha
 * única e previsível: nada de quebra de linha (rodaria comandos que ninguém
 * revisou) e nada de placeholder de template não resolvido.
 */
function isSafeLoginCommand(command: string): boolean {
  if (command.length === 0 || command.length > 200) return false;
  if (/[\r\n]/.test(command)) return false;
  if (command.includes('{{')) return false;
  return true;
}

/**
 * Comando de login desta CLI, ou null quando ela não tem fluxo de terminal
 * (caso das que só aceitam API key — ali o caminho é colar a chave).
 */
export function resolveCliLoginCommand(source: CliLoginSource): string | null {
  const declared = (source.loginCommand ?? '').trim();
  if (declared.length > 0) {
    return isSafeLoginCommand(declared) ? declared : null;
  }

  const method = (source.authMethod ?? '').trim();
  if (!INTERACTIVE_LOGIN_METHODS.has(method)) return null;

  // Sem comando declarado: o primeiro run interativo da CLI é o próprio login.
  // Só o binário — argumentos de spawn (modelo, permissões) não pertencem aqui.
  const bin = (source.interactive?.[0] ?? '').trim();
  if (bin.length === 0) return null;
  return isSafeLoginCommand(bin) ? bin : null;
}

/**
 * Login is typed into a shell pane: the CLI exits, the shell stays. The
 * watcher cannot wait for process death — it has to recognize the CLI's own
 * success line (Cursor: "Logged in as …" / "Authentication tokens stored").
 */
export function cliLoginLooksComplete(output: string): boolean {
  const text = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  if (/logged in as\s+\S+/i.test(text)) return true;
  if (/authentication tokens stored/i.test(text)) return true;
  if (/successfully (?:logged|signed) in/i.test(text)) return true;
  return false;
}

export function shouldFinishCliLoginWatch(input: {
  readonly output: string;
  readonly paneStillOpen: boolean;
  readonly paneExited: boolean;
  readonly authReady: boolean;
}): boolean {
  if (!input.paneStillOpen) return true;
  if (input.paneExited) return true;
  if (input.authReady) return true;
  return cliLoginLooksComplete(input.output);
}
