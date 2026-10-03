// POST /hook/integration — portão de integração no hook PreToolUse/Bash do
// Claude (F-234). O `nexus_git_push` e o push do `nexus_mission_set_status`
// já passam pelo portão no Main; este endpoint cobre o `git push` /
// `gh pr create|merge` / `git merge … main` digitado NO BASH do pane de
// missão, que escapava de qualquer revisão.
//
// Decisão deliberada do portão (`review_required: …`) vira
// `{"decision":"block","reason":…}` — o agente continua com a instrução.
// Fora do caminho (sem missão, comando não integrador, --dry-run) e em falha
// de infraestrutura (store/git indisponível) responde `{}`: o hook nunca
// atrapalha o CLI — o portão autoritativo continua no Main.
import path from 'node:path';
import type http from 'node:http';
import type { AgentGateContext } from './gate';
import { executionScopeFor } from './gate';
import { handleHookJsonPost } from './hook-http';
import { isInsidePath } from './workspace-path';
import {
  assertIntegrationReviewedAsync,
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
 * 10 s (`INTEGRATION_HOOK_TRANSPORT_SECONDS`); estourar o orçamento é falha de
 * infraestrutura e o hook responde `{}` (nunca atrapalha o CLI).
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
const GIT_MERGE_COMMAND = /^\s*git\s+merge(?=\s|$)/u;
const INTEGRATION_SEGMENT = /^\s*(git\s+push\b|gh\s+pr\s+(?:create|merge)\b|git\s+merge(?=\s)[^;&|]*\b(?:main|master)\b)/u;

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
  const match = /^\s*git\s+merge(?=\s|$)(.*)$/u.exec(segment);
  if (!match) return false;
  const args = tokenizeArgs(match[1]).filter(
    (token) => !SHELL_REDIRECTION_TOKEN.test(token),
  );
  return args.length === 1 && MERGE_CONTROL_FLAGS.has(args[0]);
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
  const match = mergeSegment.match(/^\s*git\s+merge(?=\s|$)(.*)$/u);
  if (!match) return false;

  const tokens = tokenizeArgs(match[1]);
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
  try {
    const call = parseBashPreToolUse(body);
    if (!call) return { statusCode: 200, payload: {} };
    if (!ctx.missionId || !ctx.scope) return { statusCode: 200, payload: {} };

    // Orçamento de tempo por requisição (F-815): ver `boundedHookGitRunner`.
    const runner = boundedHookGitRunner(deps.git ?? defaultGitRunner());

    // O comando roda DENTRO do checkout de execução da missão; um cwd fora
    // dele tentando integrar é bloqueio deliberado, não fail-open.
    const root = executionScopeFor({
      scope: ctx.scope,
      executionScope: ctx.executionScope,
    }).rootRealPath;
    let cwd = root;
    let cwdInside = true;
    if (call.cwd !== undefined) {
      const resolved = path.isAbsolute(call.cwd)
        ? path.resolve(call.cwd)
        : path.resolve(root, call.cwd);
      if (!isInsidePath(root, resolved)) {
        cwdInside = false;
      }
      cwd = resolved;
    }

    const hit = await integrationCommandHit(
      call.command,
      cwdInside ? { cwd, git: runner } : undefined,
      runner,
    );
    if (!hit) {
      return { statusCode: 200, payload: {} };
    }

    if (!cwdInside) {
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

    // F-778: isenta sincronização fast-forward comprovada pelo git
    if (await isExemptFastForwardSync(call.command, cwd, runner)) {
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
      cwd,
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
