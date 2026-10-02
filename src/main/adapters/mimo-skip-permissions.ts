/**
 * F-742: o MiMo Code (0.1.15) mostra "WARNING: Bypass Permissions mode" a CADA
 * boot com `--dangerously-skip-permissions` num TTY — sem memória do aceite e
 * com "No, exit (recommended)" já selecionado. Aceitar só liga
 * `MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS=1` (handler do `$0` no bundle), e a
 * documentação embutida do MiMo lista a variável como superfície oficial
 * ("Any surface (env)": a config vira `permission: {"*": "allow"}`).
 *
 * O Nexus passa a variável e tira a flag: o mesmo modo, sem diálogo — nenhuma
 * tecla para errar e nenhum brief colado cedo caindo nele. Em 02/10 o brief de
 * um worker retomado (colado depois do boot) entrou no buffer antes do
 * diálogo, o primeiro `\n` dele confirmou "No, exit" e o MiMo saiu em 5 s.
 */
export const MIMO_SKIP_PERMISSIONS_ENV = 'MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS';

/** A flag e o alias dela (`--yolo`) no comando `$0` do MiMo. */
const MIMO_SKIP_PERMISSIONS_FLAGS: ReadonlySet<string> = new Set([
  '--dangerously-skip-permissions',
  '--yolo',
]);

export function mimoSkipPermissionsViaEnv(args: readonly string[]): {
  readonly args: string[];
  readonly env: Readonly<Record<string, string>>;
} {
  const kept = args.filter((arg) => !MIMO_SKIP_PERMISSIONS_FLAGS.has(arg));
  return kept.length === args.length
    ? { args: [...args], env: {} }
    : { args: kept, env: { [MIMO_SKIP_PERMISSIONS_ENV]: '1' } };
}
