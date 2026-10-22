import type { ProjectExecutionScope } from '../../shared/types';
import { createHash, randomUUID } from 'node:crypto';
import { classifyWorkKind, requiresDesignAuthority } from '../../shared/mission-work-kind';
import { canonicalizeWorkText, collectUiWorkEvidence, isUiWorkText } from '../../shared/ui-work-signal';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedBrowserArtifactStore } from '../browser/browser-artifact-store';
import { captureWorkingTreeCandidate } from '../context/candidate-working-tree-snapshot';
import { isRunningPreviewUrlForScope } from './preview-server';
import { getMissionEventRuntimeManager } from './mission-event-emit';
import type { VisualTaskRequirement } from '../../shared/orch-types';
import { createScopedTaskStore } from './task-store';
import { withoutMountedPromptContextBlocks } from './prompt-context-blocks';

export type { VisualTaskRequirement } from '../../shared/orch-types';
export interface VisualHandoffContext {
  readonly scope: Readonly<ProjectExecutionScope>;
  readonly executionScope?: Readonly<ProjectExecutionScope>;
  readonly sessionId?: string;
  readonly missionId?: string;
  readonly workerIncarnationId?: string;
  readonly visualTask?: VisualTaskRequirement;
}
export type VisualHandoffVerdict = { readonly required: false; readonly verified: true } |
  { readonly required: true; readonly verified: false; readonly reason: string } |
  { readonly required: true; readonly verified: true; readonly artifactId: string; readonly sha256: string };

/** Only the Main assignment/immutable task is classified, never the reported result. */
export function createVisualTaskRequirement(now = Date.now(), id: string = randomUUID()): VisualTaskRequirement {
  return Object.freeze({ since: now, id });
}
/**
 * F-1311 — o pedido é visual, não o contexto em volta dele.
 *
 * Uma palavra de UI dentro de uma LISTA de exemplos ("tarefas como UI/design,
 * front-end e jogos"), uma enumeração de ferramentas ("(browser, design
 * system, terminal)"), um nome de ferramenta citado entre aspas/crases ou um
 * par de opções separado por barra ("UI/design") não provam que a tarefa
 * toca interface — o s240 teve pane de avaliação de roteamento marcado
 * visualTask por causa disso. O que sobra depois de tirar essas enumerações
 * é que é classificado; um pedido visual direto ("crie a tela de login")
 * sobrevive porque não é enumeração.
 */
