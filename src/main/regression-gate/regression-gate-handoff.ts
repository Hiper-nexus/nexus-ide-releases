/**
 * Portão de regressão no handoff de escrita (missão e "+ Pane"). Mesmo
 * padrão do contrato de entrega e da revisão Jev: diff que quebra teste
 * impactado devolve o handoff ao agente com as falhas (`retry` → o tool lança
 * e o agente recebe o erro); esgotadas as devoluções, o handoff entra como
 * `blocked` com as falhas em artifact — nunca como `success`.
 */
import type { ProjectExecutionScope } from '../../shared/types';
import { randomUUID } from 'node:crypto';
import type { McpToolInvocation } from '../orch/mcp-protocol';
import {
  formatRegressionGateReport,
  isRegressionGateEnabled,
  runRegressionGate,
  type RegressionGateDependencies,
  type RegressionGateResult,
  type RegressionNotRun,
} from './regression-gate';

export const REGRESSION_GATE_BOUNCES_PER_SESSION = 2;
/**
 * Orçamento TOTAL do portão no handoff (mapa + testes + retentativa). F-1288:
 * abaixo do MENOR prazo de cliente que chama o submit — o MCP de algumas CLIs
 * derruba a chamada aos 60 s, e o agente reenviava pelo shim antes de o gate
 * responder (handoff duplicado no Maestro). 45 s deixam ~15 s de folga para o
 * que ainda roda depois do gate (revisão Jev, persistência) e seguem abaixo
 * do `tool_timeout_sec=120` do Codex. Vencido, o gate corta como antes:
 * `unavailable` → aceito e NÃO verificado, fail-open honesto.
 */
export const HANDOFF_REGRESSION_BUDGET_MS = 45_000;
/** O runner destacado não compete com a resposta MCP; pode terminar o lote útil. */
export const BACKGROUND_HANDOFF_REGRESSION_BUDGET_MS = 120_000;
/** Prefixo no resumo quando os testes impactados não rodaram. */
export const REGRESSION_UNVERIFIED_PREFIX = '[testes impactados não verificados]';
const MAX_TRACKED_SESSIONS = 512;

export interface RegressionGateArtifact {
  readonly kind: 'nexus.regressionGate';
  readonly payload: {
    readonly status: RegressionGateResult['status'] | 'running';
    /** Liga o recibo provisório ao resultado Main-owned que o substitui. */
    readonly runId?: string;
    readonly diffHash: string;
    readonly headSha: string | null;
    readonly baseSha: string | null;
    readonly runner: RegressionGateResult['runner'];
    /** F-1348: causa do que não rodou — fora do corte de `warnings`. */
    readonly notRun?: RegressionNotRun | null;
    readonly testsRun: readonly string[];
    readonly testsNotRun: readonly string[];
    /** Leitura curta para o Maestro, sem precisar inferir dos arrays. */
    readonly summary: {
      readonly affected: number;
      readonly passed: number;
      readonly failed: number;
      readonly notRun: number;
    };
    readonly failures: RegressionGateResult['failures'];
    readonly inheritedFailures: RegressionGateResult['inheritedFailures'];
    readonly preexistingFailures: RegressionGateResult['preexistingFailures'];
    readonly untestedFiles: readonly string[];
    readonly invariantsTouched: RegressionGateResult['invariantsTouched'];
    readonly warnings: readonly string[];
  };
}

export type RegressionHandoffVerdict =
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'retry'; readonly message: string }
  | {
      readonly kind: 'accepted';
      readonly artifact?: RegressionGateArtifact;
      /** Havia testes impactados e eles não rodaram: aceito, mas NÃO verificado. */
      readonly unverified?: boolean;
      /** Só no handoff assíncrono: chamar DEPOIS da escrita durável. */
      readonly completeInBackground?: () => Promise<RegressionGateArtifact>;
    }
  | { readonly kind: 'exhausted'; readonly artifact: RegressionGateArtifact; readonly report: string };

