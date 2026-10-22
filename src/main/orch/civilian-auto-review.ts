import { getProjectDomainStores } from './project-domain-store-registry';
import { missionExecutionScope, missionExecutionBaseSha } from './mission-execution-scope';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Mission } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import type { PeriodicTaskContext } from '../observability/periodic-task';
import {
  AsyncProcessGitRunner,
  type AsyncGitRunner,
} from '../runtime/git-command';
import {
  runCandidateQualityAnalysis,
  type CandidateQualityAnalysis,
  type CandidateQualityDeclaredLimit,
} from '../context/candidate-quality-scanner';
import type { MechanicalCheckResult, MechanicalFinding } from '../context/mechanical-sensors';
import { ceremonyProfileNote, isNonExecutableDiffPath, missionCeremonyProfile } from '../../shared/mission-ceremony-profile';
import type { ReviewCategory, ReviewFindingInput } from '../context/review-council';
import type { McpToolInvocation } from './mcp-protocol';
import { deliverAgentPrompt } from './tool-util';
import { createCompletionCheckExecutors } from './completion-check-executors';
import {
  isRegressionGateEnabled,
  MIN_TEST_BUDGET_MS,
  runRegressionGate,
  type RegressionGateResult,
} from '../regression-gate/regression-gate';

/**
 * Revisão automática main-owned da Via Rápida civil (Etapa 1 do plano
 * dev-sênior, docs/PLANO-DEV-SENIOR.md).
 *
 * O operador leigo não valida código; a missão civil NÃO pode fechar "N/N"
 * sem nenhuma verificação independente. Este módulo executa o scanner
 * determinístico (candidate-quality-v1) sobre a entrega ANTES do
 * completeVerified e decide:
 *
 *   aprovado     → segue com nota de evidência anexada ao resultado;
 *   reprovado    → enquanto houver orçamento (2 ciclos), entrega os findings
 *                  ao Maestro vivo e aguarda em cooldown; esgotado ou sem
 *                  Maestro → bloqueio VISÍVEL com resumo simples (nunca
 *                  trava muda; o operador tem Retomar e "Marcar concluída");
 *   indisponível → sem git/scanner falhou → quem decide é o roster:
 *                  revisor do squad (caminho vivo) ou conclusão com nota
 *                  honesta — nunca beco sem saída.
 */

export const CIVILIAN_REPAIR_BUDGET_PER_MISSION = 2;
/** Após despachar reparo, espera o Maestro trabalhar antes de re-escanear. */
export const CIVILIAN_REPAIR_COOLDOWN_MS = 90_000;
/**
 * Strict completion runs EVERY impacted test, E2E included, on the whole
 * mission delta. The 120 s default of a worker handoff did not fit, and the
 * overrun came back as "restore the runner" repairs. Each attempt that runs
 * out of time gets the next budget; past the last, the refusal says timeout.
 */
export const COMPLETION_REGRESSION_BUDGETS_MS = [300_000, 600_000, 1_200_000] as const;

const BLOCKING_SEVERITIES = new Set(['critical', 'high']);
/** No commit claim: working-tree scanner binds these projects to its file snapshot. */
const NO_GIT_REVISION = '0'.repeat(40);

const REPAIR_PROMPT_HEADER =
  '[NEXUS_QUALITY_REPAIR] A revisão automática encontrou problemas no código entregue. Corrija os itens abaixo antes de concluir a missão. Não marque como concluída sem corrigir.';

export type CivilianAutoReviewOutcome =
  | {
      readonly kind: 'approved';
      readonly evidenceId: string;
      readonly note: string;
      /** Additive Main evidence for strict code completion; legacy callers keep their outcome. */
      readonly verification?: CivilianMechanicalVerification;
    }
  | { readonly kind: 'repair-dispatched' }
  | { readonly kind: 'blocked'; readonly description: string }
  | { readonly kind: 'defer-to-roster-review'; readonly reason?: string; readonly retryable?: boolean };

