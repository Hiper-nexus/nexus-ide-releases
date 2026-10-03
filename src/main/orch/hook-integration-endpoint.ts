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
  assertIntegrationReviewed,
  isIntegrationReviewRequiredError,
} from './integration-review-gate';
import { getProjectDomainStores } from './project-domain-store-registry';
import {
  assertSafeLocalGitConfig,
  ProcessGitRunner,
  type GitRunner,
} from '../runtime/git-command';
import { trace } from '../observability/main-trace';

/** Mesmo teto do /hook/triage — payloads de hook são metadados de evento. */
export const HOOK_INTEGRATION_MAX_BODY_BYTES = 64 * 1024;

const defaultGitRunner = new ProcessGitRunner();

const INTEGRATION_SEGMENT = /^\s*(git\s+push\b|gh\s+pr\s+(?:create|merge)\b|git\s+merge\b[^;&|]*\b(?:main|master)\b)/u;

function currentBranchName(git: GitRunner, cwd: string): string | null {
  try {
    const result = git.run(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], {
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
export function integrationCommandHit(
  command: string,
  cwdOrOptions?: string | { cwd?: string; git?: GitRunner },
  gitArg?: GitRunner,
): boolean {
  let cwd: string | undefined;
  let runner: GitRunner = gitArg ?? defaultGitRunner;
  if (typeof cwdOrOptions === 'string') {
    cwd = cwdOrOptions;
  } else if (cwdOrOptions && typeof cwdOrOptions === 'object') {
    cwd = cwdOrOptions.cwd;
    if (cwdOrOptions.git) runner = cwdOrOptions.git;
  }

  // ponytail: branch atual inferida do cwd (main/master) fecha o falso negativo.
  // O git é spawnSync no Main e este hook roda em TODO Bash de pane de missão:
  // só pergunta a branch quando o segmento é de fato um `git merge`.
  let onProtected: boolean | undefined;
  const protectedCwd = (): boolean => {
    onProtected ??= cwd ? isProtectedBranch(currentBranchName(runner, cwd)) : false;
    return onProtected;
  };

  for (const segment of command.split(/&&|\|\||[;\n|]/u)) {
    if (segment.includes('--dry-run')) continue;
    if (INTEGRATION_SEGMENT.test(segment)) return true;
    if (/^\s*git\s+merge\b/u.test(segment) && protectedCwd()) return true;
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
 */
export function isExemptFastForwardSync(
  command: string,
  cwd: string,
  git: GitRunner = defaultGitRunner,
): boolean {
  // 1. Sem composição ambígua nem mistura com push/pr ou comandos de navegação
  if (/\b(?:push|pr)\b/u.test(command)) return false;
  if (/\bcd\b/u.test(command)) return false;
  if (/\b(?:checkout|switch|reset|rebase)\b/u.test(command)) return false;

  const segments = command
    .split(/&&|\|\||[;\n|]/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const mergeSegments = segments.filter((s) => /^\s*git\s+merge\b/u.test(s));
  if (mergeSegments.length !== 1) return false;
  if (segments.some((s) => !/^\s*git\s+merge\b/u.test(s) && /\bgit\b/u.test(s))) {
    return false;
  }

  const mergeSegment = mergeSegments[0];
  const match = mergeSegment.match(/^\s*git\s+merge\b(.*)$/u);
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
    assertSafeLocalGitConfig(git, cwd);

    // 2. Branch atual deve ser main/master
    const branchResult = git.run(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], {
      allowFailure: true,
    });
    if (branchResult.status !== 0) return false;
    const currentBranch = branchResult.stdout.trim();
    if (!isProtectedBranch(currentBranch)) return false;

    // 3. Upstream da branch atual configurado
    const upstreamResult = git.run(
      cwd,
      ['rev-parse', '--symbolic-full-name', `${currentBranch}@{upstream}`],
      { allowFailure: true },
    );
    if (upstreamResult.status !== 0) return false;
    const upstreamFullName = upstreamResult.stdout.trim();
    if (!upstreamFullName.startsWith('refs/remotes/')) return false;

    // 4. Alvo deve ser exatamente o ref remote-tracking upstream
    const targetResult = git.run(
      cwd,
      ['rev-parse', '--symbolic-full-name', targetRefInput],
      { allowFailure: true },
    );
    if (targetResult.status !== 0) return false;
    const targetFullName = targetResult.stdout.trim();
    if (targetFullName !== upstreamFullName) return false;

    // 5. Resolução e revalidação dos SHAs
    const targetShaResult = git.run(
      cwd,
      ['rev-parse', '--verify', `${targetFullName}^{commit}`],
      { allowFailure: true },
    );
    if (targetShaResult.status !== 0) return false;
    const targetSha = targetShaResult.stdout.trim().toLowerCase();
    if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/u.test(targetSha)) return false;

    const headShaResult = git.run(
      cwd,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      { allowFailure: true },
    );
    if (headShaResult.status !== 0) return false;
    const headSha = headShaResult.stdout.trim().toLowerCase();
    if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/u.test(headSha)) return false;

    // Revalidação do SHA do upstream
    const upstreamShaResult = git.run(
      cwd,
      ['rev-parse', '--verify', `${upstreamFullName}^{commit}`],
      { allowFailure: true },
    );
    if (upstreamShaResult.status !== 0) return false;
    if (upstreamShaResult.stdout.trim().toLowerCase() !== targetSha) return false;

    // 6. Prova git de que HEAD é ancestral do alvo (merge-base)
    const ancestorResult = git.run(
      cwd,
      ['merge-base', '--is-ancestor', 'HEAD', targetSha],
      { allowFailure: true },
    );
    if (ancestorResult.status !== 0) return false;

    // 7. Zero commits locais exclusivos
    const countResult = git.run(
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
    readonly git?: GitRunner;
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

    const runner = deps.git ?? defaultGitRunner;

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

    const hit = integrationCommandHit(
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
    if (isExemptFastForwardSync(call.command, cwd, runner)) {
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
    assertIntegrationReviewed(suite, ctx.missionId, cwd, deps.signal, runner);
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
