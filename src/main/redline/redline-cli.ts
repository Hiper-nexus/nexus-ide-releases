/**
 * Nexus Redline (Linux) — comandos de terminal e da barra do desktop.
 *
 *   nexus-ide --redline-status         JSON de uma linha (Waybar/Omarchy) com a pior janela
 *   nexus-ide --redline-bar-install [--app /caminho/nexus-ide]
 *                                      põe o módulo na barra do Omarchy (backup, idempotente);
 *                                      --app: executável que a barra deve chamar (instalação fora do comum)
 *   nexus-ide --redline-bar-uninstall  tira o módulo
 *   nexus-ide --redline-bar-snippet    imprime os trechos (Omarchy e Waybar) sem gravar nada
 *
 * Roda no PRÓPRIO binário do app, antes de qualquer janela, e sai: a barra do
 * desktop chama `--redline-status` a cada poucos segundos, então nada aqui
 * pode abrir o Nexus, travar ou levantar a interface. (O Electron empacotado
 * desliga `ELECTRON_RUN_AS_NODE`, por isso não dá para ser um script solto.)
 *
 * Leitura somente, com a MESMA leitura segura e a MESMA validação do ícone de
 * bandeja (`readRegularFileCapped` + `parseRedlineSnapshot`): o arquivo nunca é
 * confiado, FIFO ou arquivo enorme não pendura a barra. Sem segredos, e-mail
 * sempre mascarado.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, realpathSync, writeSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
import { REDLINE_SNAPSHOT_FILENAME } from '../../shared/redline-types';
import { buildRedlineBarOutput, formatRedlineBarJson } from './redline-bar';
import {
  REDLINE_BAR_INTERVAL_SECONDS,
  REDLINE_BAR_MODULE_ID,
  installRedlineBar,
  redlineBarEntry,
  shellQuote,
  stableStringify,
  uninstallRedlineBar,
  type RedlineBarInstallResult,
} from './redline-bar-config';
import { readRegularFileCapped } from './redline-safe-read';
import { REDLINE_SNAPSHOT_MAX_BYTES, parseRedlineSnapshot } from './redline-snapshot-parse';

export type RedlineCliCommand = 'status' | 'install' | 'uninstall' | 'snippet';

const FLAGS: Readonly<Record<string, RedlineCliCommand>> = {
  '--redline-status': 'status',
  '--redline-bar-install': 'install',
  '--redline-bar-uninstall': 'uninstall',
  '--redline-bar-snippet': 'snippet',
};

/**
 * Procura uma das flags no argv do processo. Só vale igualdade exata (nada de
 * prefixo) e só no processo principal: `second-instance` e links `nexus://`
 * nunca trazem estas flags.
 */
export function parseRedlineCliArgs(argv: readonly string[]): RedlineCliCommand | null {
  for (const arg of argv.slice(1)) {
    if (Object.prototype.hasOwnProperty.call(FLAGS, arg)) return FLAGS[arg];
  }
  return null;
}

/** Valor de `--app <caminho>`: `null` sem a opção, `''` quando falta o valor. */
export function parseRedlineAppOption(argv: readonly string[]): string | null {
  const index = argv.indexOf('--app', 1);
  return index === -1 ? null : (argv[index + 1] ?? '');
}

export interface RedlineCliDeps {
  homedir: string;
  env: NodeJS.ProcessEnv;
  /** Caminho do binário que está rodando (o Electron do app). */
  execPath: string;
  now: () => number;
  out: (text: string) => void;
  err: (text: string) => void;
  reloadShell: () => boolean;
  /** Teste: devolve o caminho resolvido de um arquivo ou `null` se não existe. */
  resolvePath: (file: string) => string | null;
  /** Valor de `--app` (ou `null`). */
  appOption?: string | null;
  isExecutable?: (file: string) => boolean;
}

/** `--app` vira linha de comando da barra: só caminho absoluto, sem controle, que exista e execute. */
export function validateAppOption(value: string, deps: Pick<RedlineCliDeps, 'resolvePath' | 'isExecutable'>): string | null {
  // eslint-disable-next-line no-control-regex
  if (!value.startsWith('/') || /[\u0000-\u001f\u007f]/.test(value)) {
    return '--app precisa de um caminho absoluto, por exemplo --app /usr/bin/nexus-ide.';
  }
  if (deps.resolvePath(value) === null || !(deps.isExecutable?.(value) ?? true)) {
    return `--app: "${value}" não existe ou não é executável.`;
  }
  return null;
}

/**
 * O caminho que a barra deve chamar: o atalho estável (`~/.local/bin/nexus-ide`
 * do instalador, `/usr/bin/nexus-ide` dos pacotes) quando ele aponta para ESTE
 * binário, para sobreviver a atualização; senão o próprio binário.
 */
export function resolveAppExecutable(deps: Pick<RedlineCliDeps, 'homedir' | 'execPath' | 'resolvePath'>): string {
  const self = deps.resolvePath(deps.execPath) ?? deps.execPath;
  for (const candidate of [join(deps.homedir, '.local', 'bin', 'nexus-ide'), '/usr/bin/nexus-ide']) {
    if (deps.resolvePath(candidate) === self) return candidate;
  }
  return deps.execPath;
}

function statusLine(deps: RedlineCliDeps): string {
  const file = join(deps.homedir, '.nexus', REDLINE_SNAPSHOT_FILENAME);
  const read = readRegularFileCapped(file, REDLINE_SNAPSHOT_MAX_BYTES);
  const snapshot = read.kind === 'text' ? parseRedlineSnapshot(read.text) : null;
  return formatRedlineBarJson(buildRedlineBarOutput(snapshot, deps.now()));
}

