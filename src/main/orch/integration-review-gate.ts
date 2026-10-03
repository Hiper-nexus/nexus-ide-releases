// F-234 — portão de integração: push/integração de missão só roda depois de
// um veredito `approve` de modelo de ponta registrado contra o HEAD EXATO do
// checkout de execução, com a árvore limpa. A doutrina ("código só integra/push
// após veredito de modelo de ponta") hoje não tinha enforcement: nexus_git_push,
// o push do set_status e um `git push` cru no Bash do Maestro passavam direto.
//
// Este módulo é o ponto único da decisão. Os três caminhos (tool nexus_git_push,
// push do nexus_mission_set_status e o hook PreToolUse/Bash do Claude/Codex em
// /hook/integration) chamam `assertIntegrationReviewed`.
import {
  assertSafeLocalGitConfig,
  assertSafeLocalGitConfigAsync,
  AsyncProcessGitRunner,
  ProcessGitRunner,
  type AsyncGitRunner,
  type GitResult,
  type GitRunner,
} from '../runtime/git-command';
import { trace } from '../observability/main-trace';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';

/** Prefixo das recusas deliberadas do portão (o resto é falha de infra). */
export const INTEGRATION_REVIEW_REQUIRED = 'review_required';

export function isIntegrationReviewRequiredError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.startsWith(INTEGRATION_REVIEW_REQUIRED)
  );
}

const gitRunner = new ProcessGitRunner();
// Criado sob demanda: testes que trocam `git-command` por um mock só do runner
// síncrono continuam importando este módulo sem o runner assíncrono.
let sharedAsyncGitRunner: AsyncGitRunner | undefined;
function defaultAsyncGitRunner(): AsyncGitRunner {
  return (sharedAsyncGitRunner ??= new AsyncProcessGitRunner());
}

function assertLive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('session_authority_revoked');
}

// Os três comandos do portão, uma vez só: o caminho síncrono (tools) e o
// assíncrono (hook /hook/integration, F-815) rodam exatamente os mesmos argv.
const HEAD_ARGS = ['rev-parse', '--verify', 'HEAD^{commit}'] as const;
const STATUS_ARGS = ['status', '--porcelain=v1', '--untracked-files=no'] as const;
/**
 * F-814: um merge que parou em conflito deixa a árvore "suja" com marcadores
 * de conflito. A mensagem genérica ("commite e peça o veredito") levava o
 * agente a commitar os marcadores; com `MERGE_HEAD` presente a saída certa é
 * resolver ou abortar. `MERGE_HEAD` é pseudo-ref por worktree (`rev-parse`
 * resolve o gitdir certo em checkout vinculado); sai 1, calado, quando não há.
 */
const MERGE_HEAD_ARGS = ['rev-parse', '-q', '--verify', 'MERGE_HEAD'] as const;

export const MERGE_IN_PROGRESS_REASON =
  'merge em andamento — resolva os conflitos e conclua com `git merge --continue`, ' +
  'ou desfaça com `git merge --abort`; só depois peça o veredito do HEAD';

function parseHeadSha(result: GitResult): string {
  const sha = result.stdout.trim().toLowerCase();
  if (result.status !== 0 || !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/u.test(sha)) {
    throw new Error(
      `${INTEGRATION_REVIEW_REQUIRED}: checkout sem commit válido — ` +
        'resolva o HEAD e peça o veredito de modelo de ponta',
    );
  }
  return sha;
}

function parseTreeDirty(result: GitResult): boolean {
  if (result.status !== 0) {
    throw new Error(
      `${INTEGRATION_REVIEW_REQUIRED}: não consegui ler o estado da árvore ` +
        `(${result.stderr.trim() || 'git status falhou'})`,
    );
  }
  return result.stdout.trim().length > 0;
}

/**
 * HEAD exato + sujeira da árvore do checkout — a mesma medida que a tool
 * `nexus_review_verdict` carimba no veredito e que o portão verifica.
 */
export function measureIntegrationState(
  cwd: string,
  git: GitRunner = gitRunner,
): { headSha: string; treeDirty: boolean } {
  assertSafeLocalGitConfig(git, cwd);
  const sha = parseHeadSha(git.run(cwd, HEAD_ARGS));
  return { headSha: sha, treeDirty: parseTreeDirty(git.run(cwd, STATUS_ARGS)) };
}

