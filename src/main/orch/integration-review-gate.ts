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
  ProcessGitRunner,
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

function assertLive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('session_authority_revoked');
}

function headSha(git: GitRunner, cwd: string): string {
  const result = git.run(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const sha = result.stdout.trim().toLowerCase();
  if (result.status !== 0 || !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/u.test(sha)) {
    throw new Error(
      `${INTEGRATION_REVIEW_REQUIRED}: checkout sem commit válido — ` +
        'resolva o HEAD e peça o veredito de modelo de ponta',
    );
  }
  return sha;
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
  return { headSha: headSha(git, cwd), treeDirty: treeIsDirty(git, cwd) };
}

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

function mergeInProgress(git: GitRunner, cwd: string): boolean {
  return git.run(cwd, MERGE_HEAD_ARGS, { allowFailure: true }).status === 0;
}

function treeIsDirty(git: GitRunner, cwd: string): boolean {
  const result = git.run(cwd, [
    'status',
    '--porcelain=v1',
    '--untracked-files=no',
  ]);
  if (result.status !== 0) {
    throw new Error(
      `${INTEGRATION_REVIEW_REQUIRED}: não consegui ler o estado da árvore ` +
        `(${result.stderr.trim() || 'git status falhou'})`,
    );
  }
  return result.stdout.trim().length > 0;
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
  const block = (reason: string): never => {
    trace({
      kind: 'integration-review-gate',
      missionId,
      decision: 'block',
      reason,
    });
    throw new Error(`${INTEGRATION_REVIEW_REQUIRED}: ${reason}`);
  };
  assertLive(signal);
  const { headSha: sha, treeDirty } = measureIntegrationState(cwd, git);
  assertLive(signal);
  if (treeDirty) {
    block(
      mergeInProgress(git, cwd)
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
    block(
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