export interface CivilianMechanicalVerification {
  /** F-1430: real read/integrity failures; non-empty still blocks completion. */
  readonly analysisFailures: readonly string[];
  /** F-1430: declared limits (budget/count/ceiling/time), each naming files left out. */
  readonly declaredLimits: readonly CandidateQualityDeclaredLimit[];
  readonly headSha: string | null;
  /** null means current-state verification, not a claim about authorship. */
  readonly baseSha: string | null;
  readonly checks: readonly { readonly kind: MechanicalCheckResult['kind'];
    readonly status: MechanicalCheckResult['status'] | 'not-applicable'; readonly summary: string }[];
  readonly regression: RegressionGateResult | null;
  readonly regressionApplicable: boolean;
}

export interface CivilianAutoReviewInput {
  /** Explicit Main baseline for strict completion; null reviews current state. */
  readonly completionBaseSha?: string | null;
  /** F-1301: when that baseline was observed; untracked files untouched since then are not the delta. */
  readonly completionUntrackedSince?: number;
  /** Main mission/leader authority rechecked after resource waits. */
  readonly assertCurrentAuthority?: () => void;
  readonly mission: Mission;
  readonly scope: ProjectExecutionScope;
  /** Arquivos entregues pela missão (produto), já filtrados de lixo. */
  readonly productFiles: readonly string[];
  /**
   * Main-proved COMPLETE candidate (changed, deleted, unread and absent
   * paths). Only strict completion uses it, to drop checks the diff cannot
   * affect; absent means the full ceremony runs.
   */
  readonly candidatePaths?: readonly string[];
  /** Sessão do Maestro vivo da missão, se existir. */
  readonly liveOrchestratorSessionId?: string | null;
  /** Main-owned lifetime only; not a provider/renderer argument. */
  readonly lifetime?: PeriodicTaskContext;
}

export interface CivilianAutoReviewDependencies {
  readonly git?: AsyncGitRunner;
  readonly analyze?: typeof runCandidateQualityAnalysis;
  readonly typecheck?: (
    root: string,
  ) => Promise<MechanicalCheckResult>;
  readonly audit?: (root: string) => Promise<MechanicalCheckResult>;
  readonly freshness?: (root: string) => Promise<MechanicalCheckResult>;
  readonly testCoverage?: (
    root: string,
    files: readonly string[],
  ) => Promise<MechanicalCheckResult>;
  /** Portão de regressão (testes impactados pelo diff); null = desligado. */
  readonly regressionGate?:
    | ((input: {
        readonly scope: ProjectExecutionScope;
        readonly declaredFiles: readonly string[];
        readonly baseSha?: string;
        readonly includeE2E?: boolean;
        readonly timeoutMs?: number;
        readonly trustedDependencyRoot?: string;
        readonly authority?: McpToolInvocation;
        readonly signal?: AbortSignal;
      }) => Promise<RegressionGateResult>)
    | null;
  readonly deliverRepair?: (
    sessionId: string,
    prompt: string,
  ) => Promise<boolean>;
  readonly now?: () => number;
}

const repairBudgets = new Map<string, { used: number }>();
const repairCooldowns = new Map<string, number>();
/** Index into COMPLETION_REGRESSION_BUDGETS_MS; only grows for a mission. */
const regressionBudgetLevels = new Map<string, number>();

export function __resetCivilianAutoReviewForTests(): void {
  repairBudgets.clear();
  repairCooldowns.clear();
  regressionBudgetLevels.clear();
}

function completionRegressionBudgetMs(missionId: string): number {
  return COMPLETION_REGRESSION_BUDGETS_MS[regressionBudgetLevels.get(missionId) ?? 0]!;
}

/**
 * Unverified only for lack of time: no counted failure, every unrun test was
 * cut by a deadline, or the gate spent the import-map share of the budget
 * (the map stops `MIN_TEST_BUDGET_MS` before the end) without naming another
 * cause. A missing runner, config or sandbox is not a timeout.
 */
