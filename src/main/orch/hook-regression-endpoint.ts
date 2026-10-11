// POST /hook/regression — portão de regressão no fim do turno do pane do
// operador sem missão (hook `Stop`: Claude, Codex, Kimi e Grok). Mesmo servidor loopback
// e bearer do /hook/delegate. Se o diff do checkout mudou desde o último
// relato e um teste impactado falhou, responde `decision: "block"` com as
// falhas: o agente continua e corrige antes de encerrar. Missão e helpers
// passam pelo portão no handoff; aqui é só o pane "+" do operador — inclusive
// depois de promovido a orquestrador (missão sob demanda do primeiro helper):
// o diff dele não tem handoff que o verifique.
//
// Anti-laço: o mesmo diff (hash do conteúdo) é relatado uma vez; no máximo
// {@link MAX_CONSECUTIVE_STOP_BLOCKS} bloqueios seguidos sem um verde. Fora
// do caminho feliz, sempre `{}` com 200 — o hook nunca atrapalha o CLI.
// Árvore limpa zera a sequência de bloqueios.
import type http from 'node:http';
import type { AgentGateContext } from './gate';
import { isOperatorHandContext } from './operator-hand-context';
import { sendHookJson } from './hook-http';
import {
  formatRegressionGateReport,
  isRegressionGateEnabled,
  runRegressionGate,
} from '../regression-gate/regression-gate';
import { ProcessGitRunner, type GitRunner } from '../runtime/git-command';
import { getSessionSpawnedAtMs } from '../pty/pty-manager';
import { recordedEditsForSession } from './hook-edit-provenance';

export const MAX_CONSECUTIVE_STOP_BLOCKS = 3;
/**
 * Orçamento TOTAL do portão no Stop (mapa + testes + retentativa), bem abaixo
 * do `--max-time` do curl: resposta que chega depois do transporte desistir
 * é bloqueio perdido. Também é quanto o fim do turno pode esperar.
 */
export const STOP_HOOK_BUDGET_MS = 60_000;
const STOP_HOOK_MAX_TEST_FILES = 20;
const MAX_LEDGERS = 256;

type HookContext = Pick<AgentGateContext, 'role' | 'missionId' | 'sessionId'> &
  Partial<Pick<AgentGateContext,
    'scope' | 'executionScope' | 'providerId' | 'readOnly' | 'readOnlyEnforced' | 'operatorParentSessionId' | 'promotedFromUserSession'>>;

interface SessionLedger {
  /** Sem spawn conhecido: o primeiro HEAD visto é a base da sessão. */
  firstHead?: string;
  /** Último diff já relatado ao agente (não repete o mesmo aviso). */
  reportedHash?: string;
  blocks: number;
}

const ledgers = new Map<string, SessionLedger>();

export function __resetHookRegressionForTests(): void {
  ledgers.clear();
}

function ledgerFor(sessionId: string): SessionLedger {
  const existing = ledgers.get(sessionId);
  if (existing) {
    // LRU: sessão ativa vai para o fim; as mais antigas saem primeiro.
    ledgers.delete(sessionId);
    ledgers.set(sessionId, existing);
    return existing;
  }
  const created: SessionLedger = { blocks: 0 };
  ledgers.set(sessionId, created);
  while (ledgers.size > MAX_LEDGERS) ledgers.delete(ledgers.keys().next().value!);
  return created;
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
    readonly startedAtMs?: (sessionId: string) => number | null;
    /** F-1237: edições registradas da conversa retomada por esta sessão. */
    readonly recordedEdits?: (sessionId: string, rootRealPath: string) => ReadonlyMap<string, string> | undefined;
    /** Abortado quando o transporte do hook desistiu (curl fechou). */
    readonly signal?: AbortSignal;
  } = {},
): Promise<{ statusCode: 200; payload: Record<string, unknown> }> {
  void body;
  try {
    // Helper do "+ Pane" (tem pai operador) e workers de missão já passam
    // pelo portão no handoff.
    // F-1157: só a lane que o Hardened confina à leitura não escreve.
    if (!isOperatorHandContext(ctx) || ctx.readOnlyEnforced === true || !ctx.sessionId || ctx.operatorParentSessionId) {
      return { statusCode: 200, payload: {} };
    }
    if (!(deps.enabled ?? isRegressionGateEnabled)()) return { statusCode: 200, payload: {} };
    const scope = ctx.executionScope ?? ctx.scope;
    if (!scope) return { statusCode: 200, payload: {} };
    const ledger = ledgerFor(ctx.sessionId);
    const startedAtMs = (deps.startedAtMs ?? getSessionSpawnedAtMs)(ctx.sessionId) ?? undefined;
    if (startedAtMs === undefined) {
      ledger.firstHead ??= headSha(deps.git ?? new ProcessGitRunner(), scope.rootRealPath);
    }
    const result = await (deps.run ?? runRegressionGate)({
      scope,
      projectScope: ctx.scope,
      startedAtMs,
      // F-1237: pane retomado responde pelo que a própria conversa editou.
      recordedEdits: (deps.recordedEdits ?? recordedEditsForSession)(ctx.sessionId, scope.rootRealPath),
      baseSha: startedAtMs === undefined ? ledger.firstHead : undefined,
      timeoutMs: STOP_HOOK_BUDGET_MS,
      maxTestFiles: STOP_HOOK_MAX_TEST_FILES,
      signal: deps.signal,
      // Escopo do Main (checkout do projeto), nunca o de execução.
      trustedDependencyRoot: ctx.scope?.rootRealPath,
    });
    // Ninguém mais escuta: não gasta o relato nem a cota de bloqueios.
    if (deps.signal?.aborted) return { statusCode: 200, payload: {} };
    if (result.status === 'clean') {
      // Árvore limpa encerra a sequência de bloqueios.
      ledger.blocks = 0;
      ledger.reportedHash = undefined;
      return { statusCode: 200, payload: {} };
    }
    if (result.diffHash === ledger.reportedHash) return { statusCode: 200, payload: {} };
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
    // Aviso (não verificado, área sem teste, invariante tocado) não bloqueia:
    // o Claude o mostra ao operador; o Codex fica só com o registro no log.
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
  deps: Omit<NonNullable<Parameters<typeof handleHookRegressionRequest>[2]>, 'signal'> = {},
): Promise<void> {
  if (!ctx) {
    sendHookJson(res, 401, { ok: false, error: 'missing or unknown bearer token' });
    return;
  }
  if (req.method !== 'POST') {
    sendHookJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }
  // O corpo do Stop (última mensagem do agente) não é usado: é drenado sem
  // teto. Com o teto dos outros hooks, uma resposta longa virava 400 e o
  // `curl … || true` desligava o portão em silêncio.
  await new Promise<void>((resolve) => {
    req.once('end', resolve);
    req.once('error', () => resolve());
    req.resume();
  });
  // O curl desiste no `--max-time` do hook: conexão fechada
  // antes da resposta cancela os testes (o grupo de processos morre junto).
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const result = await handleHookRegressionRequest(ctx, {}, { ...deps, signal: controller.signal });
  sendHookJson(res, result.statusCode, result.payload);
}