const bouncesBySession = new Map<string, number>();

export function __resetRegressionHandoffBouncesForTests(): void {
  bouncesBySession.clear();
}

function artifactOf(result: RegressionGateResult, runId?: string): RegressionGateArtifact {
  return {
    kind: 'nexus.regressionGate',
    payload: {
      status: result.status,
      ...(runId ? { runId } : {}),
      diffHash: result.diffHash,
      headSha: result.headSha,
      baseSha: result.baseSha,
      runner: result.runner,
      notRun: result.notRun ?? null,
      testsRun: result.testsRun.slice(0, 64),
      testsNotRun: result.testsNotRun.slice(0, 64),
      summary: {
        affected: result.testsRun.length + result.testsNotRun.length,
        failed: new Set(result.failures.map((failure) => failure.file)).size,
        passed: result.testsRun.filter((test) => !result.failures.some((failure) => failure.file === test)).length,
        notRun: result.testsNotRun.length,
      },
      failures: result.failures.slice(0, 16),
      inheritedFailures: result.inheritedFailures.slice(0, 16),
      preexistingFailures: result.preexistingFailures.slice(0, 16),
      untestedFiles: result.untestedFiles.slice(0, 32),
      invariantsTouched: result.invariantsTouched.slice(0, 16),
      warnings: result.warnings.slice(0, 8),
    },
  };
}

function pendingArtifact(runId: string): RegressionGateArtifact {
  return {
    kind: 'nexus.regressionGate',
    payload: {
      status: 'running', runId, diffHash: '', headSha: null, baseSha: null, runner: null,
      notRun: null, testsRun: [], testsNotRun: [], summary: { affected: 0, passed: 0, failed: 0, notRun: 0 }, failures: [], inheritedFailures: [],
      preexistingFailures: [], untestedFiles: [], invariantsTouched: [], warnings: [],
    },
  };
}

function unavailableArtifact(runId: string): RegressionGateArtifact {
  const pending = pendingArtifact(runId);
  return {
    ...pending,
    payload: {
      ...pending.payload,
      status: 'unavailable',
      warnings: ['execução em segundo plano falhou antes de produzir relatório'],
    },
  };
}

/**
 * Troca somente o recibo Main-owned que este módulo acabou de criar. O store
 * mantém a identidade do handoff; Maestro/renderer recebem o evento normal.
 */
export function settleBackgroundRegressionGate(
  verdict: RegressionHandoffVerdict,
  handoffId: string,
  store: {
    replaceBackgroundRegressionArtifact: (
      handoffId: string,
      runId: string,
      artifact: RegressionGateArtifact,
    ) => boolean;
  },
): void {
  if (verdict.kind !== 'accepted' || !verdict.completeInBackground) return;
  const runId = verdict.artifact?.payload.runId;
  if (!runId) return;
  void verdict.completeInBackground().then((artifact) => {
    store.replaceBackgroundRegressionArtifact(handoffId, runId, artifact);
  }).catch((error) => {
    console.warn('[regression-gate] não consegui persistir o resultado em segundo plano:', error);
  });
}