// F-1311 (revisão Fable): o corte é só a ENUMERAÇÃO — itens curtos (até três
// palavras) separados por vírgula/"e"/"ou" que terminam a frase —, não a
// sentença inteira. "Mostre como a tela de login renderiza no mobile e
// corrija o layout" e "liste os botões quebrados na tela de checkout e
// corrija o alinhamento" não são listas: o pedido visual depois do "como"/
// "liste" fica para a classificação.
const ENUMERATION_WORD = String.raw`(?!(?:e|ou)\b)[^\s,.;:()\n]+`;
const ENUMERATION_ITEM = `${ENUMERATION_WORD}(?:[ \\t]+${ENUMERATION_WORD}){0,2}`;
const ENUMERATION_INTRODUCER = new RegExp(
  String.raw`\b(?:como|tais como|por exemplo|incluindo|incluem|e\.?\s?g\.?|exemplos?(?:\s+de)?|ferramentas?|tools?|skills?|cite|liste|nomeie|enumere|mencione)\s*:?\s*` +
  `${ENUMERATION_ITEM}(?:\\s*(?:,|\\be\\b|\\bou\\b)\\s*${ENUMERATION_ITEM})*(?=\\s*(?:[.;:)\\n]|$))`,
  'giu',
);
/** Enumeração entre parênteses: só valem as que listam itens (vírgula, barra ou "e"). */
const PAREN_ENUMERATION = /\([^()\n]*(?:[,\/]|\se\s)[^()\n]*\)/gu;
const QUOTED_SPAN = /(["'`«»“”‘’])[^"'`«»“”‘’\n]*\1/g;
const SLASH_OPTION = /\b[\p{L}][\p{L}\p{N}]*\/[\p{L}\p{N}\/]*\b/gu;

function withoutEnumerationContext(text: string): string {
  return text
    .replace(QUOTED_SPAN, ' ')
    .replace(PAREN_ENUMERATION, ' ')
    .replace(ENUMERATION_INTRODUCER, ' ')
    .replace(SLASH_OPTION, ' ');
}

/**
 * F-1417 — o rodapé "Regra de design do projeto (sempre que o trabalho
 * envolver UI)" é do Nexus, não da tarefa: cita DESIGN.md, tokens e "interface
 * renderizada" em QUALQUER brief. Uma revisão de segurança só leitura cujo
 * prompt trazia o rodapé foi rebaixada para `partial` com "[verificação visual
 * pendente]". O bloco sai do texto classificado, do cabeçalho até a frase fixa
 * que o fecha.
 */
// Mesmo texto de WORKSPACE_DESIGN_RULE_HEADING/ruleText (workspace-design-rule.ts),
// sem importar aquele módulo (settings e catálogo de design) para o gate.
const DESIGN_RULE_BLOCK = new RegExp(
  String.raw`Regra de design do projeto\s*\(sempre que o trabalho envolver UI\):` +
  // Revisão Grok: só o bloco COMPLETO (título + frase de fechamento, sem
  // atravessar linha em branco). Título citado sem o fechamento fica: nunca
  // remover até o fim do texto, senão o pedido visual depois dele some.
  String.raw`(?:(?!\n[ \t]*\n)[\s\S])*?ainda não aplicada como regra vigente\.`,
  'gu',
);

function withoutWorkspaceDesignRule(text: string): string {
  return text.replace(DESIGN_RULE_BLOCK, ' ');
}

/**
 * Review 22/10: a UI bug usually arrives REPORTED, not ordered — "o modal de
 * login não fecha no mobile" has no repair verb and a single ambiguous UI noun,
 * so neither the skill-grant quorum (`isUiWorkText`) nor the design-authority
 * verb rule saw it, and the worker that fixed the screen was never asked for a
 * capture. A UI place plus a visible malfunction OF that place is a visual
 * delivery. This vocabulary only decides the capture requirement: it never
 * grants skills nor writes a design contract, so it lives here and not in the
 * shared UI grammar. Patterns run on the canonical (accent-free) text.
 */
const UI_MALFUNCTION = new RegExp(String.raw`\b(?:` + [
  String.raw`nao\s+(?:fecha|abre|aparece|carrega|renderiza|mostra|exibe|rola|clica|envia|atualiza|cabe|centraliza)`,
  String.raw`sumiu|somem|desaparece\w*`,
  // "some" alone is also the English quantifier ("fix some issues").
  String.raw`some\s+(?:n[oa]s?|em|quando|ao|apos|depois)`,
  String.raw`cortad[oa]s?|sobrepost[oa]s?|desalinhad[oa]s?|desconfigurad[oa]s?`,
  String.raw`tela\s+(?:branca|em\s+branco)|blank\s+screen|white\s+screen`,
  String.raw`piscando|flicker\w*`,
  String.raw`(?:doesn'?t|does\s+not|won'?t|isn'?t|is\s+not|not)\s+(?:close|closing|open|opening|show|showing|render|rendering|display|displaying|scroll|scrolling)`,
].join('|') + String.raw`)\b`);
/** Hydration is a client-render concept; it only means a defect next to one. */
const HYDRATION = /\b(?:hidratacao|hydration)\b/;
const HYDRATION_DEFECT = /\b(?:erros?|errors?|falhas?|mismatch|warnings?|avisos?|bugs?)\b/;

function isReportedUiDefect(text: string, kind: string): boolean {
  // A document ABOUT the defect is a document; its writer has nothing to capture.
  if (kind === 'doc') return false;
  const canonical = canonicalizeWorkText(text);
  if (HYDRATION.test(canonical) && HYDRATION_DEFECT.test(canonical)) return true;
  const evidence = collectUiWorkEvidence(text);
  return (evidence.locative !== null || evidence.craft !== null) && UI_MALFUNCTION.test(canonical);
}

export function visualTaskRequirement(assignment: string | undefined, now = Date.now(), id?: string): VisualTaskRequirement | undefined {
  if (!assignment) return undefined;
  // F-1271: os blocos de contexto montados na frente (<business-model> com as
  // invariantes de UI do projeto, <workspace-memory>…) não são a tarefa.
  const text = withoutEnumerationContext(
    withoutWorkspaceDesignRule(withoutMountedPromptContextBlocks(assignment)),
  ).slice(0, 16_384);
  // A UI defect is still a visual delivery. Requiring a capture does not
  // reclassify it as new design work or grant design-authority capabilities.
  const kind = classifyWorkKind(text).kind;
  const required = requiresDesignAuthority(text) || (kind === 'bug' && isUiWorkText(text)) ||
    isReportedUiDefect(text, kind);
  return required ? createVisualTaskRequirement(now, id) : undefined;
}

type VisualPlannedTask = { readonly taskId?: string; readonly plannedTitle: string; readonly plannedDetail: string;
  readonly task: { readonly createdAt: number } };
function plannedRequirement(ctx: VisualHandoffContext, task?: VisualPlannedTask | null): VisualTaskRequirement | undefined {
  if (!task) return undefined;
  const id = `plan-${createHash('sha256').update(JSON.stringify([ctx.scope.installationId, ctx.scope.projectId,
    ctx.scope.checkoutId, ctx.sessionId, ctx.workerIncarnationId, task.taskId, task.task.createdAt,
    task.plannedTitle, task.plannedDetail])).digest('hex')}`;
  return visualTaskRequirement(`${task.plannedTitle}\n${task.plannedDetail}`, task.task.createdAt, id);
}

export interface VisualLaneAuthority {
  readonly readOnly?: boolean;
  readonly isolatedWriter?: boolean;
  readonly executionMode?: string;
}

/**
 * Review 22/10: a read-only lane (mapping, review, scouting) delivers findings,
 * not a rendered screen. Charging it a capture downgraded every reader of a UI
 * task to `partial`. F-1318: an isolated worktree — or any sealed writer mode —
 * beats the readOnly label; that pane writes and is still charged.
 */
export function isReadOnlyVisualLane(input: VisualLaneAuthority): boolean {
  if (input.isolatedWriter === true || input.executionMode === 'isolated_worktree' ||
    input.executionMode === 'same_checkout') return false;
  return input.readOnly === true || input.executionMode === 'read_only';
}

/** A supplied undefined is Main's negative classification, before adding boilerplate. */
export function visualTaskAtSpawn(input: VisualLaneAuthority & {
  role?: string; visualTask?: VisualTaskRequirement; initialPrompt?: string;
}): VisualTaskRequirement | undefined {
  if (input.role === 'orchestrator' || isReadOnlyVisualLane(input)) return undefined;
  return Object.hasOwn(input, 'visualTask') ? input.visualTask : visualTaskRequirement(input.initialPrompt);
}

/**
 * Review 22/10: what a capture proves. It must show THIS worker's build (a
 * Nexus preview rooted in its execution checkout, not a public page), and it
 * is bound to the candidate it showed: the tree content relative to the HEAD
 * at capture time. Committing that same tree keeps the capture; any edit after
 * it (a rework round included) needs a fresh one.
 */
export interface VisualCandidateObservation {
  /** HEAD the content was measured against; null without Git history. */
  readonly base: string | null;
  readonly fingerprint: string;
}
/** Null: the candidate could not be observed (unreadable root, Git refused). */
export type VisualCandidateObserver = (
  scope: Readonly<ProjectExecutionScope>,
  base?: string | null,
) => Promise<VisualCandidateObservation | null>;

export const observeVisualCandidate: VisualCandidateObserver = async (scope, base) => {
  try {
    const snapshot = await captureWorkingTreeCandidate({ scope, ...(base ? { baseSha: base } : {}) });
    if (!snapshot.contentFingerprint) return null;
    return { base: base ?? snapshot.headSha, fingerprint: snapshot.contentFingerprint };
  } catch {
    return null;
  }
};

export interface VisualEvidenceDeps {
  /** The page captured is served from the worker's own execution checkout. */
  readonly servedFromCandidate?: (url: string, scope: Readonly<ProjectExecutionScope>) => boolean;
  readonly observeCandidate?: VisualCandidateObserver;
}

/** Capture-time observations still running, by artifact: the handoff check waits for them. */
const pendingCandidateBindings = new Map<string, Promise<void>>();
/** One observation per checkout at a time: a responsive run records three captures at once. */
const inflightObservations = new WeakMap<VisualCandidateObserver, Map<string, Promise<VisualCandidateObservation | null>>>();

function sharedObservation(observe: VisualCandidateObserver,
  scope: Readonly<ProjectExecutionScope>): Promise<VisualCandidateObservation | null> {
  let byRoot = inflightObservations.get(observe);
  if (!byRoot) {
    byRoot = new Map();
    inflightObservations.set(observe, byRoot);
  }
  const running = byRoot.get(scope.rootRealPath);
  if (running) return running;
  const observation = observe(scope).catch(() => null);
  byRoot.set(scope.rootRealPath, observation);
  void observation.finally(() => {
    if (byRoot.get(scope.rootRealPath) === observation) byRoot.delete(scope.rootRealPath);
  });
  return observation;
}

function bindCaptureToCandidate(manager: ProjectRuntimeManager, ctx: VisualHandoffContext, artifactId: string,
  observe: VisualCandidateObserver): void {
  const binding: Promise<void> = sharedObservation(observe, ctx.executionScope ?? ctx.scope)
    .then((observation) => {
      const runtime = manager.open(ctx.scope);
      runtime.assertWritable();
      runtime.db.prepare(`UPDATE visual_handoff_evidence
        SET candidate_observed_at = ?, candidate_base = ?, candidate_fingerprint = ?
        WHERE artifact_id = ? AND candidate_observed_at IS NULL`)
        .run(Date.now(), observation?.base ?? null, observation?.fingerprint ?? null, artifactId);
    })
    .catch((error: unknown) => {
      // The row stays unbound, so it never proves a candidate: fail closed.
      console.warn('[visual-gate] captura sem candidato registrado:', error instanceof Error ? error.message : error);
    })
    .finally(() => {
      if (pendingCandidateBindings.get(artifactId) === binding) pendingCandidateBindings.delete(artifactId);
    });
  pendingCandidateBindings.set(artifactId, binding);
}

/** Tests and shutdown: every capture-time candidate observation has settled. */
export async function visualCandidateBindingsSettled(): Promise<void> {
  while (pendingCandidateBindings.size > 0) await Promise.all([...pendingCandidateBindings.values()]);
}

function capturedUrl(metadataJson: string): string | null {
  try {
    const metadata = JSON.parse(metadataJson) as { url?: unknown };
    return typeof metadata.url === 'string' ? metadata.url : null;
  } catch {
    return null;
  }
}

/** Called after an authorized native browser capture, not from tool arguments. */
export function recordVisualHandoffEvidence(ctx: VisualHandoffContext, artifactId: string,
  manager = getMissionEventRuntimeManager(), deps: VisualEvidenceDeps = {}): boolean {
  if (!manager || !ctx.sessionId) return false;
  const runtime = manager.open(ctx.scope);
  let requirement = ctx.visualTask;
  if (!requirement && ctx.missionId) {
    const bound = runtime.db.prepare(`SELECT task_id FROM task_dispatch_queue
      WHERE mission_id = ? AND session_id = ? AND worker_incarnation_id IS ? LIMIT 2`)
      .all(ctx.missionId, ctx.sessionId, ctx.workerIncarnationId ?? null) as Array<{ task_id: string }>;
    if (bound.length === 1) requirement = plannedRequirement(ctx, createScopedTaskStore(manager, ctx.scope).getPlannedTask(bound[0].task_id));
  }
  if (!requirement) return false;
  const row = runtime.db.prepare(`SELECT mission_id, created_at, metadata_json FROM browser_artifacts
    WHERE id = ? AND artifact_type = 'screenshot'`).get(artifactId) as
    { mission_id: string | null; created_at: number; metadata_json: string } | undefined;
  if (!row || row.mission_id !== (ctx.missionId ?? null)) return false;
  const execution = ctx.executionScope ?? ctx.scope;
  const url = capturedUrl(row.metadata_json);
  if (!url || !(deps.servedFromCandidate ?? isRunningPreviewUrlForScope)(url, execution)) return false;
  runtime.assertWritable();
  const result = runtime.db.prepare(`INSERT OR IGNORE INTO visual_handoff_evidence
    (artifact_id, mission_id, session_id, worker_incarnation_id, execution_root, captured_at, assignment_id) VALUES (?,?,?,?,?,?,?)`)
    .run(artifactId, ctx.missionId ?? null, ctx.sessionId, ctx.workerIncarnationId ?? null,
      execution.rootRealPath, row.created_at, requirement.id);
  if (result.changes !== 1) return false;
  bindCaptureToCandidate(manager, ctx, artifactId, deps.observeCandidate ?? observeVisualCandidate);
  return true;
}

/**
 * F-1635: a entrega tem uma captura do navegador que o MAIN verificou?
 *
 * Só o terceiro formato do veredito é evidência. Uma tarefa NÃO visual volta
 * `{ required: false, verified: true }` — `verified` ali quer dizer "nada a
 * exigir", não "captura observada". Ler só `verified` daria evidência visual a
 * todo handoff de código e desligaria o sinal de verificação do Jev.
 */
export function visualEvidenceVerified(verdict: VisualHandoffVerdict | undefined): boolean {
  return verdict?.required === true && verdict.verified === true &&
    typeof verdict.artifactId === 'string' && verdict.artifactId.length > 0;
}

interface EvidenceRow {
  readonly artifact_id: string;
  readonly candidate_observed_at: number | null;
  readonly candidate_base: string | null;
  readonly candidate_fingerprint: string | null;
}

export const VISUAL_CAPTURE_MISSING_REASON =
  'A tarefa visual ainda precisa de uma captura do navegador do Nexus feita por este worker nesta execução, ' +
  'da página servida por nexus_preview_start a partir do build desta worktree.';
export const VISUAL_CAPTURE_STALE_REASON =
  'A captura do navegador é de antes da última alteração do código desta worktree: capture de novo o build atual.';

export async function checkVisualHandoff(ctx: VisualHandoffContext, options: {
  manager?: ProjectRuntimeManager | null;
  task?: VisualPlannedTask | null;
  assertCurrent?: () => void;
  observeCandidate?: VisualCandidateObserver;
} = {}): Promise<VisualHandoffVerdict> {
  const requirement = ctx.visualTask ?? plannedRequirement(ctx, options.task);
  const initialAssignment = ctx.visualTask;
  if (!requirement) return { required: false, verified: true };
  const missing = (reason = VISUAL_CAPTURE_MISSING_REASON): VisualHandoffVerdict =>
    ({ required: true, verified: false, reason });
  const manager = options.manager ?? getMissionEventRuntimeManager();
  if (!manager || !ctx.sessionId) return missing();
  options.assertCurrent?.();
  const runtime = manager.open(ctx.scope);
  const execution = ctx.executionScope ?? ctx.scope;
  const select = (): EvidenceRow[] => runtime.db.prepare(`SELECT artifact_id, candidate_observed_at, candidate_base,
    candidate_fingerprint FROM visual_handoff_evidence
    WHERE session_id = ? AND mission_id IS ? AND worker_incarnation_id IS ? AND execution_root = ? AND assignment_id = ?
    ORDER BY captured_at DESC LIMIT 4`).all(ctx.sessionId, ctx.missionId ?? null, ctx.workerIncarnationId ?? null,
    execution.rootRealPath, requirement.id) as EvidenceRow[];
  // A capture taken right before the submit may still be measuring its candidate.
  const pending = select().flatMap((row) => pendingCandidateBindings.get(row.artifact_id) ?? []);
  if (pending.length > 0) {
    await Promise.all(pending);
    options.assertCurrent?.();
  }
  const observe = options.observeCandidate ?? observeVisualCandidate;
  const current = new Map<string, Promise<VisualCandidateObservation | null>>();
  const currentAt = (base: string | null): Promise<VisualCandidateObservation | null> => {
    const key = base ?? '';
    let observation = current.get(key);
    if (!observation) {
      observation = observe(execution, base).catch(() => null);
      current.set(key, observation);
    }
    return observation;
  };
  const store = createScopedBrowserArtifactStore(manager, ctx.scope);
  let stale = false;
  for (const row of select()) {
    // Unbound: recorded before this version, or its observation never finished.
    if (row.candidate_observed_at === null) {
      stale = true;
      continue;
    }
    const artifact = await store.verifiedScreenshot(row.artifact_id, options.assertCurrent);
    options.assertCurrent?.();
    if (ctx.visualTask !== initialAssignment) return missing();
    if (!artifact || artifact.missionId !== (ctx.missionId ?? null)) continue;
    const now = await currentAt(row.candidate_base);
    options.assertCurrent?.();
    if (ctx.visualTask !== initialAssignment) return missing();
    // Null on both sides: the checkout cannot be observed at all, as before
    // this binding existed; it never stands in for a measured fingerprint.
    if ((now?.fingerprint ?? null) !== row.candidate_fingerprint) {
      stale = true;
      continue;
    }
    return { required: true, verified: true, artifactId: artifact.id, sha256: artifact.sha256 };
  }
  return missing(stale ? VISUAL_CAPTURE_STALE_REASON : VISUAL_CAPTURE_MISSING_REASON);
}