/** Versão assíncrona de `measureIntegrationState` (F-815): não bloqueia o Main. */
export async function measureIntegrationStateAsync(
  cwd: string,
  git: AsyncGitRunner = defaultAsyncGitRunner(),
): Promise<{ headSha: string; treeDirty: boolean }> {
  await assertSafeLocalGitConfigAsync(git, cwd);
  const sha = parseHeadSha(await git.run(cwd, HEAD_ARGS));
  return {
    headSha: sha,
    treeDirty: parseTreeDirty(await git.run(cwd, STATUS_ARGS)),
  };
}

function blockIntegration(missionId: string, reason: string): never {
  trace({
    kind: 'integration-review-gate',
    missionId,
    decision: 'block',
    reason,
  });
  throw new Error(`${INTEGRATION_REVIEW_REQUIRED}: ${reason}`);
}

/** Decisão pura sobre o estado já medido; sem I/O de processo. */
function enforceIntegrationReview(
  suite: Pick<ProjectDomainStoreSuite, 'missions'>,
  missionId: string,
  state: { headSha: string; treeDirty: boolean; mergeInProgress: boolean },
): void {
  const sha = state.headSha;
  if (state.treeDirty) {
    blockIntegration(
      missionId,
      state.mergeInProgress
        ? MERGE_IN_PROGRESS_REASON
        : 'árvore suja — commite e peça o veredito do HEAD',
    );
  }
  const verdict = suite.missions.reviewVerdicts.latestFor(missionId, sha);
  if (
    !verdict ||
    verdict.verdict !== 'approve' ||
    verdict.frontier !== true
  ) {
    blockIntegration(
      missionId,
      `push/integração exige veredito "approve" de modelo de ponta para o ` +
        `HEAD ${sha.slice(0, 7)} — peça revisão (nexus_route_task "revisão do ` +
        `diff …" + nexus_pane_spawn) e registre com nexus_review_verdict; o ` +
        'Maestro de ponta pode julgar e registrar ele mesmo',
    );
  }
  trace({
    kind: 'integration-review-gate',
    missionId,
    decision: 'allow',
    reason: `head ${sha.slice(0, 7)} aprovado por modelo de ponta`,
  });
}

/**
 * Lança `review_required: …` quando o push/integração NÃO pode rodar:
 * árvore suja, HEAD sem veredito, veredito `reject`, ou juiz fora da lane de
 * ponta. `suite` é a store da missão (escopo de coordenação); `cwd` é o
 * checkout de execução onde o HEAD/árvore são medidos.
 */
export function assertIntegrationReviewed(
  suite: Pick<ProjectDomainStoreSuite, 'missions'>,
  missionId: string,
  cwd: string,
  signal?: AbortSignal,
  git: GitRunner = gitRunner,
): void {
  assertLive(signal);
  const { headSha: sha, treeDirty } = measureIntegrationState(cwd, git);
  assertLive(signal);
  // Só pergunta pelo MERGE_HEAD no caminho de recusa (árvore suja).
  const mergeInProgress =
    treeDirty &&
    git.run(cwd, MERGE_HEAD_ARGS, { allowFailure: true }).status === 0;
  enforceIntegrationReview(suite, missionId, {
    headSha: sha,
    treeDirty,
    mergeInProgress,
  });
}

/**
 * Mesma decisão de `assertIntegrationReviewed`, com git assíncrono (F-815). O
 * hook `/hook/integration` roda a cada comando de todo pane de missão dentro
 * do Main: nenhum processo síncrono no caminho.
 */
export async function assertIntegrationReviewedAsync(
  suite: Pick<ProjectDomainStoreSuite, 'missions'>,
  missionId: string,
  cwd: string,
  signal?: AbortSignal,
  git: AsyncGitRunner = defaultAsyncGitRunner(),
): Promise<void> {
  assertLive(signal);
  const { headSha: sha, treeDirty } = await measureIntegrationStateAsync(cwd, git);
  assertLive(signal);
  const mergeInProgress =
    treeDirty &&
    (await git.run(cwd, MERGE_HEAD_ARGS, { allowFailure: true })).status === 0;
  assertLive(signal);
  enforceIntegrationReview(suite, missionId, {
    headSha: sha,
    treeDirty,
    mergeInProgress,
  });
}