export async function evaluateHandoffRegressionGate(
  input: {
    readonly sessionId?: string;
    readonly scope: ProjectExecutionScope;
    readonly projectScope?: ProjectExecutionScope;
    readonly declaredFiles?: readonly string[];
    readonly baseSha?: string;
    /** Spawn da sessão que entrega: base do diff e corte do WIP alheio. */
    readonly startedAtMs?: number;
    /** F-1237: edições registradas da conversa retomada (ver RunRegressionGateInput). */
    readonly recordedEdits?: ReadonlyMap<string, string>;
    readonly signal?: AbortSignal;
    readonly authority?: McpToolInvocation;
    /** Checkout principal do projeto (escopo do Main): ver RunRegressionGateInput. */
    readonly trustedDependencyRoot?: string;
    /** Handoff MCP: persiste `running`, executa depois sem segurar a resposta. */
    readonly background?: boolean;
    /**
     * false quando o transporte não devolve erro ao agente (bloco no PTY,
     * fechamento mecânico): falha entra direto como `exhausted` (blocked),
     * nunca como success.
     */
    readonly returnable?: boolean;
  },
  deps: RegressionGateDependencies & { readonly enabled?: () => boolean } = {},
): Promise<RegressionHandoffVerdict> {
  if (!(deps.enabled ?? isRegressionGateEnabled)()) {
    return { kind: 'skipped', reason: 'disabled' };
  }
  const run = () => runRegressionGate(
    {
      scope: input.scope,
      projectScope: input.projectScope,
      declaredFiles: input.declaredFiles,
      baseSha: input.baseSha,
      startedAtMs: input.startedAtMs,
      recordedEdits: input.recordedEdits,
      timeoutMs: input.background ? BACKGROUND_HANDOFF_REGRESSION_BUDGET_MS : HANDOFF_REGRESSION_BUDGET_MS,
      // A resposta MCP fecha/cancela a invocation; o job destacado já foi
      // autorizado pelo Main e não pode herdar esse AbortSignal efêmero.
      signal: input.background ? undefined : input.signal,
      authority: input.background ? undefined : input.authority,
      trustedDependencyRoot: input.trustedDependencyRoot,
    },
    deps,
  );
  if (input.background) {
    const runId = randomUUID();
    return {
      kind: 'accepted',
      artifact: pendingArtifact(runId),
      unverified: true,
      completeInBackground: async () => {
        try {
          return artifactOf(await run(), runId);
        } catch (error) {
          console.warn('[regression-gate] portão em segundo plano falhou (registrado):', error);
          return unavailableArtifact(runId);
        }
      },
    };
  }
  let result: RegressionGateResult;
  try {
    result = await run();
  } catch (error) {
    // Fail-open: infraestrutura do portão nunca segura a entrega.
    console.warn('[regression-gate] portão falhou (ignorado):', error);
    return { kind: 'skipped', reason: 'gate-error' };
  }
  if (result.status === 'clean') return { kind: 'skipped', reason: 'clean' };
  if (result.status !== 'failed') {
    if (input.sessionId) bouncesBySession.delete(input.sessionId);
    if (result.untestedFiles.length > 0 || result.warnings.length > 0) {
      console.info(`[regression-gate] ${formatRegressionGateReport(result).replace(/\n/g, ' | ')}`);
    }
    // Não bloqueia por infraestrutura (sem runner, prazo, sandbox), mas o
    // "não verificado" fica explícito no handoff — nunca passa por aprovado.
    if (result.status === 'unavailable') {
      return { kind: 'accepted', artifact: artifactOf(result), unverified: true };
    }
    const recorded =
      result.status === 'passed' ||
      result.untestedFiles.length > 0 ||
      result.invariantsTouched.length > 0;
    return recorded ? { kind: 'accepted', artifact: artifactOf(result) } : { kind: 'accepted' };
  }
  const report = formatRegressionGateReport(result);
  const used = input.sessionId ? bouncesBySession.get(input.sessionId) ?? 0 : 0;
  if (input.returnable !== false && input.sessionId && used < REGRESSION_GATE_BOUNCES_PER_SESSION) {
    bouncesBySession.delete(input.sessionId);
    bouncesBySession.set(input.sessionId, used + 1);
    while (bouncesBySession.size > MAX_TRACKED_SESSIONS) {
      bouncesBySession.delete(bouncesBySession.keys().next().value!);
    }
    return {
      kind: 'retry',
      message:
        `handoff NÃO aceito pelo portão de regressão (devolução ${used + 1}/${REGRESSION_GATE_BOUNCES_PER_SESSION}).\n` +
        `${report}\nCorrija e envie o handoff de novo.`,
    };
  }
  if (input.sessionId) bouncesBySession.delete(input.sessionId);
  return { kind: 'exhausted', artifact: artifactOf(result), report };
}
