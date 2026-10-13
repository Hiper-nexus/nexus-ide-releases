// POST /hook/integration — portão de integração no hook PreToolUse/Bash do
// Claude (F-234). O `nexus_git_push` e o push do `nexus_mission_set_status`
// já passam pelo portão no Main; este endpoint cobre o `git push` /
// `gh pr create|merge` / `git merge … main` digitado NO BASH do pane de
// missão, que escapava de qualquer revisão.
//
// Decisão deliberada do portão (`review_required: …`) vira
// `{"decision":"block","reason":…}` — o agente continua com a instrução.
// Fora do caminho (sem missão, comando não integrador, --dry-run) responde
// `{}`. Falha de store/infra antes de saber que o comando integra também é
// `{}`. Depois que o comando é integrador, erro ao medir o checkout bloqueia.
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { AgentGateContext } from './gate';
import { executionScopeFor } from './gate';
import { handleHookJsonPost } from './hook-http';
import { sameRepositoryExecutionRoot } from './nested-worktree-execution';
import { isInsidePath } from './workspace-path';
import {
  assertIntegrationReviewedAsync,
  INTEGRATION_REVIEW_REQUIRED,
  isIntegrationReviewRequiredError,
} from './integration-review-gate';
import { getProjectDomainStores } from './project-domain-store-registry';
import {
  assertSafeLocalGitConfigAsync,
  AsyncProcessGitRunner,
  type AsyncGitRunner,
} from '../runtime/git-command';
import { trace } from '../observability/main-trace';

/** Mesmo teto do /hook/triage — payloads de hook são metadados de evento. */
export const HOOK_INTEGRATION_MAX_BODY_BYTES = 64 * 1024;

/**
 * F-815: este hook roda a cada comando Bash de todo pane de missão, dentro do
 * Main (Electron). O git é SEMPRE assíncrono (`AsyncProcessGitRunner`: mesmo
 * envelope de segurança do runner síncrono — `-c core.fsmonitor=false`,
 * hooks desligados, `GIT_*` descartado — e `assertSafeLocalGitConfigAsync`
 * antes de qualquer leitura num checkout que o agente escreve), com timeout
 * curto e um orçamento total por requisição. O transporte do hook desiste em
 * 10 s (`INTEGRATION_HOOK_TRANSPORT_SECONDS`). Estourar o orçamento no meio da
 * medida de um comando já integrador bloqueia; antes de saber que integra, a
 * falha continua `{}` (o hook responde, não pendura o CLI).
 */
export const HOOK_GIT_CALL_TIMEOUT_MS = 5_000;
export const HOOK_GIT_TOTAL_BUDGET_MS = 8_000;

let sharedGitRunner: AsyncGitRunner | undefined;
/** Sob demanda: quem importa só `integrationCommandHit` não instancia o runner. */
function defaultGitRunner(): AsyncGitRunner {
  return (sharedGitRunner ??= new AsyncProcessGitRunner());
}

/**
 * Envolve o runner com timeout por chamada e o orçamento total do hook: cada
 * `run` recebe `min(teto por chamada, o que resta do orçamento)` e, esgotado o
 * orçamento, nem dispara o processo.
 */
export function boundedHookGitRunner(
  git: AsyncGitRunner,
  budgetMs: number = HOOK_GIT_TOTAL_BUDGET_MS,
  now: () => number = Date.now,
): AsyncGitRunner {
  const deadline = now() + budgetMs;
  return {
    run: (cwd, args, options) => {
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        return Promise.reject(new Error('hook_git_budget_exhausted'));
      }
      return git.run(cwd, args, {
        ...options,
        timeoutMs: Math.min(HOOK_GIT_CALL_TIMEOUT_MS, remainingMs),
      });
    },
  };
}

