import path from 'node:path';

/**
 * Shells created for the human hand never inherit an AI execution capability.
 *
 * Sem dependência de Electron de propósito: o setup da suíte (F-1216) aplica a
 * mesma limpeza ao processo de teste, que também não pode herdar a admissão
 * heavy do pane onde foi lançado.
 */
export function stripInheritedHeavyCommandEnvironment(env: Record<string, string>): void {
  const dir = env.NEXUS_HEAVY_DIR;
  if (dir && env.BASH_ENV === path.join(dir, 'shell.bash')) delete env.BASH_ENV;
  if (dir && (env.ZDOTDIR === dir || env.ZDOTDIR === env.NEXUS_HEAVY_ZDOTDIR)) {
    const original = env.NEXUS_HEAVY_ORIG_ZDOTDIR;
    if (original) env.ZDOTDIR = original; else delete env.ZDOTDIR;
  }
  for (const key of Object.keys(env)) if (key.startsWith('NEXUS_HEAVY_')) delete env[key];
}