function regressionRanOutOfTime(regression: RegressionGateResult, budgetMs: number): boolean {
  if (regression.status !== 'unavailable' || regression.failures.length > 0) return false;
  const causes = regression.notRun?.causes ?? [];
  if (causes.some(cause => cause !== 'map-deadline' && cause !== 'test-deadline')) return false;
  return causes.length > 0 || regression.durationMs >= budgetMs - MIN_TEST_BUDGET_MS;
}

/** Next attempt gets the next budget; past the last, the refusal is final and still says timeout. */
function completionRegressionTimeout(missionId: string, budgetMs: number): CivilianAutoReviewOutcome {
  const level = regressionBudgetLevels.get(missionId) ?? 0;
  const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;
  const next = COMPLETION_REGRESSION_BUDGETS_MS[level + 1];
  if (next !== undefined) {
    regressionBudgetLevels.set(missionId, level + 1);
    return { kind: 'defer-to-roster-review', retryable: true,
      reason: `Os testes impactados não couberam no prazo de ${minutes(budgetMs)}. O Nexus tentará novamente com ${minutes(next)}; nenhum reparo de código foi solicitado.` };
  }
  return { kind: 'defer-to-roster-review',
    reason: `Os testes impactados não couberam no prazo de ${minutes(budgetMs)} da verificação de conclusão; a entrega não foi certificada e nenhum reparo de código foi solicitado. Rode a suíte lenta por conta própria, divida a entrega ou marque a missão como concluída.` };
}

function repairBudgetRemaining(missionId: string): boolean {
  const state = repairBudgets.get(missionId);
  return (state?.used ?? 0) < CIVILIAN_REPAIR_BUDGET_PER_MISSION;
}

function consumeRepairBudget(missionId: string): void {
  const state = repairBudgets.get(missionId) ?? { used: 0 };
  state.used += 1;
  repairBudgets.set(missionId, state);
}

function repairCooldownActive(
  missionId: string,
  now: () => number,
): boolean {
  const until = repairCooldowns.get(missionId);
  return until !== undefined && now() < until;
}

/**
 * Base do diff: último commit ANTES do nascimento da missão. Repo nascido
 * junto com a missão (greenfield) cai no commit raiz — tudo é candidato.
 */
export async function resolveAutoReviewBaseSha(
  git: AsyncGitRunner,
  root: string,
  createdAtMs: number,
): Promise<string | null> {
  const before = new Date(Math.max(0, createdAtMs - 1_000)).toISOString();
  try {
    const prior = await git.run(
      root,
      ['log', '--before=' + before, '-1', '--format=%H'],
      { timeoutMs: 5_000 },
    );
    const priorSha = prior.stdout.trim();
    if (/^[a-f0-9]{40}$/u.test(priorSha)) return priorSha;
    const rootCommit = await git.run(
      root,
      ['rev-list', '--max-parents=0', 'HEAD'],
      { timeoutMs: 5_000 },
    );
    const rootSha = rootCommit.stdout.trim().split('\n')[0] ?? '';
    if (/^[a-f0-9]{40}$/u.test(rootSha)) return rootSha;
    return null;
  } catch {
    return null;
  }
}