// F-814: `git merge` só é o subcomando `merge` quando seguido de espaço/fim. Com
// `\b`, o hífen de `git merge-base`/`merge-tree`/`merge-file` (plumbing de
// leitura) casava como fronteira de palavra e tudo virava "integração".
// F-1423/F-1432: opções globais lineares antes do subcomando — `-C <path>`,
// `-c <arg>` e `--no-pager`, em qualquer ordem, cada uma com o argumento dela.
// Sem quantificador aninhado. `--git-dir` e `--work-tree` continuam fora.
const GIT_GLOBAL_OPTION =
  '(?:-C\\s+(?:"[^"]*"|\'[^\']*\'|\\S+)|-c\\s+(?:"[^"]*"|\'[^\']*\'|\\S+)|--no-pager(?=\\s))';
const GIT_C_PREFIX = `(?:${GIT_GLOBAL_OPTION}\\s+)*`;
const GIT_MERGE_COMMAND = new RegExp(String.raw`^\s*git\s+${GIT_C_PREFIX}merge(?=\s|$)`, 'u');
const GIT_MERGE_REST = new RegExp(String.raw`^\s*git\s+${GIT_C_PREFIX}merge(?=\s|$)(.*)$`, 'u');
const INTEGRATION_SEGMENT = new RegExp(
  String.raw`^\s*(?:git\s+${GIT_C_PREFIX}push\b|gh\s+pr\s+(?:create|merge)\b|git\s+${GIT_C_PREFIX}merge(?=\s)[^;&|]*\b(?:main|master)\b)`,
  'u',
);
const GIT_GLOBAL_STEP =
  /^\s+(?:(-C)\s+(?:"([^"]*)"|'([^']*)'|(\S+))|(-c)\s+(?:"[^"]*"|'[^']*'|\S+)|(--no-pager)(?=\s|$))/u;
