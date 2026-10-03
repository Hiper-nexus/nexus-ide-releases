import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';

interface ExecutionContext {
  readonly role: string;
  readonly scope?: ProjectExecutionScope;
  readonly executionScope?: ProjectExecutionScope;
  readonly sharedTabWorktree?: true;
  /** Main-owned mark of an operator helper spawned as an isolated writer. */
  readonly isolatedWriter?: true;
}

/** Derived from main-issued scopes, never from tool arguments or prompt text. */
export function isIsolatedWriterContext(ctx: ExecutionContext): boolean {
  return (ctx.role === 'worker' || ctx.isolatedWriter === true) && ctx.sharedTabWorktree !== true && Boolean(ctx.scope && ctx.executionScope &&
    ctx.executionScope.rootRealPath !== ctx.scope.rootRealPath);
}

const ALLOWED = new Set(['git_add', 'git_commit', 'git_status', 'git_diff', 'git_log']);
/** Nunca main/master: o registry só aloca branches derivadas sob `nexus/`. */
export const ISOLATED_WRITER_BRANCH_PREFIX = 'refs/heads/nexus/';
export const ISOLATED_WRITER_GIT_GUIDANCE =
  'isolated_worktree: push/pull/stash/checkout/reset/clean e troca de branch são proibidos. ' +
  'Use nexus_git_add, nexus_git_commit, nexus_git_status, nexus_git_diff ou nexus_git_log ' +
  'somente na worktree/branch atribuída. Entregue arquivos tocados e diff no handoff; ' +
  'o orquestrador cuida da integração/publicação. Para builds/testes, use a ferramenta nativa do CLI conforme o perfil escolhido.';

export function isolatedWriterPolicyError(): Error {
  return new Error(ISOLATED_WRITER_GIT_GUIDANCE);
}

export function assertIsolatedWriterGitTool(ctx: ExecutionContext, toolName: string): void {
  if (isIsolatedWriterContext(ctx) && !ALLOWED.has(toolName.replace(/^nexus_/, ''))) {
    throw isolatedWriterPolicyError();
  }
}

function canonicalIsolatedGitToolName(toolName: string): string {
  let name = toolName.trim().toLowerCase();
  // Claude-family PreToolUse vê a tool como `mcp__nexus__nexus_git_commit`.
  if (name.startsWith('mcp__nexus__')) name = name.slice('mcp__nexus__'.length);
  return name.startsWith('nexus_') ? name.slice('nexus_'.length) : name;
}

/**
 * F-794: as cinco operações Git do writer isolado (status/diff/log/add/commit)
 * valem pela AUTORIDADE do Main — worktree e branch alocadas no registry —, não
 * pelo allowlist da squad. O contrato do brief manda commitar com
 * nexus_git_add/commit, mas workers nascem com allowlist vazia: na Missão
 * Terminais (03/10) o Codex recebeu "outside this agent's allowlist" e o
 * trabalho validado do F-764 e do F-768 ficou só no working tree.
 *
 * A concessão sai do contexto mintado pelo Main (papel + escopo de execução
 * diferente do checkout de coordenação), nunca de argumento nem de texto. Cada
 * chamada continua presa ao handler (`assertIsolatedGitAuthority`: registro
 * `ready`, HEAD na branch `nexus/…` alocada, toplevel = worktree) e ao resto do
 * despacho (intent da missão, auditoria). Sessão read-only nunca ganha a
 * concessão; push/pull/sync/troca de branch seguem negados.
 */
export function grantsIsolatedWriterGitTool(
  ctx: ExecutionContext & { readonly readOnly?: boolean },
  toolName: string,
): boolean {
  if (ctx.readOnly === true || !isIsolatedWriterContext(ctx)) return false;
  return ALLOWED.has(canonicalIsolatedGitToolName(toolName));
}

/**
 * A PATH wrapper cannot confine absolute executables, scripts or nested shells.
 * This MCP main-process lane therefore executes NO shell for isolated writers.
 * Only a literal Git command is translated to the five protected MCP handlers.
 * CLI-internal execution follows its own profile/hooks, outside this MCP
 * guard. This is not a claim to sandbox arbitrary programs by parsing.
 */
function literalArgv(command: string): string[] {
  if (command.length > 16_384) throw isolatedWriterPolicyError();
  const argv: string[] = [];
  let word = '';
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\0' || c === '\n' || c === '\r') throw isolatedWriterPolicyError();
    if (quote === "'") {
      if (c === quote) quote = undefined;
      else word += c;
    } else if (c === '\\') {
      const next = command[++i];
      if (next === undefined || /[\0\r\n]/.test(next)) throw isolatedWriterPolicyError();
      word += quote === '"' && !['\\', '"', '$', '`'].includes(next) ? `\\${next}` : next;
      started = true;
    } else if (quote === '"') {
      if (c === quote) quote = undefined;
      else if (c === '$' || c === '`') throw isolatedWriterPolicyError();
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) argv.push(word);
      word = ''; started = false;
    } else {
      if (/[;&|<>()$`#]/.test(c)) throw isolatedWriterPolicyError();
      word += c; started = true;
    }
  }
  if (quote) throw isolatedWriterPolicyError();
  if (started) argv.push(word);
  return argv;
}

export function parseIsolatedWriterGitCommand(command: string, cwd: string): {
  tool: string;
  args: Record<string, unknown>;
} {
  const argv = literalArgv(command);
  if (argv.shift() !== 'git') throw isolatedWriterPolicyError();
  if (argv[0] === '-C') {
    argv.shift();
    const directory = argv.shift();
    if (!directory) throw isolatedWriterPolicyError();
    cwd = path.resolve(cwd, directory);
  }
  const operation = argv.shift();
  const args: Record<string, unknown> = { cwd };
  switch (operation) {
    case 'status':
      if (argv.some((arg) => !['--short', '--branch'].includes(arg))) throw isolatedWriterPolicyError();
      break;
    case 'diff':
      if (argv.length > 1 || (argv.length && !['--cached', '--staged'].includes(argv[0]))) throw isolatedWriterPolicyError();
      if (argv.length) args.staged = true;
      break;
    case 'log':
      if (argv[0] === '--oneline') argv.shift();
      if (argv.length) {
        if (argv.length !== 2 || argv[0] !== '-n' || !/^\d+$/.test(argv[1]) || Number(argv[1]) < 1 || Number(argv[1]) > 100) throw isolatedWriterPolicyError();
        args.count = Number(argv[1]);
      }
      break;
    case 'add':
      if (argv[0] === '--') argv.shift();
      if (argv.some((arg) => !arg || arg.startsWith('-') || arg.startsWith(':'))) throw isolatedWriterPolicyError();
      args.paths = argv.length ? argv : ['.'];
      break;
    case 'commit':
      if (argv.length !== 2 || !['-m', '--message'].includes(argv[0]) || !argv[1].trim()) throw isolatedWriterPolicyError();
      args.message = argv[1];
      break;
    default:
      throw isolatedWriterPolicyError();
  }
  return { tool: `nexus_git_${operation}`, args };
}
