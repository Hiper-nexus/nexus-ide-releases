import { createHash } from 'node:crypto';
import type { Mission } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  AsyncProcessGitRunner,
  type AsyncGitRunner,
} from '../runtime/git-command';
import {
  runCandidateQualityAnalysis,
  type CandidateQualityAnalysis,
} from '../context/candidate-quality-scanner';
import {
  runDependencyAuditSensor,
  runTypecheckSensor,
  type MechanicalCheckResult,
  type MechanicalFinding,
} from '../context/mechanical-sensors';
import type { ReviewCategory, ReviewFindingInput } from '../context/review-council';
import { deliverAgentPrompt } from './tool-util';

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

const BLOCKING_SEVERITIES = new Set(['critical', 'high']);

const REPAIR_PROMPT_HEADER =
  '[NEXUS_QUALITY_REPAIR] A revisão automática encontrou problemas no código entregue. Corrija os itens abaixo antes de concluir a missão. Não marque como concluída sem corrigir.';

export type CivilianAutoReviewOutcome =
  | {
      readonly kind: 'approved';
      readonly evidenceId: string;
      readonly note: string;
    }
  | { readonly kind: 'repair-dispatched' }
  | { readonly kind: 'blocked'; readonly description: string }
  | { readonly kind: 'defer-to-roster-review' };

export interface CivilianAutoReviewInput {
  readonly mission: Mission;
  readonly scope: ProjectExecutionScope;
  /** Arquivos entregues pela missão (produto), já filtrados de lixo. */
  readonly productFiles: readonly string[];
  /** Sessão do Maestro vivo da missão, se existir. */
  readonly liveOrchestratorSessionId?: string | null;
}

export interface CivilianAutoReviewDependencies {
  readonly git?: AsyncGitRunner;
  readonly analyze?: typeof runCandidateQualityAnalysis;
  readonly typecheck?: (
    root: string,
  ) => Promise<MechanicalCheckResult>;
  readonly audit?: (root: string) => Promise<MechanicalCheckResult>;
  readonly deliverRepair?: (
    sessionId: string,
    prompt: string,
  ) => Promise<boolean>;
  readonly now?: () => number;
}

const repairBudgets = new Map<string, { used: number }>();
const repairCooldowns = new Map<string, number>();
/** Veredito aprovado é estável por HEAD — evita re-escanear a cada tick. */
const approvedMemo = new Map<
  string,
  { headSha: string; outcome: CivilianAutoReviewOutcome }
>();

export function __resetCivilianAutoReviewForTests(): void {
  repairBudgets.clear();
  repairCooldowns.clear();
  approvedMemo.clear();
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

/** Achados mecânicos (tsc/audit) no mesmo formato dos findings de review. */
function mechanicalToReviewFindings(
  results: readonly MechanicalCheckResult[],
): readonly ReviewFindingInput[] {
  return results.flatMap((result) =>
    result.findings.map((finding: MechanicalFinding): ReviewFindingInput => ({
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
  const now = dependencies.now ?? Date.now;
  if (repairCooldownActive(input.mission.id, now)) {
    // Reparo já despachado: dar tempo de trabalho ao Maestro.
    return { kind: 'repair-dispatched' };
  }

  const root = input.scope.rootRealPath;
  const git = dependencies.git ?? new AsyncProcessGitRunner();

  const headSha = await currentHeadSha(git, root);
  if (!headSha || !/^[a-f0-9]{40}$/u.test(headSha)) {
    return { kind: 'defer-to-roster-review' };
  }
  const memoized = approvedMemo.get(input.mission.id);
  if (memoized && memoized.headSha === headSha) {
    return memoized.outcome;
  }

  const baseSha = await resolveAutoReviewBaseSha(
    git,
    root,
    input.mission.createdAt,
  );
  if (!baseSha) {
    return { kind: 'defer-to-roster-review' };
  }

  const changedFiles = [...new Set(input.productFiles)].slice(0, 512);
  const diffHash = createHash('sha256')
    .update(changedFiles.join('\n'))
    .digest('hex');

  let analysis: CandidateQualityAnalysis;
  try {
    analysis = await (dependencies.analyze ?? runCandidateQualityAnalysis)(
      {
        scope: input.scope,
        checkoutPath: root,
        baseSha,
        headSha,
        diffHash,
        changedFiles,
      },
      dependencies.git ? { git: dependencies.git } : {},
    );
  } catch {
    return { kind: 'defer-to-roster-review' };
  }

  // Etapa 2 — sensores mecânicos Nexus-owned: typecheck + auditoria de
  // dependências quando o projeto permite (tsconfig/lockfile). Não dependem
  // de scripts no alvo; falha de infraestrutura é indisponível, não bloqueio.
  const mechanical = await Promise.all([
    (dependencies.typecheck ?? runTypecheckSensor)(root),
    (dependencies.audit ?? runDependencyAuditSensor)(root),
  ]);
  const mechanicalBlocking = mechanicalToReviewFindings(mechanical);
  const blocking = [...blockingFindingsOf(analysis), ...mechanicalBlocking];
  if (blocking.length === 0) {
    const outcome: CivilianAutoReviewOutcome = {
      kind: 'approved',
      evidenceId: `nexus-auto-review:${analysis.analysisHash}`,
      note: `${civilianAutoReviewEvidenceNote(analysis)}\n${sensorSummaries(mechanical)}`,
    };
    approvedMemo.set(input.mission.id, { headSha, outcome });
    return outcome;
  }

  if (
    repairBudgetRemaining(input.mission.id) &&
    input.liveOrchestratorSessionId
  ) {
    consumeRepairBudget(input.mission.id);
    try {
      const delivered = await (dependencies.deliverRepair ??
        deliverAgentPrompt)(
        input.liveOrchestratorSessionId,
        repairPromptFor(blocking),
      );
      if (delivered) {
        repairCooldowns.set(
          input.mission.id,
          now() + CIVILIAN_REPAIR_COOLDOWN_MS,
        );
        return { kind: 'repair-dispatched' };
      }
    } catch {
      // entrega falhou → cai para bloqueio visível abaixo
    }
  }
  return { kind: 'blocked', description: describeFindingsForOperator(blocking) };
}
