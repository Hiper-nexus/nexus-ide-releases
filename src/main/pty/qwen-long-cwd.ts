/**
 * F-788: o Qwen Code (0.24.x, e o `main` do upstream até 03/10) guarda a
 * conversa em `<QWEN_HOME>/projects/<cwd inteiro, cada caractere não
 * alfanumérico trocado por '-'>`. A worktree de um writer do Nexus passa de
 * 255 caracteres (NAME_MAX): esse nome não pode existir, a checagem do
 * `--session-id` lê o ENAMETOOLONG como "sessão ocupada" e o Qwen sai com 1
 * em 2 s ("Session Id … already exists").
 *
 * O Qwen não aceita o diretório do projeto por flag nem por env: o projeto é
 * sempre `process.cwd()`, que o kernel devolve físico mesmo quando o cwd do
 * spawn é um symlink. Por isso, SÓ quando o nome passaria do limite: um
 * apelido curto e estável (symlink no provider-state do checkout) aponta para
 * a worktree, o processo continua no cwd físico e um preload (`--require`, que
 * o relaunch do Qwen herda pelo execArgv) faz o `process.cwd()` responder o
 * apelido. Fora disso o spawn do Qwen não muda.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  ensurePrivateDirectory,
  writePrivateFileAtomic,
} from '../orch/cli-mcp-session-artifacts';

/** NAME_MAX do APFS/ext4: o nome da pasta do projeto no `projects/` do Qwen. */
export const QWEN_PROJECT_NAME_MAX = 255;
/** O preload lê o apelido daqui; sem a variável ele não faz nada. */
export const QWEN_LOGICAL_CWD_ENV = 'NEXUS_QWEN_LOGICAL_CWD';
const PRELOAD_FILE = 'nexus-logical-cwd.cjs';

/** O nome que o Qwen dá à pasta do projeto (`sanitizeCwd`). */
export function qwenProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function qwenNeedsLogicalCwd(cwd: string): boolean {
  return qwenProjectDirName(cwd).length > QWEN_PROJECT_NAME_MAX;
}

/**
 * Vale só no processo do Qwen (execArgv): comandos que o agente roda no shell
 * não carregam este arquivo. Nunca lança; se o cwd real deixar de ser a
 * worktree do apelido (`/cd`, outro processo), o `process.cwd()` original volta.
 */
export const QWEN_LOGICAL_CWD_PRELOAD = `'use strict';
// Nexus F-788: o Qwen Code nomeia a pasta da conversa com o cwd inteiro. Numa
// worktree longa o nome passa de 255 caracteres e não pode existir. O Nexus
// abre o Qwen no cwd físico e este preload faz o process.cwd() responder o
// apelido curto (symlink para a mesma worktree).
const fs = require('node:fs');
const alias = process.env.${QWEN_LOGICAL_CWD_ENV};
if (alias) {
  try {
    const physical = fs.realpathSync.native(alias);
    const realCwd = process.cwd.bind(process);
    if (realCwd() === physical) {
      process.cwd = function cwd() {
        const current = realCwd();
        return current === physical ? alias : current;
      };
    }
  } catch {
    // Apelido sumiu: o Qwen segue com o cwd físico.
  }
}
`;

export interface QwenLogicalCwdLaunch {
  /** Node que roda o entrypoint (o mesmo que o shebang `env node` acharia). */
  readonly file: string;
  readonly argsPrefix: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** Preloads já gravados neste processo do app (um por checkout). */
const writtenPreloads = new Set<string>();

function ensurePreload(stateHome: string): string {
  const file = path.join(stateHome, PRELOAD_FILE);
  if (!writtenPreloads.has(file) || !fs.existsSync(file)) {
    writePrivateFileAtomic(file, QWEN_LOGICAL_CWD_PRELOAD);
    writtenPreloads.add(file);
  }
  return file;
}

/** Apelido → worktree. Só mexe em symlink; entrada que não é symlink não é nossa. */
function ensureAlias(alias: string, target: string, retried = false): boolean {
  let current: string;
  try {
    current = fs.readlinkSync(alias);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    try {
      fs.symlinkSync(target, alias, 'dir');
      return true;
    } catch (raced) {
      // Dois spawns da mesma worktree ao mesmo tempo: vale o que já está lá.
      if ((raced as NodeJS.ErrnoException).code !== 'EEXIST' || retried) return false;
      return ensureAlias(alias, target, true);
    }
  }
  if (current === target) return true;
  // Apelido apontando para outro lugar: troca atômica do link, nunca do alvo.
  const staged = `${alias}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.symlinkSync(target, staged, 'dir');
    fs.renameSync(staged, alias);
    return true;
  } catch {
    fs.rmSync(staged, { force: true });
    return false;
  }
}

/**
 * Lançamento do Qwen com cwd lógico curto, ou null quando não precisa (nome
 * dentro do limite) ou não dá (Windows, lançador que não é script Node, sem
 * Node no PATH, apelido ocupado por algo que não é nosso). Null = spawn
 * normal; o boot-exit e a cauda do PTY contam o resto.
 */
export function qwenLogicalCwdLaunch(input: {
  /** Lançador resolvido (`~/.npm-global/bin/qwen` → `cli-entry.js`). */
  readonly binPath: string;
  /** cwd físico do spawn (já resolvido pelo Main). */
  readonly cwd: string;
  /** `<userData>/provider-state/qwen/<checkoutId>`. */
  readonly stateHome: string;
  readonly nodePath: string | null;
}): QwenLogicalCwdLaunch | null {
  if (process.platform === 'win32' || !qwenNeedsLogicalCwd(input.cwd)) return null;
  if (!input.nodePath || !path.isAbsolute(input.nodePath)) return null;
  try {
    const entry = fs.realpathSync(input.binPath);
    // `node --require … <entry>` só serve ao lançador JS do npm.
    if (!/\.[cm]?js$/u.test(entry)) return null;
    ensurePrivateDirectory(input.stateHome);
    const hash = createHash('sha256').update(input.cwd).digest('hex').slice(0, 16);
    const alias = path.join(input.stateHome, `w-${hash}`);
    if (qwenNeedsLogicalCwd(alias) || !ensureAlias(alias, input.cwd)) return null;
    return {
      file: input.nodePath,
      argsPrefix: ['--require', ensurePreload(input.stateHome), entry],
      env: { [QWEN_LOGICAL_CWD_ENV]: alias, PWD: alias },
    };
  } catch {
    return null;
  }
}

export function resetQwenLogicalCwdForTests(): void {
  writtenPreloads.clear();
}
