import type { Mission } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import type { WorkingTreeCandidateSnapshot } from '../context/candidate-working-tree-snapshot';
import type { AutomaticCompletionProof } from './automatic-completion-proof';
import type { CivilianAutoReviewOutcome } from './civilian-auto-review';
import type { MissionReviewVerdict } from './mission-review-verdict-ledger';

export interface MissionCodeCompletionInput {
  readonly scope: ProjectExecutionScope;
  readonly executionScope: ProjectExecutionScope;
  readonly mission: Mission;
  /** Main-proved baseline; null requests an explicit current-state review. */
  readonly baselineSha: string | null;
  /** When the Main baseline was observed; untracked files untouched since then are not this delta (F-1301). */
  readonly baselineObservedAt?: number;
  readonly authorSessionIds: readonly string[];
  /** Main-resolved delivered/required artifacts, including unchanged files. */
  readonly requiredPaths?: readonly string[];
  /** Existing Main-validated text-only authority, never an MCP argument. */
  readonly textOnly?: boolean;
}
export interface MissionCodeCandidate {
  readonly scope: ProjectExecutionScope;
  readonly executionScope: ProjectExecutionScope;
  readonly mission: Mission;
  readonly baseSha: string | null;
  readonly coverage: 'delta' | 'current-state';
  readonly candidate: WorkingTreeCandidateSnapshot;
  /** F-1301: Main baseline observation time behind the delta, when known. */
  readonly untrackedSince?: number;
}
export type MissionCodeReviewResult =
  | { readonly kind: 'waiting' | 'unavailable'; readonly reason: string }
  | { readonly kind: 'reviewed'; readonly verdict: Omit<MissionReviewVerdict, 'headSha'> & { readonly headSha: string | null };
      readonly candidateFingerprint: string; readonly baseSha: string | null; readonly readOnly: boolean };
export interface MissionCodeCompletionPorts {
  captureCandidate(input: { scope: ProjectExecutionScope; baseSha?: string; mode: 'delta' | 'current-state'; requiredPaths?: readonly string[]; untrackedSince?: number }): Promise<WorkingTreeCandidateSnapshot>;
  runMechanical(input: MissionCodeCandidate): Promise<CivilianAutoReviewOutcome>;
  ensureIndependentReview(input: MissionCodeCandidate): Promise<MissionCodeReviewResult>;
  assertCurrent(): void;
}
export interface CodeCompletionCertification {
  readonly kind: 'code' | 'non-code';
  readonly coverage: 'delta' | 'current-state';
  readonly headSha: string | null;
  readonly fingerprint?: string;
  readonly reviewerSessionId?: string;
  readonly evidenceIds: readonly string[];
}
export type MissionCodeCompletionOutcome =
  | { readonly kind: 'verified' | 'exempt'; readonly proof: AutomaticCompletionProof }
  | { readonly kind: 'waiting' | 'blocked'; readonly code: string; readonly reason: string;
      readonly hint: string; readonly findings?: readonly string[] };

type ProofMission = Pick<Mission, 'id' | 'intentVersion' | 'updatedAt' | 'intentState' | 'intentContract'>;
const issued = new WeakMap<CodeCompletionCertification, string>();
function identity(scope: ProjectExecutionScope, mission: ProofMission): string {
  return JSON.stringify([scope.installationId, scope.projectId, scope.checkoutId, scope.rootRealPath,
    scope.version, scope.workspaceRootDevice, scope.workspaceRootInode,
    mission.id, mission.intentVersion, mission.updatedAt, mission.intentState, mission.intentContract]);
}

/** Called only after the existing active automatic-proof identity check. */
export function isMissionCodeCompletionProof(proof: AutomaticCompletionProof, scope: ProjectExecutionScope, mission: ProofMission): boolean {
  const certification = proof.codeCompletion;
  return proof.status === 'verified' && certification !== undefined &&
    issued.get(certification) === identity(scope, mission) &&
    proof.candidateFingerprint === certification.fingerprint;
}

function docsOnly(paths: readonly string[]): boolean {
  return paths.every(file => {
    if (/(?:^|\/)(?:CMakeLists\.txt|requirements(?:[._-][^/]*)?\.txt)$/i.test(file)) return false;
    if (/(?:^|\/)(?:README|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|AUTHORS|HISTORY)(?:\.(?:md|rst|txt|adoc))?$/i.test(file)) return true;
    if (/(?:^|\/)(?:LICENSE|LICENCE|COPYING|NOTICE)(?:\.(?:md|rst|txt|adoc))?$/i.test(file)) return true;
    return /^docs?\/.+\.(?:md|rst|txt|adoc)$/i.test(file) && !/(?:^|\/)(?:config|configs|assets|scripts)\//i.test(file);
  });
}

/** F-1301: untracked WIP older than the baseline stays outside the certified candidate; name it, never hide it. */
function staleNote(candidate: WorkingTreeCandidateSnapshot): string {
  const stale = candidate.staleUntrackedPaths ?? [];
  if (stale.length === 0) return '';
  const shown = stale.slice(0, 20);
  return `Fora do candidato e não revisados (não rastreados anteriores à base): ${shown.join(', ')}${stale.length > shown.length ? ` (+${stale.length - shown.length})` : ''}.`;
}

