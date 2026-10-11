import path from 'node:path';
import { stripInheritedHeavyCommandEnvironment } from '../main/orch/native-heavy-inherited-env';

/**
 * F-1216: o processo de teste não herda a admissão heavy do pane.
 *
 * Agentes rodam a suíte DENTRO de panes do próprio Nexus, e o pane exporta a
 * admissão heavy do app INSTALADO: `NEXUS_HEAVY_JOB_BASE` (supervisor do app),
 * `NEXUS_HEAVY_COMMAND_URL` + `NEXUS_GATE_TOKEN` (fila do projeto),
 * `BASH_ENV`/`ZDOTDIR` com o guard de shell e `NODE_OPTIONS` com o
 * `preload.cjs`. Herdados, eles desviavam `node`/`tsc`/`make` filhos dos
 * testes para o supervisor e os guards da versão instalada (exit 78, guard
 * velho com `set -u`, zsh recursivo) — ~17 falhas falsas que agentes tomavam
 * por regressão. Quem testa a admissão monta o próprio ambiente explícito.
 *
 * Roda no `vitest.config.ts` (processo principal, ANTES de os workers
 * nascerem: sem URL e token o preload herdado não embrulha o child_process
 * deles) e no `vitest.setup.ts` (cada worker: o preload do principal ainda
 * reinjeta o `--require` no `NODE_OPTIONS` do fork).
 */
export function stripInheritedHeavyAdmission(env: NodeJS.ProcessEnv): void {
  stripInheritedHeavyCommandEnvironment(env as Record<string, string>);
  // Sem NEXUS_HEAVY_DIR (ambiente parcial), o guard ainda é reconhecível pelo caminho.
  if (isHeavyCommandResource(env.BASH_ENV, 'shell.bash')) delete env.BASH_ENV;
  if (env.ZDOTDIR && (path.basename(env.ZDOTDIR) === 'heavy-command' || path.basename(env.ZDOTDIR).startsWith('heavy-zsh-'))) delete env.ZDOTDIR;
  delete env.NEXUS_GATE_TOKEN;
  const options = withoutHeavyCommandPreload(env.NODE_OPTIONS);
  if (options) env.NODE_OPTIONS = options; else delete env.NODE_OPTIONS;
}

function isHeavyCommandResource(file: string | undefined, name: string): boolean {
  return Boolean(file) && path.basename(file!) === name && path.basename(path.dirname(file!)) === 'heavy-command';
}

/** Remove `--require …/heavy-command/preload.cjs` (e `-r`/`=`), preservando o resto. */
export function withoutHeavyCommandPreload(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const tokens = nodeOptionsTokens(value);
  if (!tokens) return value;
  const kept: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const option = /^(--require|-r)(?:=([\s\S]*))?$/.exec(tokens[index]);
    if (option) {
      const required = option[2] ?? tokens[index + 1];
      if (isHeavyCommandResource(required, 'preload.cjs')) {
        if (option[2] === undefined) index += 1;
        continue;
      }
    }
    kept.push(tokens[index]);
  }
  return kept.length ? kept.map((token) => (/[\s"\\]/.test(token) ? JSON.stringify(token) : token)).join(' ') : undefined;
}

/** NODE_OPTIONS dividido como o Node faz (mesma regra de resources/heavy-command/preload.cjs). */
function nodeOptionsTokens(value: string): string[] | null {
  const tokens: string[] = [];
  let quoted = false;
  let fresh = true;
  for (let index = 0; index < value.length; index += 1) {
    let char = value[index];
    if (char === '\\' && quoted) {
      if (index + 1 === value.length) return null;
      char = value[++index];
    } else if (char === ' ' && !quoted) {
      fresh = true;
      continue;
    } else if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (fresh) {
      tokens.push(char);
      fresh = false;
    } else tokens[tokens.length - 1] += char;
  }
  return quoted ? null : tokens;
}