export function redlineBarSnippets(appExecutable: string): string {
  const exec = `${shellQuote(appExecutable)} --redline-status`;
  const omarchy = stableStringify(redlineBarEntry(appExecutable)).trimEnd();
  const waybar = JSON.stringify(
    {
      'custom/nexus-redline': {
        exec,
        'return-type': 'json',
        format: '{text}',
        interval: REDLINE_BAR_INTERVAL_SECONDS,
        'on-click': 'xdg-open nexus://quota',
        tooltip: true,
      },
    },
    null,
    2,
  );
  return [
    '# Barra do Omarchy (quickshell) — o mais simples é: nexus-ide --redline-bar-install',
    '# Ou à mão, em ~/.config/omarchy/shell.json, dentro de bar.layout.right:',
    omarchy,
    '# e depois: omarchy-shell shell reloadConfig',
    '',
    '# Waybar — módulo em ~/.config/waybar/config.jsonc (e "custom/nexus-redline" em "modules-right"):',
    waybar,
    '# Cores opcionais em ~/.config/waybar/style.css:',
    '#   #custom-nexus-redline.warn { color: #f5a623; }',
    '#   #custom-nexus-redline.danger { color: #ff4f8b; }',
    '#   #custom-nexus-redline.stale { opacity: 0.6; }',
    '',
  ].join('\n');
}

function reportInstall(result: RedlineBarInstallResult, deps: RedlineCliDeps): number {
  const write = result.status === 'refused' ? deps.err : deps.out;
  write(`${result.message}\n`);
  if (result.backupPath !== undefined) {
    write(`Backup: ${result.backupPath}\n`);
    write(`Para desfazer: cp ${shellQuote(result.backupPath)} ${shellQuote(result.configPath)} && omarchy-shell shell reloadConfig\n`);
  }
  if (result.reloaded === false) {
    write('Não consegui avisar o shell; rode: omarchy-shell shell reloadConfig (ou reinicie a sessão).\n');
  }
  if (result.status === 'installed' || result.status === 'updated') {
    write(`O módulo "${REDLINE_BAR_MODULE_ID}" lê ~/.nexus/redline-last-good.json, o mesmo dado do ícone de bandeja.\n`);
  }
  return result.status === 'refused' ? 1 : 0;
}

/** Executa um comando e devolve o código de saída. Nunca lança. */
export function runRedlineCli(command: RedlineCliCommand, deps: RedlineCliDeps): number {
  try {
    if (command === 'status') {
      deps.out(`${statusLine(deps)}\n`);
      return 0;
    }
    let appExecutable = resolveAppExecutable(deps);
    if (deps.appOption !== undefined && deps.appOption !== null) {
      const problem = validateAppOption(deps.appOption, deps);
      if (problem !== null) {
        deps.err(`${problem}\n`);
        return 1;
      }
      appExecutable = deps.appOption;
    }
    if (command === 'snippet') {
      deps.out(redlineBarSnippets(appExecutable));
      return 0;
    }
    const barDeps = { homedir: deps.homedir, env: deps.env, now: deps.now, reloadShell: deps.reloadShell };
    return reportInstall(
      command === 'install' ? installRedlineBar(barDeps, appExecutable) : uninstallRedlineBar(barDeps),
      deps,
    );
  } catch (error) {
    // A barra chama isto a cada poucos segundos: um erro vira JSON neutro, não pilha.
    if (command === 'status') {
      deps.out(`${JSON.stringify({ text: 'Redline —', tooltip: 'Nexus Redline · leitura indisponível', class: ['nexus-redline', 'unknown'] })}\n`);
      return 0;
    }
    deps.err(`Não consegui concluir: ${error instanceof Error ? error.message : 'erro desconhecido'}\n`);
    return 1;
  }
}

function writeFd(fd: 1 | 2, text: string): void {
  try {
    writeSync(fd, text);
  } catch {
    // stdout fechado (a barra desistiu): nada a fazer.
  }
}

/** Acha um executável no PATH só com fs (sem rodar nada). */
export function findOnPath(name: string, pathValue: string): string | null {
  for (const dir of pathValue.split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // próximo diretório
    }
  }
  return null;
}

/**
 * Pede ao shell do Omarchy que releia o shell.json. Disparo e esquecimento: o
 * processo sai logo depois (o Main nunca espera processo síncrono, F-764), e o
 * filho solto continua sozinho. `false` quando não há `omarchy-shell` no PATH.
 */
export function requestShellReload(pathValue: string): boolean {
  const binary = findOnPath('omarchy-shell', pathValue);
  if (binary === null) return false;
  try {
    const child = spawn(binary, ['shell', 'reloadConfig'], { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function realDeps(): RedlineCliDeps {
  return {
    homedir: osHomedir(),
    env: process.env,
    execPath: process.execPath,
    now: () => Date.now(),
    out: (text) => writeFd(1, text),
    err: (text) => writeFd(2, text),
    reloadShell: () => requestShellReload(process.env.PATH ?? ''),
    resolvePath: (file) => {
      try {
        return realpathSync(file);
      } catch {
        return null;
      }
    },
    appOption: parseRedlineAppOption(process.argv),
    isExecutable: (file) => {
      try {
        accessSync(file, fsConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Chamado pelo `redline-cli-boot` antes de qualquer outra coisa do Main: se o
 * argv pede um comando, executa e SAI do processo; senão não faz nada.
 */
export function runRedlineCliFromProcess(): void {
  const command = parseRedlineCliArgs(process.argv);
  if (command === null) return;
  process.exit(runRedlineCli(command, realDeps()));
}