/** Stateless: the caller reuses the existing mission completion flight/retry owner. */
export async function ensureMissionCodeCompletion(input: MissionCodeCompletionInput, ports: MissionCodeCompletionPorts): Promise<MissionCodeCompletionOutcome> {
  const { scope, executionScope, mission } = input;
  const coverage = input.baselineSha === null ? 'current-state' : 'delta';
  const hint = `Após corrigir a causa, tente nexus_mission_set_status(${JSON.stringify({ missionId: mission.id, status: 'done', note: 'Solicito novamente a verificação da entrega atual.' })}).`;
  const refuse = (code: string, reason: string, kind: 'waiting' | 'blocked' = 'blocked'): Exclude<MissionCodeCompletionOutcome, { kind: 'verified' | 'exempt' }> => ({ kind, code, reason, hint });
  const certify = (kind: 'code' | 'non-code', candidate?: WorkingTreeCandidateSnapshot, reviewerSessionId?: string, evidenceIds: readonly string[] = [], note = ''): MissionCodeCompletionOutcome => {
    const certification: CodeCompletionCertification = Object.freeze({ kind, coverage, headSha: candidate?.headSha ?? null,
      fingerprint: candidate?.fingerprint, reviewerSessionId, evidenceIds: Object.freeze([...evidenceIds]) });
    issued.set(certification, identity(scope, mission));
    return { kind: kind === 'code' ? 'verified' : 'exempt', proof: { status: 'verified', codeCompletion: certification,
      candidateFingerprint: candidate?.fingerprint, deletedArtifactPaths: candidate?.deletedPaths, note } };
  };
  ports.assertCurrent();
  if (scope.installationId !== executionScope.installationId || scope.projectId !== executionScope.projectId || scope.checkoutId !== executionScope.checkoutId) {
    return refuse('code_completion_scope_changed', 'O candidato pertence a outro projeto ou checkout.');
  }
  const lane = mission.intentContract?.lane ?? 'standard';
  if (input.textOnly || lane !== 'standard') return certify('non-code', undefined, undefined, [], 'Conclusão pela autoridade existente de texto/operação.');
  if (input.baselineSha !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.baselineSha)) return refuse('code_baseline_invalid', 'A base de verificação precisa ser restaurada ou a revisão deve abranger o estado atual.');
  const untrackedSince = coverage === 'delta' ? input.baselineObservedAt : undefined;
  const capture = () => ports.captureCandidate({ scope: executionScope, mode: coverage,
    ...(input.baselineSha ? { baseSha: input.baselineSha } : {}),
    ...(untrackedSince !== undefined ? { untrackedSince } : {}),
    ...(input.requiredPaths?.length ? { requiredPaths: input.requiredPaths } : {}) });
  let candidate: WorkingTreeCandidateSnapshot;
  try { candidate = await capture(); } catch { ports.assertCurrent(); return refuse('code_candidate_unavailable', 'Não foi possível medir o candidato atual; arquivos e branches foram preservados.'); }
  ports.assertCurrent();
  if (!candidate.complete) {
    // F-1301: the operator must see WHICH files blocked the read.
    const shown = candidate.incompleteReasons.slice(0, 3).join('; ');
    const more = candidate.incompleteReasons.length > 3 ? ` (+${candidate.incompleteReasons.length - 3})` : '';
    return refuse('code_candidate_incomplete', `A leitura do candidato ficou incompleta: ${shown}${more}. Reduza o escopo da revisão ou restaure uma base conhecida.`);
  }
  if (coverage === 'delta' && (!candidate.headSha || candidate.source !== 'git')) return refuse('code_baseline_unavailable', 'A base Git não pôde ser consultada. Restaure o repositório ou revise explicitamente o estado atual.');
  const reviewPaths = [...new Set([...candidate.changedPaths, ...candidate.deletedPaths,
    ...(candidate.coveredPaths ?? []), ...(input.requiredPaths ?? [])])];
  // No diff is not proof of a fulfilled coding request. Existing code claimed
  // as the product must be reviewed too; a README cannot hide that artifact.
  if (coverage === 'delta' && reviewPaths.length > 0 && docsOnly(reviewPaths)) {
    return certify('non-code', candidate, undefined, [], ['Candidato documental sem entrega de código.', staleNote(candidate)].filter(Boolean).join('\n'));
  }
  const work: MissionCodeCandidate = { scope, executionScope, mission, baseSha: input.baselineSha, coverage, candidate,
    ...(untrackedSince !== undefined ? { untrackedSince } : {}) };
  let mechanical: CivilianAutoReviewOutcome;
  try { mechanical = await ports.runMechanical(work); } catch { ports.assertCurrent(); return refuse('code_checks_unavailable', 'As verificações mecânicas não terminaram; restaure as ferramentas necessárias e tente novamente.'); }
  ports.assertCurrent();
  if (mechanical.kind === 'repair-dispatched') return refuse('code_repair_running', 'A correção dos achados mecânicos já foi encaminhada.', 'waiting');
  if (mechanical.kind === 'defer-to-roster-review' && mechanical.retryable) return refuse('code_checks_pending', mechanical.reason ?? 'Verificações aguardando recursos; tente novamente.', 'waiting');
  if (mechanical.kind !== 'approved') return refuse('code_checks_failed', mechanical.kind === 'blocked' ? mechanical.description : mechanical.reason ?? 'Verificação mecânica indisponível.');
  const verification = mechanical.verification;
  if (!verification || !verification.analysisComplete) return refuse('code_checks_incomplete', 'A análise estática completa do candidato ainda não foi comprovada.');
  if (verification.headSha !== candidate.headSha || verification.baseSha !== input.baselineSha) return refuse('code_checks_stale', 'As verificações mecânicas pertencem a outro candidato.', 'waiting');
  if (verification.checks.some(check => check.kind !== 'dependency-freshness' && (check.status === 'failed' || check.status === 'unavailable'))) return refuse('code_checks_unavailable', 'Há verificação aplicável que falhou ou não pôde executar.');
  const regression = verification.regression;
  if ((!regression && verification.regressionApplicable !== false) || regression && (
    regression.status === 'failed' || regression.status === 'unavailable' || regression.testsNotRun.length > 0 ||
    verification.regressionApplicable === true && (regression.status === 'no-tests' || regression.status === 'clean') ||
    regression.coverage && (!regression.coverage.indexComplete || regression.coverage.skippedTests.length > 0) ||
    regression.status === 'passed' && (regression.testsRun.length === 0 || regression.headSha !== candidate.headSha || input.baselineSha !== null && regression.baseSha !== input.baselineSha)
  )) return refuse('code_tests_unverified', 'Os testes aplicáveis não foram executados e aprovados integralmente no candidato atual.');
  let afterChecks: WorkingTreeCandidateSnapshot;
  try { afterChecks = await capture(); } catch { ports.assertCurrent(); return refuse('code_candidate_unavailable', 'Não foi possível revalidar o candidato depois dos checks.'); }
  ports.assertCurrent();
  if (!afterChecks.complete || afterChecks.fingerprint !== candidate.fingerprint || afterChecks.headSha !== candidate.headSha) return refuse('code_candidate_changed', 'A entrega mudou durante os checks; verifique o novo candidato antes de abrir o juiz.', 'waiting');
  let review: MissionCodeReviewResult;
  try { review = await ports.ensureIndependentReview(work); } catch { ports.assertCurrent(); return refuse('code_reviewer_unavailable', 'Não foi possível iniciar ou consultar o revisor independente.'); }
  ports.assertCurrent();
  if (review.kind !== 'reviewed') return refuse('code_review_pending', review.reason, review.kind === 'waiting' ? 'waiting' : 'blocked');
  const verdict = review.verdict;
  if (verdict.missionId !== mission.id || verdict.headSha !== candidate.headSha || review.baseSha !== input.baselineSha || review.candidateFingerprint !== candidate.fingerprint) return refuse('code_review_stale', 'O veredito não corresponde ao candidato atual.', 'waiting');
  if (!verdict.frontier || !review.readOnly || !verdict.reviewerSession || verdict.reviewerSession === mission.orchestratorSessionId || input.authorSessionIds.includes(verdict.reviewerSession)) return refuse('code_review_not_independent', 'O candidato precisa de um juiz frontier independente, em uma sessão de leitura própria.');
  if (verdict.verdict !== 'approve') return { ...refuse('code_review_rejected', 'A revisão independente encontrou achados que precisam de correção.'), findings: [...verdict.findings] };
  let fresh: WorkingTreeCandidateSnapshot;
  try { fresh = await capture(); } catch { ports.assertCurrent(); return refuse('code_candidate_unavailable', 'Não foi possível revalidar o candidato depois da revisão.'); }
  ports.assertCurrent();
  if (!fresh.complete || fresh.fingerprint !== candidate.fingerprint || fresh.headSha !== candidate.headSha) return refuse('code_candidate_changed', 'A entrega mudou durante a verificação; revise o novo candidato.', 'waiting');
  const note = [mechanical.note, 'Revisão frontier independente do candidato atual registrada.',
    regression?.testsRun.length ? '' : 'Não houve execução de testes: nenhum teste aplicável foi identificado; a cobertura fica limitada à revisão e aos demais checks aplicáveis.',
    coverage === 'current-state' ? 'Base histórica desconhecida: revisão do estado atual, sem atribuir autoria das alterações ou do WIP à missão.' : '',
    coverage === 'delta' ? 'A base delimita o candidato; ela não comprova autoria do WIP preexistente.' : '',
    staleNote(fresh),
  ].filter(Boolean).join('\n');
  return certify('code', fresh, verdict.reviewerSession, [mechanical.evidenceId, verdict.verdictId], note);
}