const CD_COMMAND = /^\s*cd\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/u;
// ponytail: presença do caractere, sem parser de shell. Teto: `~` literal no
// nome do diretório também recusa; o agente usa caminho absoluto.
const SHELL_UNRESOLVABLE = /[$`~*?{]/u;
const DIRECTORY_CHANGE_ATTEMPT =
  /^\s*(?:\\(?:cd|pushd|popd)|builtin(?:\s+-\S+)*\s+(?:cd|pushd|popd)|command(?:\s+-\S+)*\s+(?:cd|pushd|popd)|cd|pushd|popd)\b/u;
const SUBSHELL_DIRECTORY_WORD =
  /(?:^|[^A-Za-z0-9_])\\?(?:cd|pushd|popd)(?![A-Za-z0-9_])/u;

/**
 * F-814: `git merge --abort|--quit|--continue` só encerra/retoma um merge JÁ
 * iniciado (o início passou pelo portão; o push continua exigindo o veredito
 * do HEAD resultante). Bloqueá-los no checkout main deixava o agente sem o
 * comando de recuperação no meio de um conflito. Só vale a forma NUA — o
 * argumento sozinho (redirecionamentos de saída à parte): `git merge -m
 * '--abort' feature` e `git merge --abort feature` seguem sendo merge.
 */
const MERGE_CONTROL_FLAGS = new Set(['--abort', '--quit', '--continue']);
const SHELL_REDIRECTION_TOKEN = /^(?:\d*|&)(?:>>?|<)/u;

function isMergeControlSegment(segment: string): boolean {
  const match = GIT_MERGE_REST.exec(segment);
  if (!match) return false;
  const args = tokenizeArgs(match[1] ?? '').filter(
    (token) => !SHELL_REDIRECTION_TOKEN.test(token),
  );
  return args.length === 1 && MERGE_CONTROL_FLAGS.has(args[0]);
}

function commandSegments(command: string): string[] {
  return command.split(/&&|\|\||[;\n|]/u);
}

/** Segmento que pode integrar, depois de pular dry-run e controle de merge. */
function segmentRequestsIntegration(segment: string): boolean {
  if (segment.includes('--dry-run')) return false;
  if (isMergeControlSegment(segment)) return false;
  return INTEGRATION_SEGMENT.test(segment) || GIT_MERGE_COMMAND.test(segment);
}

function commandRequestsIntegration(command: string): boolean {
  return commandSegments(command).some(segmentRequestsIntegration);
}

function cdOperand(segment: string): string | null {
  if (!/^\s*cd\b/u.test(segment)) return null;
  const match = CD_COMMAND.exec(segment);
  if (match) return match[1] ?? match[2] ?? match[3] ?? '';
  return segment.replace(/^\s*cd\s*/u, '');
}

function throwUnresolvedCheckout(): never {
  throw new Error(
    `${INTEGRATION_REVIEW_REQUIRED}: checkout do merge/push não resolvível; ` +
      'rode no próprio cwd ou use caminho absoluto',
  );
}

function assertResolvableCheckoutOperand(raw: string | null): void {
  if (raw != null && SHELL_UNRESOLVABLE.test(raw)) throwUnresolvedCheckout();
}

function applyCd(segment: string, cwd: string): string | null {
  const match = CD_COMMAND.exec(segment);
  if (!match) return null;
  const raw = match[1] ?? match[2] ?? match[3];
  if (!raw || raw === '-' || raw.startsWith('-')) return null;
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
}

function isSimpleResolvableCd(segment: string): boolean {
  const match = CD_COMMAND.exec(segment);
  if (!match || /[()]/.test(segment)) return false;
  const raw = match[1] ?? match[2] ?? match[3];
  return !!raw && raw !== '-' && !raw.startsWith('-') && !SHELL_UNRESOLVABLE.test(raw);
}

/**
 * Aspas simples/duplas saem por inteiro. Aspas sem fechar escondem o resto
 * (teto: o que vem depois não é lido). Não expande `$` nem crase.
 */
function stripShellQuotes(command: string): string {
  let out = '';
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch !== '"' && ch !== "'") {
      out += ch;
      continue;
    }
    const quote = ch;
    i += 1;
    while (i < command.length && command[i] !== quote) i += 1;
    if (i >= command.length) break;
    out += ' ';
  }
  return out;
}

/** Subshell com cd/pushd/popd: o cwd de dentro não é o cwd que o parser vê. */
function throwIfSubshellChangesDirectory(command: string): void {
  const text = stripShellQuotes(command);
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') {
      if (depth === 0) start = i + 1;
      depth += 1;
      continue;
    }
    if (ch !== ')' || depth === 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      if (SUBSHELL_DIRECTORY_WORD.test(text.slice(start, i))) throwUnresolvedCheckout();
      start = -1;
    }
  }
  if (depth > 0 && start >= 0 && SUBSHELL_DIRECTORY_WORD.test(text.slice(start))) {
    throwUnresolvedCheckout();
  }
}

function segmentHidesDirectoryChange(segment: string): boolean {
  const plain = stripShellQuotes(segment);
  if (!plain.includes('(') && !plain.includes(')')) return false;
  return SUBSHELL_DIRECTORY_WORD.test(plain);
}

/** Último `-C` vale, relativo ao `-C` anterior. Sem `-C`, null (fica o cwd). */
function resolveGitGlobalDirectory(segment: string, cwd: string): string | null {
  if (!/^\s*git\b/u.test(segment)) return null;
  let rest = segment.replace(/^\s*git\b/u, '');
  let dir: string | null = null;
  for (;;) {
    const match = GIT_GLOBAL_STEP.exec(rest);
    if (!match) break;
    if (match[1] === '-C') {
      const raw = match[2] ?? match[3] ?? match[4] ?? '';
      assertResolvableCheckoutOperand(raw);
      if (!raw || raw === '-' || raw.startsWith('-')) throwUnresolvedCheckout();
      const base: string = dir ?? cwd;
      dir = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw);
    }
    rest = rest.slice(match[0].length);
  }
  return dir;
}

/**
 * Checkout em que o primeiro segmento integrador roda. `cd` simples atualiza
 * o cwd; `git -C` vence o cwd desse segmento. O restante do comando ainda é
 * lido: um `cd`/`pushd` posterior que não dá para resolver recusa o comando
 * inteiro, em vez de medir o pane.
 *
 * ponytail: `||` é partido como `&&` (o mesmo split do detector). Um lado que
 * o shell nem executaria ainda assim aponta o checkout. O teto é bloquear a
 * mais, nunca medir a árvore do pane quando o comando aponta outra.
 * Heredoc sem aspas que cita `( cd … )` também recusa. `( git push )` sem
 * cd/pushd não entra no portão — o segmento não começa com `git`. Aspas sem
 * fechar escondem o que vem depois. `--git-dir`/`--work-tree` não são lidos.
 */
function integrationCommandDirectory(command: string, baseCwd: string): string {
  throwIfSubshellChangesDirectory(command);
  let cwd = baseCwd;
  let checkout: string | null = null;
  for (const segment of commandSegments(command)) {
    if (segmentHidesDirectoryChange(segment)) throwUnresolvedCheckout();
    if (!isSimpleResolvableCd(segment) && DIRECTORY_CHANGE_ATTEMPT.test(segment)) {
      throwUnresolvedCheckout();
    }
    assertResolvableCheckoutOperand(cdOperand(segment));
    const next = applyCd(segment, cwd);
    if (next) {
      cwd = next;
      continue;
    }
    if (!segmentRequestsIntegration(segment)) continue;
    const redirected = resolveGitGlobalDirectory(segment, cwd);
    if (checkout === null) checkout = redirected ?? cwd;
  }
  return checkout ?? baseCwd;
}

/**
 * O caminho escolhido tem de existir. Dentro da raiz, o realpath basta (o git
 * dessa pasta devolve o HEAD da worktree aninhada, sem `worktree list`).
 * Fora, só uma worktree registrada deste repositório entra; o resto é null e
 * o hook bloqueia em vez de medir o pane.
 */
async function locateMergeCheckout(
  execution: ReturnType<typeof executionScopeFor>,
  candidate: string,
  git: AsyncGitRunner,
): Promise<string | null> {
  const lexical = path.resolve(candidate);
  const real = (() => {
    try {
      return fs.realpathSync(lexical);
    } catch {
      return null;
    }
  })();
  if (isInsidePath(execution.rootRealPath, lexical)) {
    if (real && isInsidePath(execution.rootRealPath, real)) return real;
    if (!real) return null;
  }
  if (!real) return null;
  if (isInsidePath(execution.rootRealPath, real)) return real;
  try {
    const linked = await sameRepositoryExecutionRoot(execution, real, git);
    return linked?.rootRealPath ?? null;
  } catch {
    return null;
  }
}

async function currentBranchName(
  git: AsyncGitRunner,
  cwd: string,
): Promise<string | null> {
  try {
    const result = await git.run(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], {
      allowFailure: true,
    });
    if (result.status === 0) {
      const branch = result.stdout.trim();
      return branch.length > 0 ? branch : null;
    }
  } catch {
    // Falha ao inspecionar git em cwd não crasha a checagem
  }
  return null;
}

function isProtectedBranch(branch: string | null): boolean {
  return branch === 'main' || branch === 'master';
}

function tokenizeArgs(argString: string): string[] {
  const tokens: string[] = [];
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/gu;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(argString)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[0]);
  }
  return tokens;
}

/**
 * Quebra o comando em segmentos (`;`, `&&`, `||`, `|`, quebras de linha) e
 * devolve o primeiro que integra código — um `cd … && git push` não passa
 * batido. `--dry-run` no segmento não bloqueia.
 *
 * F-778: se o cwd aponta para um repo cuja branch atual é main/master, qualquer
 * `git merge` para dentro dela é detectado como integração real (destino implícito).
 */
export async function integrationCommandHit(
  command: string,
  cwdOrOptions?: string | { cwd?: string; git?: AsyncGitRunner },
  gitArg?: AsyncGitRunner,
): Promise<boolean> {
  let cwd: string | undefined;
  let runner: AsyncGitRunner | undefined = gitArg;
  if (typeof cwdOrOptions === 'string') {
    cwd = cwdOrOptions;
  } else if (cwdOrOptions && typeof cwdOrOptions === 'object') {
    cwd = cwdOrOptions.cwd;
    if (cwdOrOptions.git) runner = cwdOrOptions.git;
  }
  const gitRunner = (): AsyncGitRunner => (runner ??= defaultGitRunner());

  // ponytail: branch atual inferida do cwd (main/master) fecha o falso negativo.
  // Este hook roda em TODO Bash de pane de missão: só pergunta a branch (ao
  // git, assíncrono) quando o segmento é de fato um `git merge`, e uma vez só.
  let onProtected: boolean | undefined;
  const protectedCwd = async (): Promise<boolean> => {
    onProtected ??= cwd
      ? isProtectedBranch(await currentBranchName(gitRunner(), cwd))
      : false;
    return onProtected;
  };

  for (const segment of command.split(/&&|\|\||[;\n|]/u)) {
    if (segment.includes('--dry-run')) continue;
    if (isMergeControlSegment(segment)) continue;
    if (INTEGRATION_SEGMENT.test(segment)) return true;
    if (GIT_MERGE_COMMAND.test(segment) && (await protectedCwd())) return true;
  }
  return false;
}

/**
 * F-778: Isenta EXCLUSIVAMENTE a sincronização comprovada pelo Git:
 * 1) O alvo é um ref remote-tracking que é o upstream da branch atual;
 * 2) O comando é --ff-only, sem composição ambígua ou comandos de push/pr;
 * 3) O git prova que HEAD é ancestral do alvo (zero commits locais exclusivos).
 *
 * Sem prova cabal, retorna false e o portão deliberado se aplica normalmente.
 *
 * F-815: as checagens de sintaxe vêm primeiro e não custam processo; só um
 * `git merge --ff-only <ref>` bem formado chega ao git, que é assíncrono.
 *
 * Limite conhecido (heurística, não prova): o "upstream" é um ref
 * remote-tracking (`refs/remotes/<remoto>/<branch>`) e esse ref pode ser
 * gravado localmente (`git update-ref refs/remotes/origin/main <sha>`) sem
 * nenhum fetch. Quem forjar o ref faz um fast-forward LOCAL do main para um
 * commit sem veredito. Isso não fura o F-234: o veredito é por HEAD exato e o
 * push (este hook, `nexus_git_push` e o push do `set_status`) continua exigindo
 * `approve` de modelo de ponta para o HEAD resultante.
 */
export async function isExemptFastForwardSync(
  command: string,
  cwd: string,
  git: AsyncGitRunner = defaultGitRunner(),
): Promise<boolean> {
  // 1. Sem composição ambígua nem mistura com push/pr ou comandos de navegação
  if (/\b(?:push|pr)\b/u.test(command)) return false;
  if (/\bcd\b/u.test(command)) return false;
  if (/\b(?:checkout|switch|reset|rebase)\b/u.test(command)) return false;

  const segments = command
    .split(/&&|\|\||[;\n|]/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const mergeSegments = segments.filter((s) => GIT_MERGE_COMMAND.test(s));
  if (mergeSegments.length !== 1) return false;
  if (segments.some((s) => !GIT_MERGE_COMMAND.test(s) && /\bgit\b/u.test(s))) {
    return false;
  }

  const mergeSegment = mergeSegments[0];
  const match = GIT_MERGE_REST.exec(mergeSegment);
  if (!match) return false;

  const tokens = tokenizeArgs(match[1] ?? '');
  if (!tokens.includes('--ff-only')) return false;

  const forbiddenOptions = new Set([
    '--no-ff',
    '--ff',
    '--squash',
    '-s',
    '--strategy',
    '-X',
    '--strategy-option',
    '--no-commit',
    '--commit',
    '--allow-unrelated-histories',
    '--no-edit',
    '--edit',
    '-m',
    '--message',
  ]);
  if (tokens.some((t) => forbiddenOptions.has(t))) return false;

  const targets = tokens.filter((t) => !t.startsWith('-'));
  if (targets.length !== 1) return false;
  const targetRefInput = targets[0];

  try {
    await assertSafeLocalGitConfigAsync(git, cwd);

    // 2. Branch atual deve ser main/master
    const branchResult = await git.run(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], {
      allowFailure: true,
    });
    if (branchResult.status !== 0) return false;
    const currentBranch = branchResult.stdout.trim();
    if (!isProtectedBranch(currentBranch)) return false;

    // 3. Upstream da branch atual configurado
    const upstreamResult = await git.run(
      cwd,
      ['rev-parse', '--symbolic-full-name', `${currentBranch}@{upstream}`],
      { allowFailure: true },
    );
    if (upstreamResult.status !== 0) return false;
    const upstreamFullName = upstreamResult.stdout.trim();
    if (!upstreamFullName.startsWith('refs/remotes/')) return false;

    // 4. Alvo deve ser exatamente o ref remote-tracking upstream
    const targetResult = await git.run(
      cwd,
      ['rev-parse', '--symbolic-full-name', targetRefInput],
      { allowFailure: true },
    );
    if (targetResult.status !== 0) return false;
    const targetFullName = targetResult.stdout.trim();
    if (targetFullName !== upstreamFullName) return false;

    // 5. Resolução e revalidação dos SHAs
    const targetShaResult = await git.run(
      cwd,
      ['rev-parse', '--verify', `${targetFullName}^{commit}`],
      { allowFailure: true },
    );
    if (targetShaResult.status !== 0) return false;
    const targetSha = targetShaResult.stdout.trim().toLowerCase();
    if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/u.test(targetSha)) return false;

    const headShaResult = await git.run(
      cwd,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      { allowFailure: true },
    );
    if (headShaResult.status !== 0) return false;
    const headSha = headShaResult.stdout.trim().toLowerCase();
    if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/u.test(headSha)) return false;

    // Revalidação do SHA do upstream
    const upstreamShaResult = await git.run(
      cwd,
      ['rev-parse', '--verify', `${upstreamFullName}^{commit}`],
      { allowFailure: true },
    );
    if (upstreamShaResult.status !== 0) return false;
    if (upstreamShaResult.stdout.trim().toLowerCase() !== targetSha) return false;

    // 6. Prova git de que HEAD é ancestral do alvo (merge-base)
    const ancestorResult = await git.run(
      cwd,
      ['merge-base', '--is-ancestor', 'HEAD', targetSha],
      { allowFailure: true },
    );
    if (ancestorResult.status !== 0) return false;

    // 7. Zero commits locais exclusivos
    const countResult = await git.run(
      cwd,
      ['rev-list', `${targetSha}..HEAD`, '--count'],
      { allowFailure: true },
    );
    if (countResult.status !== 0) return false;
    const exclusiveCount = parseInt(countResult.stdout.trim(), 10);
    if (isNaN(exclusiveCount) || exclusiveCount !== 0) return false;

    return true;
  } catch {
    return false;
  }
}

function parseBashPreToolUse(
  body: unknown,
): { command: string; cwd?: string } | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const toolInput = record.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return null;
  const rawCommand = (toolInput as Record<string, unknown>).command;
  if (typeof rawCommand !== 'string' || rawCommand.trim() === '') return null;
  const rawCwd = record.cwd;
  return {
    command: rawCommand,
    ...(typeof rawCwd === 'string' && rawCwd.trim() !== ''
      ? { cwd: rawCwd }
      : {}),
  };
}

type HookContext = Pick<AgentGateContext, 'sessionId' | 'missionId'> &
  Partial<Pick<AgentGateContext, 'scope' | 'executionScope'>>;

export async function handleHookIntegrationRequest(
  ctx: HookContext,
  body: unknown,
  deps: {
    readonly signal?: AbortSignal;
    readonly git?: AsyncGitRunner;
    readonly storesFor?: (
      ctx: HookContext,
    ) => Pick<
      ReturnType<typeof getProjectDomainStores>,
      'missions'
    >;
  } = {},
): Promise<{ statusCode: 200; payload: Record<string, unknown> }> {
  let integrates = false;
  try {
    const call = parseBashPreToolUse(body);
    if (!call) return { statusCode: 200, payload: {} };
    if (!ctx.missionId || !ctx.scope) return { statusCode: 200, payload: {} };

    // Orçamento de tempo por requisição (F-815): ver `boundedHookGitRunner`.
    const runner = boundedHookGitRunner(deps.git ?? defaultGitRunner());

    // Comando que não integra não paga git. `git status`, `merge-base` e
    // `git merge --abort` (dentro ou fora) continuam {}.
    if (!commandRequestsIntegration(call.command)) {
      return { statusCode: 200, payload: {} };
    }
    integrates = true;

    // F-1423: mede o checkout onde o merge/push roda (`cd` ou `git -C`), não
    // o cwd do pane. Dentro da raiz, o git dessa pasta já devolve o HEAD da
    // worktree. Fora, só worktree registrada deste repositório; o resto bloqueia
    // (não fail-open) em vez de carimbar o veredito do pane.
    const execution = executionScopeFor({
      scope: ctx.scope,
      executionScope: ctx.executionScope,
    });
    const root = execution.rootRealPath;
    const base = call.cwd === undefined
      ? root
      : path.isAbsolute(call.cwd)
        ? path.resolve(call.cwd)
        : path.resolve(root, call.cwd);
    const checkout = await locateMergeCheckout(
      execution,
      integrationCommandDirectory(call.command, base),
      runner,
    );
    if (!checkout) {
      return {
        statusCode: 200,
        payload: {
          decision: 'block',
          reason:
            'review_required: cwd fora do checkout da missão — integração ' +
            'só roda dentro do checkout de execução',
        },
      };
    }

    const hit = await integrationCommandHit(call.command, { cwd: checkout, git: runner });
    if (!hit) {
      return { statusCode: 200, payload: {} };
    }

    // F-778: isenta sincronização fast-forward comprovada pelo git
    if (await isExemptFastForwardSync(call.command, checkout, runner)) {
      trace({
        kind: 'integration-review-gate',
        missionId: ctx.missionId,
        decision: 'allow',
        reason: 'fast-forward sync com upstream isento de revisão',
      });
      return { statusCode: 200, payload: {} };
    }

    const suite = (deps.storesFor ?? ((c: HookContext) => {
      if (!c.scope) throw new Error('missing scope');
      return getProjectDomainStores(c.scope);
    }))(ctx);
    await assertIntegrationReviewedAsync(
      suite,
      ctx.missionId,
      checkout,
      deps.signal,
      runner,
    );
    return { statusCode: 200, payload: {} };
  } catch (error) {
    if (isIntegrationReviewRequiredError(error)) {
      return {
        statusCode: 200,
        payload: {
          decision: 'block',
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
    // O comando já é integração. Medir o checkout e falhar não pode abrir o
    // push. Fail-open fica só para store/infra antes desse reconhecimento.
    if (integrates) {
      return {
        statusCode: 200,
        payload: {
          decision: 'block',
          reason: `${INTEGRATION_REVIEW_REQUIRED}: não consegui medir o checkout do merge/push`,
        },
      };
    }
    console.warn(
      '[integration-gate] hook falhou aberto:',
      error instanceof Error ? error.message : error,
    );
    return { statusCode: 200, payload: {} };
  }
}

/** Full HTTP path for POST /hook/integration (mesmo contrato do /hook/triage). */
export async function handleHookIntegrationHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AgentGateContext | null,
): Promise<void> {
  await handleHookJsonPost(
    req,
    res,
    ctx,
    HOOK_INTEGRATION_MAX_BODY_BYTES,
    (body) => handleHookIntegrationRequest(ctx!, body),
  );
}
