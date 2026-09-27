// POST /hook/regression — portão de regressão no fim do turno do pane do
// operador sem missão (hook `Stop`, Claude e Codex). Mesmo servidor loopback
// e bearer do /hook/delegate. Se o diff do checkout mudou desde o último
// relato e um teste impactado falhou, responde `decision: "block"` com as
// falhas: o agente continua e corrige antes de encerrar. Missão e helpers
// passam pelo portão no handoff; aqui é só o pane "+" do operador.
//
// Anti-laço: o mesmo diff (hash do conteúdo) é relatado uma vez; no máximo
// {@link MAX_CONSECUTIVE_STOP_BLOCKS} bloqueios seguidos sem um verde. Fora
// do caminho feliz, sempre `{}` com 200 — o hook nunca atrapalha o CLI.
import type http from 'node:http';
import type { AgentGateContext } from './gate';
import { handleHookJsonPost } from './hook-http';
import {
  formatRegressionGateReport,
  isRegressionGateEnabled,
  runRegressionGate,
} from '../regression-gate/regression-gate';
import { ProcessGitRunner, type GitRunner } from '../runtime/git-command';

export const HOOK_REGRESSION_MAX_BODY_BYTES = 64 * 1024;
export const MAX_CONSECUTIVE_STOP_BLOCKS = 3;
const STOP_HOOK_TEST_TIMEOUT_MS = 120_000;

type HookContext = Pick<AgentGateContext, 'role' | 'missionId' | 'sessionId'> &
  Partial<Pick<AgentGateContext, 'scope' | 'executionScope' | 'providerId' | 'readOnly'>>;

interface SessionLedger {
  /** HEAD visto no último Stop: commits feitos depois entram no diff. */
  lastHead?: string;
  /** Último diff já relatado ao agente (não repete o mesmo aviso). */
  reportedHash?: string;
  blocks: number;
}

const ledgers = new Map<string, SessionLedger>();

export function __resetHookRegressionForTests(): void {
  ledgers.clear();
}

function headSha(git: GitRunner, root: string): string | undefined {
  try {
    const result = git.run(root, ['rev-parse', '--verify', 'HEAD^{commit}'], { allowFailure: true });
    const sha = result.stdout.trim().toLowerCase();
    return result.status === 0 && /^[a-f0-9]{40,64}$/u.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

export async function handleHookRegressionRequest(
  ctx: HookContext,
  body: unknown,
  deps: {
    readonly run?: typeof runRegressionGate;
    readonly enabled?: () => boolean;
    readonly git?: GitRunner;
  } = {},
): Promise<{ statusCode: 200; payload: Record<string, unknown> }> {
  void body;
  try {
    if (ctx.role !== 'user' || ctx.missionId || ctx.readOnly === true || !ctx.sessionId) {
      return { statusCode: 200, payload: {} };
    }
    if (!(deps.enabled ?? isRegressionGateEnabled)()) return { statusCode: 200, payload: {} };
    const scope = ctx.executionScope ?? ctx.scope;
    if (!scope) return { statusCode: 200, payload: {} };
    const git = deps.git ?? new ProcessGitRunner();
    const ledger = ledgers.get(ctx.sessionId) ?? { blocks: 0 };
    ledgers.set(ctx.sessionId, ledger);
    const head = headSha(git, scope.rootRealPath);
    const result = await (deps.run ?? runRegressionGate)({
      scope,
      baseSha: ledger.lastHead && ledger.lastHead !== head ? ledger.lastHead : undefined,
      timeoutMs: STOP_HOOK_TEST_TIMEOUT_MS,
    });
    ledger.lastHead = head;
    if (result.status === 'clean' || result.diffHash === ledger.reportedHash) {
      return { statusCode: 200, payload: {} };
    }
    ledger.reportedHash = result.diffHash;
    const report = formatRegressionGateReport(result);
    if (result.status === 'failed') {
      if (ledger.blocks >= MAX_CONSECUTIVE_STOP_BLOCKS) {
        console.warn(`[regression-gate] limite de bloqueios no Stop atingido: ${report.replace(/\n/g, ' | ')}`);
        return { statusCode: 200, payload: {} };
      }
      ledger.blocks += 1;
      return { statusCode: 200, payload: { decision: 'block', reason: report } };
    }
    ledger.blocks = 0;
    if (
      result.untestedFiles.length === 0 &&
      result.invariantsTouched.length === 0 &&
      result.warnings.length === 0
    ) {
      return { statusCode: 200, payload: {} };
    }
    console.info(`[regression-gate] ${report.replace(/\n/g, ' | ')}`);
    // Aviso (área sem teste, invariante tocado) não bloqueia: o Claude o
    // mostra ao operador; o Codex fica só com o registro no log.
    return {
      statusCode: 200,
      payload: ctx.providerId === 'codex' ? {} : { systemMessage: report },
    };
  } catch {
    return { statusCode: 200, payload: {} };
  }
}

export async function handleHookRegressionHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AgentGateContext | null,
): Promise<void> {
  await handleHookJsonPost(req, res, ctx, HOOK_REGRESSION_MAX_BODY_BYTES, (body) =>
    handleHookRegressionRequest(ctx!, body),
  );
}
