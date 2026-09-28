/**
 * Portão de regressão no handoff de escrita (missão e "+ Pane"). Mesmo
 * padrão do contrato de entrega e da revisão Jev: diff que quebra teste
 * impactado devolve o handoff ao agente com as falhas (`retry` → o tool lança
 * e o agente recebe o erro); esgotadas as devoluções, o handoff entra como
 * `blocked` com as falhas em artifact — nunca como `success`.
 */
import type { ProjectExecutionScope } from '../../shared/types';
import type { McpToolInvocation } from '../orch/mcp-protocol';
import {
  formatRegressionGateReport,
  isRegressionGateEnabled,
  runRegressionGate,
  type RegressionGateDependencies,
  type RegressionGateResult,
} from './regression-gate';

export const REGRESSION_GATE_BOUNCES_PER_SESSION = 2;
/**
 * Orçamento TOTAL do portão no handoff (mapa + testes + retentativa): abaixo
 * do `tool_timeout_sec=120` do Codex, senão o worker vê erro de tool enquanto
 * o servidor consome a devolução (ou persiste o handoff) sem ele saber.
 */
export const HANDOFF_REGRESSION_BUDGET_MS = 100_000;
/** Prefixo no resumo quando os testes impactados não rodaram. */
export const REGRESSION_UNVERIFIED_PREFIX = '[testes impactados não verificados]';
const MAX_TRACKED_SESSIONS = 512;

export interface RegressionGateArtifact {
  readonly kind: 'nexus.regressionGate';
  readonly payload: {
    readonly status: RegressionGateResult['status'];
    readonly diffHash: string;
    readonly headSha: string | null;
    readonly baseSha: string | null;
    readonly runner: RegressionGateResult['runner'];
    readonly testsRun: readonly string[];
    readonly testsNotRun: readonly string[];
    readonly failures: RegressionGateResult['failures'];
    readonly inheritedFailures: RegressionGateResult['inheritedFailures'];
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
    }
  | { readonly kind: 'exhausted'; readonly artifact: RegressionGateArtifact; readonly report: string };

const bouncesBySession = new Map<string, number>();

export function __resetRegressionHandoffBouncesForTests(): void {
  bouncesBySession.clear();
}

function artifactOf(result: RegressionGateResult): RegressionGateArtifact {
  return {
    kind: 'nexus.regressionGate',
    payload: {
      status: result.status,
      diffHash: result.diffHash,
      headSha: result.headSha,
      baseSha: result.baseSha,
      runner: result.runner,
      testsRun: result.testsRun.slice(0, 64),
      testsNotRun: result.testsNotRun.slice(0, 64),
      failures: result.failures.slice(0, 16),
      inheritedFailures: result.inheritedFailures.slice(0, 16),
      untestedFiles: result.untestedFiles.slice(0, 32),
      invariantsTouched: result.invariantsTouched.slice(0, 16),
      warnings: result.warnings.slice(0, 8),
    },
  };
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
    readonly signal?: AbortSignal;
    readonly authority?: McpToolInvocation;
    /** Checkout principal do projeto (escopo do Main): ver RunRegressionGateInput. */
    readonly trustedDependencyRoot?: string;
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
  let result: RegressionGateResult;
  try {
    result = await runRegressionGate(
      {
        scope: input.scope,
        projectScope: input.projectScope,
        declaredFiles: input.declaredFiles,
        baseSha: input.baseSha,
        startedAtMs: input.startedAtMs,
        timeoutMs: HANDOFF_REGRESSION_BUDGET_MS,
        signal: input.signal,
        authority: input.authority,
        trustedDependencyRoot: input.trustedDependencyRoot,
      },
      deps,
    );
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