async function currentHeadSha(
  git: AsyncGitRunner,
  root: string,
): Promise<string | null> {
  try {
    const head = await git.run(root, ['rev-parse', '--verify', 'HEAD'], {
      timeoutMs: 5_000,
    });
    const sha = head.stdout.trim();
    return /^[a-f0-9]{40}$/u.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export function blockingFindingsOf(
  analysis: Pick<CandidateQualityAnalysis, 'findings'>,
): readonly ReviewFindingInput[] {
  return analysis.findings.filter((finding) =>
    BLOCKING_SEVERITIES.has(finding.severity),
  );
}

/** Resumo em PT simples para o operador — sem jargão, com caminho de arquivo. */
export function describeFindingsForOperator(
  findings: readonly ReviewFindingInput[],
): string {
  const critical = findings.filter((f) => f.severity === 'critical').length;
  const high = findings.length - critical;
  const parts: string[] = [];
  if (critical > 0) {
    parts.push(
      `${critical} problema${critical > 1 ? 's' : ''} grave${critical > 1 ? 's' : ''}`,
    );
  }
  if (high > 0) {
    parts.push(
      `${high} problema${high > 1 ? 's' : ''} importante${high > 1 ? 's' : ''}`,
    );
  }
  const headline = `A revisão automática encontrou ${parts.join(' e ')} no código entregue.`;
  const detail = findings
    .slice(0, 8)
    .map((finding) => {
      const label = finding.severity === 'critical' ? 'GRAVE' : 'IMPORTANTE';
      return `- [${label}] ${finding.file}${finding.line ? `:${finding.line}` : ''} — ${finding.evidence}`;
    })
    .join('\n');
  return `${headline}\n\n${detail}\n\nA missão foi pausada para não entregar código com risco. Use Retomar para pedir nova rodada ao time.`;
}

function repairPromptFor(findings: readonly ReviewFindingInput[]): string {
  const list = findings
    .slice(0, 16)
    .map(
      (finding) =>
        `- [${finding.severity.toUpperCase()}] ${finding.file}${finding.line ? `:${finding.line}` : ''} — ${finding.evidence} → ${finding.recommendation}`,
    )
    .join('\n');
  return `${REPAIR_PROMPT_HEADER}\n\n${list}`;
}

export function civilianAutoReviewEvidenceNote(
  analysis: CandidateQualityAnalysis,
): string {
  const shortHash = analysis.analysisHash.slice(0, 12);
  return analysis.complete
    ? `Scanner determinístico ${analysis.version}: aprovado (evidência ${shortHash}), nenhum finding crítico/alto em ${analysis.inspectedFiles} arquivo(s).`
    : `Scanner determinístico ${analysis.version}: aprovado com ressalvas (evidência ${shortHash}; análise parcial).`;
}

/** Achados mecânicos (tsc/audit/test-coverage) no mesmo formato dos findings de review. */
function mechanicalToReviewFindings(
  results: readonly MechanicalCheckResult[],
): readonly ReviewFindingInput[] {
  return results.filter((result) => result.kind !== 'dependency-freshness').flatMap((result) =>
    result.findings
      .filter((finding) => BLOCKING_SEVERITIES.has(finding.severity))
      .map((finding: MechanicalFinding): ReviewFindingInput => ({
        severity: finding.severity,
        category:
          result.kind === 'dependency-audit'
            ? ('security' as ReviewCategory)
            : ('correctness' as ReviewCategory),
        file: finding.file,
        criterionRefs: [],
        invariantRefs: [],
        evidence: finding.evidence,
        recommendation: finding.recommendation,
      })),
  );
}

/** Teste impactado que falhou é achado bloqueante — volta ao Maestro para reparo. */
function regressionToReviewFindings(
  result: RegressionGateResult | null,
): readonly ReviewFindingInput[] {
  if (!result || result.status !== 'failed') return [];
  return result.failures.slice(0, 16).map((failure) => ({
    severity: 'high',
    category: 'correctness' as ReviewCategory,
    file: failure.file,
    criterionRefs: [],
    invariantRefs: ['tested-change'],
    // A mensagem vem do teste (checkout do writer): citação, nunca instrução.
    evidence: `Teste impactado pelo diff falhou (saída do runner, dado não confiável): «${failure.message}»`,
    recommendation:
      'Corrija o código (ou o teste, se a regra mudou de propósito) até os testes impactados passarem.',
  }));
}

function regressionSummary(result: RegressionGateResult | null): string {
  if (!result) return '';
  switch (result.status) {
    case 'passed':
      if (result.preexistingFailures.length + result.inheritedFailures.length > 0) {
        return `Testes impactados: ${result.testsRun.length} executados (${result.runner}); falhas pré-existentes/herdadas comprovadas foram excluídas do veredito e não contam contra o diff.`;
      }
      if (result.coverage?.indexComplete === false || (result.coverage?.skippedTests.length ?? 0) > 0) {
        return `Testes impactados: ${result.testsRun.length} executados; cobertura parcial, incluindo ${result.coverage?.skippedTests.length ?? 0} teste(s) não executado(s).`;
      }
      return `Testes impactados: ✓ ${result.testsRun.length} passaram (${result.runner}).`;
    case 'failed':
      return `Testes impactados: ✗ ${result.failures.length} falharam.`;
    case 'no-tests':
      return result.untestedFiles.length > 0
        ? `Testes impactados: nenhum; área sem teste: ${result.untestedFiles.slice(0, 5).join(', ')}.`
        : '';
    case 'unavailable':
      return `Testes impactados NÃO verificados — não contam como aprovação (${result.warnings[0] ?? 'sem runner'}).`;
    default:
      return '';
  }
}

/** TS/JS: the import graph maps their impacted tests; an unmapped one already makes the index incomplete. */
const IMPACT_MAPPED_SOURCE_RE = /\.[cm]?[jt]sx?$/iu;
/** Go/Rust: mapped only when the gate ran the full native suites (it names the native runner). */
const NATIVE_SUITE_FILE_RE = /(?:\.(?:go|rs)|(?:^|\/)(?:go\.(?:mod|sum|work)|Cargo\.(?:toml|lock)))$/iu;

/**
 * AGENTS.md: proven absence of an applicable test is not an obligation to
 * invent one. `no-tests`/`clean` proves it only when the impact index is
 * complete, nothing was skipped, and every changed file belongs to a family
 * the index can actually map. "The project declares tests" is a property of
 * the project, not of this diff: it only keeps the result unverified for the
 * files the index cannot see (Python, JSON, other languages).
 */
function regressionProvesNoApplicableTests(
  regression: RegressionGateResult,
  declaredFiles: readonly string[],
  projectDeclaresTests: boolean,
): boolean {
  if (regression.status !== 'no-tests' && regression.status !== 'clean') return false;
  if (regression.coverage?.indexComplete !== true || regression.coverage.skippedTests.length > 0) return false;
  if (!projectDeclaresTests) return true;
  const nativeSuitesRan = regression.runner === 'go' || regression.runner === 'cargo';
  return [...regression.changedFiles, ...declaredFiles].every(file => IMPACT_MAPPED_SOURCE_RE.test(file) ||
    isNonExecutableDiffPath(file) || nativeSuitesRan && NATIVE_SUITE_FILE_RE.test(file));
}

function sensorSummaries(
  results: readonly MechanicalCheckResult[],
): string {
  return results
    .map((result) => result.summary)
    .filter(Boolean)
    .join('\n');
}

/**
 * Executa o gate de revisão automática civil. Git, scanner e entrega de
 * reparo são injetáveis — o caminho de produção usa os defaults main-owned.
 */
export async function enforceCivilianAutoReview(
  input: CivilianAutoReviewInput,
  dependencies: CivilianAutoReviewDependencies = {},
): Promise<CivilianAutoReviewOutcome> {
  const assertCurrent = () => { input.lifetime?.assertCurrent(); input.assertCurrentAuthority?.(); };
  const wait = <T>(promise: Promise<T>): Promise<T> => input.lifetime?.wait(promise) ?? promise;
  const launch = <T>(run: () => Promise<T>): Promise<T> => { assertCurrent(); return wait(run()); };
  assertCurrent();
  const now = dependencies.now ?? Date.now;
  if (repairCooldownActive(input.mission.id, now)) {
    // Reparo já despachado: dar tempo de trabalho ao Maestro.
    return { kind: 'repair-dispatched' };
  }

  const executionScope = missionExecutionScope(input.scope, input.mission);
  const root = executionScope.rootRealPath;
  const rawGit = dependencies.git ?? new AsyncProcessGitRunner();
  const git: AsyncGitRunner = input.lifetime
    ? { run: (cwd, args, options) => launch(() => rawGit.run(cwd, args, options)) }
    : rawGit;

  const observedHead = await launch(() => currentHeadSha(git, root));
  const headSha = observedHead ?? NO_GIT_REVISION;
  // HEAD não representa mudanças sem commit. Toda tentativa de concluir
  // precisa revalidar o código e os sensores sobre a entrega atual.

  const baseSha = observedHead
    ? input.completionBaseSha !== undefined ? input.completionBaseSha ?? observedHead
      : missionExecutionBaseSha(input.scope, input.mission) ?? await launch(() => resolveAutoReviewBaseSha(git, root, input.mission.createdAt)) ?? observedHead
    : NO_GIT_REVISION;

  const changedFiles = [...new Set(input.productFiles)].slice(0, 512);
  const diffHash = createHash('sha256')
    .update(changedFiles.join('\n'))
    .digest('hex');

  let analysis: CandidateQualityAnalysis;
  try {
    analysis = await launch(() => (dependencies.analyze ?? runCandidateQualityAnalysis)(
      {
        scope: executionScope,
        checkoutPath: root,
        baseSha,
        headSha,
        diffHash,
        changedFiles,
        candidateSource: 'working-tree',
        ...(input.completionBaseSha && input.completionUntrackedSince !== undefined ? { untrackedSince: input.completionUntrackedSince } : {}),
        ...(input.lifetime ? { signal: input.lifetime.signal } : {}),
      },
      dependencies.git ? { git: dependencies.git } : {},
    ));
  } catch (error) {
    assertCurrent();
    // F-144: este catch alimentava uma prova `unavailable` que o gate de revisão
    // aceita como conclusão, sem nenhuma linha de log. A política de concluir
    // quando o scanner não pôde rodar é deliberada e tem teste com nome próprio;
    // o que não pode é um bug no scanner, um sensor novo que lança e um timeout
    // transitório produzirem exatamente o mesmo desfecho silencioso que uma
    // indisponibilidade legítima. O motivo segue adiante para aparecer na nota
    // persistida da entrega, não só no log.
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      '[civilian-auto-review] scanner de qualidade falhou; adiando para revisão do roster:',
      reason,
    );
    return { kind: 'defer-to-roster-review', reason };
  }

  // Etapa 2 — sensores mecânicos Nexus-owned: typecheck + auditoria de
  // dependências + cobertura de testes quando o projeto permite. Não dependem
  // de scripts no alvo; falha de infraestrutura é indisponível, não bloqueio.
  const sensors = await import('../context/mechanical-sensors');
  const strictCompletion = input.completionBaseSha !== undefined;
  // Subtraction needs the COMPLETE candidate; only strict completion has one.
  const requirements = await wait(sensors.mechanicalProjectRequirements(root, changedFiles,
    strictCompletion ? input.candidatePaths : undefined));
  const ceremony = missionCeremonyProfile(input.mission.intentContract?.goal || input.mission.description || input.mission.title,
    requirements.diffClass);
  const ownedChecks = strictCompletion ? createCompletionCheckExecutors({ scope: input.scope, executionScope,
    missionId: input.mission.id, signal: input.lifetime?.signal, assertCurrent }) : null;
  const typecheck = ceremony.dropped.includes('typecheck')
    ? Promise.resolve<MechanicalCheckResult>({ kind: 'typecheck', status: 'unavailable', findings: [],
      summary: 'Typecheck dispensado: o diff só tem estilos, texto ou assets estáticos.' })
    : launch(() => dependencies.typecheck ? dependencies.typecheck(root) : ownedChecks ? ownedChecks.typecheck(root) : sensors.runTypecheckSensor(root, { signal: input.lifetime?.signal }));
  const audit = () => launch(() => (dependencies.audit ?? ownedChecks?.audit ?? sensors.runDependencyAuditSensor)(root));
  // One project permit: do not spend the shorter audit deadline waiting for
  // this same completion's compiler on every retry.
  const mechanical = await wait(Promise.all([
    typecheck,
    strictCompletion ? typecheck.then(audit) : audit(),
    launch(() => dependencies.freshness ? dependencies.freshness(root) : sensors.runDependencyFreshnessSensor(root, {
      signal: input.lifetime?.signal,
      assertCurrentAuthority: () => {
        assertCurrent();
        const live = getProjectDomainStores(input.scope).missions.get(input.mission.id);
        if (!live || live.status !== input.mission.status || live.intentVersion !== input.mission.intentVersion ||
          live.updatedAt !== input.mission.updatedAt || live.orchestratorSessionId !== input.mission.orchestratorSessionId ||
          missionExecutionScope(input.scope, live).rootRealPath !== root) {
          throw new Error('dependency advice mission authority changed');
        }
      },
    })),
    launch(() => (dependencies.testCoverage ?? sensors.runTestCoverageSensor)(root, changedFiles)),
  ]));
  const mechanicalBlocking = mechanicalToReviewFindings(mechanical);
  // A non-executable complete diff drops the tests with the typecheck: the gate
  // would spend the completion budget (or time out and defer) to run nothing.
  const testsDropped = ceremony.dropped.includes('tests');
  const regressionGate = testsDropped
    ? null
    : dependencies.regressionGate !== undefined
      ? dependencies.regressionGate
      : strictCompletion || isRegressionGateEnabled()
        ? runRegressionGate
        : null;
  let regression: RegressionGateResult | null = null;
  const regressionBudgetMs = strictCompletion ? completionRegressionBudgetMs(input.mission.id) : undefined;
  if (regressionGate && (observedHead || strictCompletion)) {
    try {
      regression = await launch(() => regressionGate({
        scope: executionScope,
        projectScope: input.scope,
        declaredFiles: changedFiles,
        ...(observedHead ? { baseSha } : {}),
        trustedDependencyRoot: input.scope.rootRealPath,
        authority: { signal: input.lifetime?.signal, assertCurrentAuthority: assertCurrent },
        ...(regressionBudgetMs !== undefined ? { includeE2E: true, timeoutMs: regressionBudgetMs } : {}),
        ...(input.lifetime ? { signal: input.lifetime.signal } : {}),
      }));
    } catch (error) {
      assertCurrent();
      console.warn('[civilian-auto-review] portão de regressão falhou (ignorado):', error);
    }
  }
  // Out of time is not a defect of the code: it never becomes the "restore the
  // runner" repair below. Real findings still go to repair first.
  const regressionOutOfTime = regressionBudgetMs !== undefined && regression !== null &&
    regressionRanOutOfTime(regression, regressionBudgetMs);
  // Missing execution or incomplete discovery is never evidence of N/A.
  const noApplicableTests = regression !== null && regressionProvesNoApplicableTests(regression, changedFiles, requirements.tests);
  if (strictCompletion && regression && (
    regression.coverage?.indexComplete === false || (regression.coverage?.skippedTests.length ?? 0) > 0 ||
    ['no-tests', 'clean'].includes(regression.status) && !noApplicableTests
  )) {
    regression = { ...regression, status: 'unavailable',
      testsNotRun: [...new Set([...regression.testsNotRun, ...(regression.coverage?.skippedTests ?? [])])],
      warnings: [...regression.warnings, 'cobertura de testes aplicáveis não comprovada integralmente'],
    };
  }
  if (strictCompletion && (mechanical.some(check => check.retryable) || regression?.retryable && !regressionOutOfTime)) {
    return { kind: 'defer-to-roster-review', retryable: true,
      reason: 'Verificações aguardando recursos ou encerramento de processos anteriores. O Nexus tentará novamente; nenhum reparo de código foi solicitado.' };
  }
  const requiredCheck = (kind: MechanicalCheckResult['kind']) => kind === 'typecheck' ? requirements.typecheck
    : kind === 'dependency-audit' ? requirements.audit
    : kind === 'dependency-freshness' ? existsSync(join(root, 'package.json')) && existsSync(join(root, 'package-lock.json')) : true;
  const prerequisites: ReviewFindingInput[] = strictCompletion && input.liveOrchestratorSessionId ? [
    ...mechanical.filter(check => check.status === 'unavailable' && requiredCheck(check.kind) && check.kind !== 'dependency-freshness')
      .map(check => ({ severity: 'high' as const, category: 'correctness' as const, file: 'package.json', criterionRefs: [], invariantRefs: ['required-check-executed'],
        evidence: `Verificação obrigatória não executada: ${check.summary}`,
        recommendation: 'Restaure o compilador/configuração ou lockfile declarado e execute novamente a verificação.' })),
    ...(regression?.status === 'unavailable' && !regressionOutOfTime ? [{ severity: 'high' as const, category: 'correctness' as const, file: regression.testsNotRun[0] ?? 'package.json',
      criterionRefs: [], invariantRefs: ['required-tests-executed'], evidence: 'Testes aplicáveis não foram verificados integralmente.',
      recommendation: 'Restaure runner, configuração e pré-requisitos dos testes impactados (inclusive E2E) e solicite nova verificação.' }] : []),
  ] : [];
  const blocking = [
    ...blockingFindingsOf(analysis),
    ...prerequisites,
    ...mechanicalBlocking,
    ...regressionToReviewFindings(regression),
  ];
  assertCurrent();
  if (blocking.length === 0 && regressionBudgetMs !== undefined && regressionOutOfTime) {
    return completionRegressionTimeout(input.mission.id, regressionBudgetMs);
  }
  if (blocking.length === 0) {
    const has = (file: string) => existsSync(join(root, file));
    const packagePresent = has('package.json');
    const applicable = requiredCheck;
    const outcome: CivilianAutoReviewOutcome = {
      kind: 'approved',
      evidenceId: `nexus-auto-review:${analysis.analysisHash}`,
      note: [civilianAutoReviewEvidenceNote(analysis), ceremonyProfileNote(ceremony), sensorSummaries(mechanical), regressionSummary(regression),
        !observedHead ? 'Arquivos atuais analisados sem comparação com histórico Git.' : '',
      ].filter(Boolean).join('\n'),
      verification: {
        analysisFailures: analysis.failures,
        declaredLimits: analysis.declaredLimits,
        headSha: observedHead,
        baseSha: input.completionBaseSha !== undefined ? input.completionBaseSha : observedHead ? baseSha : null,
        checks: mechanical.map(check => ({ kind: check.kind, summary: check.summary,
          status: check.status === 'unavailable' && !applicable(check.kind) ? 'not-applicable' : check.status })),
        regression,
        regressionApplicable: testsDropped ? false : regression ? !noApplicableTests
          : packagePresent || ['tsconfig.json', 'pyproject.toml', 'pytest.ini', 'Cargo.toml', 'go.mod', 'Makefile'].some(has) ||
            changedFiles.some(file => /(?:^|[/.])(?:tests?|spec)[/.]|\.(?:test|spec)\./i.test(file)),
      },
    };
    return outcome;
  }

  if (
    repairBudgetRemaining(input.mission.id) &&
    input.liveOrchestratorSessionId
  ) {
    consumeRepairBudget(input.mission.id);
    try {
      const prompt = repairPromptFor(blocking);
      const delivered = await launch(() => dependencies.deliverRepair
        ? dependencies.deliverRepair(input.liveOrchestratorSessionId!, prompt)
        : deliverAgentPrompt(input.liveOrchestratorSessionId!, prompt, input.lifetime
          ? { signal: input.lifetime.signal, assertCurrentAuthority: assertCurrent } : undefined));
      if (delivered) {
        repairCooldowns.set(
          input.mission.id,
          now() + CIVILIAN_REPAIR_COOLDOWN_MS,
        );
        return { kind: 'repair-dispatched' };
      }
    } catch {
      assertCurrent();
      // entrega falhou → cai para bloqueio visível abaixo
    }
  }
  return { kind: 'blocked', description: describeFindingsForOperator(blocking) };
}
