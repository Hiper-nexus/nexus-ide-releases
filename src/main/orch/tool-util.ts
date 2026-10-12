import type { SystemInputWriter } from './operator-input-receipts';
import { commitWorkerContinuation, workerContinuationBirthState, type WorkerContinuationBirthState } from './mission-pane-resume-ownership';
import { createVisualTaskRequirement, visualTaskRequirement } from './visual-handoff-gate';
import { assertLicensedAgentCapacity, licensedAgentCount } from '../license-enforcement';
import { licenseErrorFrom } from '../../shared/license-errors';
import { withWorkspaceDesignRule } from './workspace-design-rule';
import { mountPromptContextBlocks } from './prompt-context-blocks';
import {
  businessModelContextBlock,
  taskBusinessContextBlock,
} from '../context/business-model/business-model-context-block';
import { ensureBusinessModel } from '../context/business-model/business-model-ensure';
import type { SpawnRouteInfo } from '../../shared/spawn-route';
import {
  getPaneAuthzInfo,
  callerWithPaneOwner,
  listLivePaneNumbers,
  readSessionOutput,
  requestPaneClose,
  requestPaneSpawn,
  waitForIdle,
  listPaneSnapshots,
  pendingSpawnAttemptSession,
} from './pane-registry';
import { parsePaneNumberRef } from '../../shared/pane-number';
import {
  authorizePaneAccess,
  type PaneAction,
  type PaneAuthzInfo,
} from './pane-authz';
import type { AgentGateContext } from './gate';
import {
  countLiveAgentSessions,
  getAgentSessionInfo,
  hasAcceptedNativeArgvPrompt,
  getSessionState,
  isSessionStdinWritable,
  orchTerminateSession,
  orchWriteSession,
  tapSessionData,
  tapSessionExit,
  tapSessionState,
} from '../pty/pty-manager';
import {
  proveWriterConnectedAndWritable,
  writerCircuitBreakEvent,
  writerCircuitBreakers,
} from './writer-circuit-break';
import { trace } from '../observability/main-trace';
import type { PhaseTimer } from '../observability/phase-timer';
import { emitWorkerSpawnFailed } from './spawn-fail-events';
import { notePaneStartAccepted, notePaneStartFailure } from './pane-start-watchdog';
import { admitToolSpawnSync } from './pane-admission';
import { getAdapter } from '../adapters/adapter-registry';
import { discoverCliModels } from '../adapters/cli-model-discovery';
import {
  isRoutableModelResolution,
  resolveRoutableModel,
} from './task-router';
import { getProjectDomainStores } from './project-domain-store-registry';
import { getAcpDriverSession } from '../acp/acp-harness-driver';
import { sameProjectScope } from './project-scoped-broadcast';
import { hasBoundHandoffForExactDispatchWorker } from './task-dispatch-codec';
import { migrateModelId } from '../../shared/model-defaults';
import { resolveCwdForScope } from './workspace-path';
import { withHandoffContract } from './worker-handoff-contract';
import { hasNexusBrowserAlternative } from './nexus-browser-policy';
import {
  assertReleaseQualifiedMissionWorkerSpawn,
  isRevisionBoundWritableWorkerAdapterAllowed,
} from './mission-worker-spawn-authority';
import { waitOutBootPrompts } from './boot-prompt-hold';
import { cliPromptAutoResponder } from './cli-prompt-autoresponder';
import { adapterCircuitBreakers } from './circuit-breaker';
import { assertPreSpawnProbe } from '../pty/pre-spawn-probe';
import { classifySeatAuth } from '../adapters/seat-auth-readiness';
import { detectSubscriptionAuthReadiness } from '../adapters/subscription-auth';
import {
  hasRuntimeKey,
  providerAuthStrategy,
  providerReadiness,
} from '../persistence/provider-config-store';
import {
  isCredentialProbeFailure,
  settleSeatAfterCredentialFailure,
} from './spawn-seat-fallback';
import { assertSafePtyPrompt } from './pty-prompt-safety';
import {
  getAgentSemanticStatusBySession,
  getAgentTurnStartSequence,
  isSessionInjectableIdle,
  tapAgentTurnStart,
} from './agent-status';
import { listSquads } from './squad-store';
import { resolveMissionPaneAuthoritySeal, sameMissionPaneAuthoritySeal } from './mission-pane-authority';
import {
  assertMcpInvocationCurrent,
  type McpToolInvocation,
} from './mcp-protocol';
import { emitMissionEvent } from './mission-event-emit';
import type { MissionPaneAuthoritySeal } from '../../shared/orch-types';
import { sanitizeMissionOrchestratorExitOutput } from './mission-orchestrator-exit-policy';
import {
  autoRecallPhaseForAgent,
  workspaceMemoryContextBlock,
} from '../memory/workspace-memory-context';
import { getOrchSettings } from '../persistence/settings-store';
import { isOperatorChoicePolicy } from '../../shared/squad-cli-policy';
import { issueAgentIdentityBestEffort } from './agent-identity-spawn';
import {
  initialPromptChannel,
  spawnBinaryName,
} from '../../shared/cli-initial-prompt';
import { ORCH_SPAWN_GRANT_TTL_MS } from './orch-spawn-grant-recovery';
import {
  PASTE_INGEST_GRACE_MS,
  pasteIngestPlanForSession,
  watchPasteIngest,
  type PasteIngestWatch,
} from './paste-ingest';

export { assertSafePtyPrompt } from './pty-prompt-safety';

/** Shared argument helpers + pane-spawn plumbing for the MCP toolset. */

// Interactive agent editors need one repaint after bracketed paste before
// Enter. Claude and Codex both exhibit swallowed submits below ~500 ms on a
// cold TUI; Orca uses the same bounded settle without weakening acceptance
// proof or any authority recheck.
const PROMPT_SETTLE_MS = 500;
/** Janela para provar o submit: sessão ainda idle depois disto → CR comido. */
const ENTER_RETRY_MS = 400;
/**
 * F-1282: depois da escada fixa de Enters, UMA última tentativa quando a
 * saída assenta (sem bytes novos por este prazo) e a sessão segue idle — a
 * TUI que engoliu os Enters enquanto ingeria a colagem só aceita submit
 * depois de acalmar (Kimi 30 min com o brief colado, campo 11/10).
 */
export const ENTER_CALM_QUIESCE_MS = 800;
/** Teto da fase calma a partir do arme do resgate: vencido, desiste. */
export const ENTER_CALM_RETRY_MAX_MS = 20_000;
// Wait for the CLI's first idle before typing. Expiring early types the brief
// into a terminal that is still booting, so the prompt is swallowed and the
// pane sits idle while every watchdog waits for a busy transition.
const AGENT_BOOT_TIMEOUT_MS = 120_000;
/**
 * After a brief is typed, the session must report busy within this window.
 * A still-idle session means a dialog with no autoresponder signature ate the
 * paste — re-deliver instead of letting the pane sit idle (every watchdog is
 * blind to idle panes: stall needs busy, login-stuck needs a busy transition).
 */
const PROMPT_ACCEPTANCE_WINDOW_MS = 12_000;
/** Devin composer footer (herdr welcome_prompt_footer) before PTY paste. */
const DEVIN_COMPOSER_READY = /ask devin to build/i;
/** Kimi Code's composer footer; migration/trust menus have no context meter. */
const KIMI_COMPOSER_READY = /\bcontext:\s*\d+(?:\.\d+)?%/i;
/**
 * Qwen Code (fork do Gemini CLI) — mesma assinatura do manifesto Herdr
 * `resources/agent-detection/qwen.toml` (regra composer_idle). A tela de
 * "Connect a Provider" (sem credencial) não casa, então a entrega espera.
 */
const QWEN_COMPOSER_READY = /type your message|@path\/to\/file/i;
/**
 * F-742: rodapé do composer do MiMo Code (0.1.15). Retomada cola o brief
 * depois do boot; colado antes da TUI, ele caía no aviso de bypass e o `\n`
 * confirmava "No, exit". O rodapé só existe com a TUI de pé.
 */
const MIMO_COMPOSER_READY = /tab\s*switch\s*mode/i;
function composerLabel(adapterId: string | undefined): string {
  switch (adapterId) {
    case 'kimi':
      return 'Kimi';
    case 'qwen':
      return 'Qwen';
    case 'mimo-code':
      return 'MiMo';
    default:
      return 'Devin';
  }
}
/** Cold Node boot + trust + welcome paint can exceed 8s; never paste blind. */
const PASTE_COMPOSER_WAIT_MS = 30_000;
/**
 * F-230: o regex do composer casa no meio do quadro inicial (Devin pinta
 * "Ask Devin to build", Kimi a barra `context: 0%`) enquanto o PTY ainda está
 * `busy`. Sem esperar a borda de idle, as duas tentativas de entrega queimavam
 * em milissegundos sem escrever um byte e o pane era fechado como "did not
 * start". Espera limitada pelo PTY ficar injetável antes de cada tentativa.
 */
const INJECTABLE_IDLE_WAIT_MS = 15_000;
const RESTORED_PROMPT_ACCEPTANCE_WINDOW_MS = 3_000;
/**
 * After a provider-native argv brief, the provider must open a turn within
 * this window once boot settles. Codex uses its interactive positional
 * prompt, AGY uses `--prompt-interactive`, and OpenCode mission workers use
 * its headless `run` transport so a provider TUI cannot swallow the sealed
 * dispatch before prompt acceptance.
 */
const NATIVE_ARGV_PROMPT_ACTIVITY_WINDOW_MS = 30_000;
/**
 * A lone TUI repaint flips the pane busy for about one idle timeout. A real
 * turn start streams output (or stays busy) — require that confirmation
 * before the argv brief counts as accepted.
 */
const NATIVE_ARGV_ACTIVITY_CONFIRM_MS = 4_000;
const MAX_NATIVE_INITIAL_PROMPT_BYTES = 64 * 1024;
const CLAUDE_FAMILY_TURN_PROOF_ADAPTERS = new Set([
  'claude',
  'glm',
  'glm-flash',
  'longcat',
  'deepseek',
]);

function requiresClaudeFamilyTurnProof(adapterId: string | undefined): boolean {
  if (!adapterId) return false;
  if (CLAUDE_FAMILY_TURN_PROOF_ADAPTERS.has(adapterId)) return true;
  const adapter = getAdapter(adapterId);
  return adapter?.kind === 'cli-pty'
    ? spawnBinaryName(adapter.spawn.interactive) === 'claude'
    : false;
}

function agentBootExitError(sessionId: string): Error {
  const outputTail = sanitizeMissionOrchestratorExitOutput(
    readSessionOutput(sessionId, 80),
  );
  const error = new Error(
    `agent session exited during boot before prompt acceptance\n` +
      `PTY tail:\n${outputTail}`,
  );
  // The scheduler may legitimately compensate and replace a failed worker.
  // Preserve the bounded, credential-redacted physical cause in Main's log
  // before that retry overwrites the dispatch row and closes the dead pane.
  console.error(`[spawn] agent boot failed (${sessionId}):\n${error.message}`);
  return error;
}

function logAgentPromptFailure(
  adapterId: string,
  sessionId: string,
  error: unknown,
): void {
  const outputTail = sanitizeMissionOrchestratorExitOutput(
    readSessionOutput(sessionId, 80),
  );
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `[spawn] agent prompt failed (${adapterId}/${sessionId}): ${message}\n` +
      `PTY tail:\n${outputTail}`,
  );
}

/**
 * F-230: falha de entrega de worker de missão vira evento do journal com a
 * cauda sanitizada do PTY (mesma política do Maestro em mission-store). O
 * trace main.trace.ndjson continua sem texto de processo (F-212).
 */
function recordWorkerPromptDeliveryFailure(input: {
  readonly scope: SpawnToolOptions['scope'];
  readonly missionId?: string;
  readonly paneId: string;
  readonly sessionId: string | null;
  readonly adapterId: string;
  readonly error: unknown;
}): void {
  if (!input.missionId) return;
  try {
    const message =
      input.error instanceof Error ? input.error.message : String(input.error);
    emitMissionEvent(input.scope, {
      missionId: input.missionId,
      runId: `spawn:${input.missionId}`,
      type: 'custom',
      origin: 'system',
      payload: {
        kind: 'worker-prompt-delivery-failed',
        paneId: input.paneId,
        sessionId: input.sessionId ?? '',
        adapterId: input.adapterId,
        reason: sanitizeMissionOrchestratorExitOutput(message),
        outputTail: input.sessionId
          ? sanitizeMissionOrchestratorExitOutput(
              readSessionOutput(input.sessionId, 80),
            )
          : '[sem sessão]',
      },
      idempotencyKey: `worker-prompt-failed:${input.sessionId ?? input.paneId}`,
      occurredAt: Date.now(),
    });
  } catch {
    // Best-effort: o erro original é o que importa para o chamador.
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function str(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function num(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

export function requireStr(args: Record<string, unknown>, key: string): string {
  const value = str(args, key);
  if (!value) throw new Error(`missing required argument: ${key}`);
  return value;
}

export function strArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * Recusa NOMEADA para um alvo que não resolve. Quando o agente citou um
 * número, a mensagem lista os números válidos — recusar dizendo qual era a
 * opção certa é barato; mandar trabalho para o terminal errado não tem volta.
 * Por isso não existe fallback para "o pane focado" em lugar nenhum.
 */
/**
 * F-241: quando o agente cita um paneId que não existe, a saída é o inventário
 * dos panes VIVOS da própria missão (até 8, nos estados ocupados — o Maestro
 * pode escrever neles imediatamente). Sem missão, aponta o `nexus_pane_list`.
 */
function unknownPaneIdDetail(ctx: AgentGateContext): string {
  if (!ctx.missionId) {
    return ' (nenhum pane vivo com esse id; use nexus_pane_list)';
  }
  const alive = listPaneSnapshots()
    .filter(
      (pane) =>
        pane.missionId === ctx.missionId &&
        (pane.state === 'busy' ||
          pane.state === 'idle' ||
          pane.state === 'spawning'),
    )
    .slice(0, 8);
  if (alive.length === 0) {
    return ' (nenhum pane vivo nesta missão; use nexus_pane_list)';
  }
  const inventory = alive
    .map(
      (pane) =>
        `${pane.paneId}${pane.paneNumber !== undefined ? ` #${pane.paneNumber}` : ''}` +
        ` ${pane.adapterId ?? 'shell'} ${pane.state}`,
    )
    .join(', ');
  return ` (panes vivos desta missão: ${inventory}; use nexus_pane_list para o inventário)`;
}

function unknownPaneMessage(paneRef: string, ctx?: AgentGateContext): string {
  // O navegador sobrevive à troca de projeto (fica afastado); se não resolve,
  // foi fechado. Sem a pista, o agente concluía que o Nexus o bloqueou e
  // pedia credenciais no chat (campo 26/09).
  if (paneRef.startsWith('browser-')) {
    return (
      `unknown pane: ${paneRef} (the browser pane was closed; open a new one ` +
      'with nexus_browser_open, which needs this project on screen in the ' +
      'Nexus window)'
    );
  }
  if (parsePaneNumberRef(paneRef) === null) {
    return `unknown pane: ${paneRef}` + (ctx ? unknownPaneIdDetail(ctx) : '');
  }
  const valid = listLivePaneNumbers();
  return valid.length === 0
    ? `unknown pane: ${paneRef} (no numbered pane is open)`
    : `unknown pane: ${paneRef} (valid pane numbers: ${valid.join(', ')})`;
}

/**
 * Object-level authorization gate for the pane tools (SEC#5): resolve a pane
 * ref and confirm `ctx` may perform `action` on it. Inside the caller's
 * mission any pane may read any other (including the orchestrator); workers
 * still cannot write/close the orchestrator or touch the user's shell. Browser
 * access requires the caller's Main-derived originating window and workspace.
 * Throws on unknown pane or refusal. Returns the pane info (session may be
 * dead — fine for `close`).
 *
 * `paneRef` accepts the paneId, the sessionId, or the short pane number the
 * operator reads in the header ("7", "pane 7"). The number is additive: the
 * paneId remains the protocol identity and is always accepted.
 */
export function authorizePaneRef(
  ctx: AgentGateContext,
  paneRef: string,
  action: PaneAction,
): PaneAuthzInfo {
  const info = getPaneAuthzInfo(paneRef);
  if (!info) throw new Error(unknownPaneMessage(paneRef, ctx));
  const caller = info.kind === 'browser' ? callerWithPaneOwner(ctx) : ctx;
  const decision = authorizePaneAccess(caller, info, action);
  if (!decision.allow) {
    throw new Error(`not authorized: ${decision.reason}`);
  }
  return info;
}

/** As authorizePaneRef, but also require a live session (read/write/wait). */
export function authorizedSessionIdOf(
  ctx: AgentGateContext,
  paneRef: string,
  action: PaneAction,
): string {
  const info = authorizePaneRef(ctx, paneRef, action);
  if (!info.sessionId) throw new Error(`pane ${paneRef} has no live session`);
  // 0.76.45: pane estacionado pelo guardian — o CLI foi encerrado, o pane e o
  // scrollback ficaram. Ler continua valendo; escrever/esperar exige acordar.
  if (action !== 'read') {
    const snapshot = listPaneSnapshots().find((pane) => pane.paneId === info.paneId);
    if (snapshot?.state === 'parked') {
      throw new Error(
        `pane ${paneRef} is parked (dormindo): the CLI was stopped to free memory and the ` +
          `conversation is kept. Wake it with nexus_pane_spawn { resume: "${info.paneId}" } ` +
          'or the "Acordar" button, then write again.',
      );
    }
  }
  return info.sessionId;
}

/** TUIs que não entendem bracketed paste: o marcador viraria texto (F-537). */
const NO_BRACKETED_PASTE_ADAPTERS: ReadonlySet<string> = new Set(['kimi', 'agy', 'devin']);

/**
 * Bytes que digitam o prompt. Briefs com várias linhas viram UMA colagem
 * (bracketed paste): como teclas soltas a TUI executa/repinta cada linha.
 * Em pane de AGENTE a colagem vale mesmo para uma linha só: o Codex trata
 * uma rajada de teclas cruas como paste-burst e o Enter que chega logo
 * depois vira quebra de linha no composer — o texto ficava digitado e nunca
 * era enviado (print do operador 27/09, gpt-6-sol).
 */
function injectedPromptInput(sessionId: string, safePrompt: string): string {
  const adapterId = getAgentSessionInfo(sessionId)?.adapterId;
  if (!adapterId) {
    return safePrompt.includes('\n') ? `\x1b[200~${safePrompt}\x1b[201~` : safePrompt;
  }
  if (NO_BRACKETED_PASTE_ADAPTERS.has(adapterId)) return safePrompt;
  // Linha única só vira colagem quando o adapter declara que aceita o
  // marcador (Codex); um adapter personalizado que recusa recebe texto cru.
  return safePrompt.includes('\n') || adapterAcceptsBracketedPaste(adapterId)
    ? `\x1b[200~${safePrompt}\x1b[201~`
    : safePrompt;
}

/** Capacidade declarada em `promptInjection.bracketedPaste`; a lista F-537 só cobre adapter sem declaração. */
function adapterAcceptsBracketedPaste(adapterId: string | undefined): boolean {
  if (!adapterId) return true;
  const adapter = getAdapter(adapterId);
  return (
    (adapter && adapter.kind === 'cli-pty' ? adapter.promptInjection?.bracketedPaste : undefined) ??
    !NO_BRACKETED_PASTE_ADAPTERS.has(adapterId)
  );
}

/**
 * F-735: arma, ANTES da escrita, a espera pela ingestão da colagem (Codex e
 * Devin no Windows engolem o Enter enquanto ingerem uma colagem grande). Null
 * = Enter no tempo de sempre.
 */
function armPasteIngest(sessionId: string, pasted: string): PasteIngestWatch | null {
  const plan = pasteIngestPlanForSession(sessionId, pasted);
  return plan ? watchPasteIngest(sessionId, plan) : null;
}

/** Type text into a pane's PTY, then press Enter (as a user would). */
export async function injectPrompt(
  sessionId: string,
  prompt: string,
  invocation?: McpToolInvocation,
  inputWriter: SystemInputWriter = 'nexus',
): Promise<void> {
  clearAdaptiveEnterTimers(sessionId);
  const safePrompt = assertSafePtyPrompt(prompt);
  const input = injectedPromptInput(sessionId, safePrompt);
  assertMcpInvocationCurrent(invocation);
  const ingest = armPasteIngest(sessionId, safePrompt);
  if (!orchWriteSession(sessionId, input, { markInputBusy: false, inputWriter })) {
    ingest?.cancel();
    throw new Error('session is gone');
  }
  await submitEnter(sessionId, invocation, undefined, false, ingest, inputWriter);
}

const adaptiveEnterTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();
const adaptiveEnterCleanups = new Map<string, () => void>();

export function clearAdaptiveEnterTimers(sessionId?: string): void {
  if (sessionId) {
    const cleanup = adaptiveEnterCleanups.get(sessionId);
    if (cleanup) {
      cleanup();
      adaptiveEnterCleanups.delete(sessionId);
    }
    const timers = adaptiveEnterTimers.get(sessionId);
    if (timers) {
      for (const t of timers) clearTimeout(t);
      adaptiveEnterTimers.delete(sessionId);
    }
  } else {
    for (const [, cleanup] of adaptiveEnterCleanups) {
      try { cleanup(); } catch {}
    }
    adaptiveEnterCleanups.clear();
    for (const [, timers] of adaptiveEnterTimers) {
      for (const t of timers) clearTimeout(t);
    }
    adaptiveEnterTimers.clear();
  }
}

/** A Kimi kickoff already pasted its brief; working echo is not a dialog. */
function isPromptRetryIdle(sessionId: string, requireInjectableIdle: boolean): boolean {
  if (getAgentSemanticStatusBySession(sessionId)?.status === 'awaiting-input') return false;
  if (!requireInjectableIdle) return getSessionState(sessionId) === 'idle';
  if (isSessionInjectableIdle(sessionId)) return true;
  return getAgentSessionInfo(sessionId)?.adapterId === 'kimi' &&
    getSessionState(sessionId) === 'idle' &&
    getAgentSemanticStatusBySession(sessionId)?.status === 'working';
}

function scheduleAdaptiveEnterRescue(
  sessionId: string,
  requireInjectableIdle = false,
  inputWriter: SystemInputWriter = 'nexus',
): void {
  clearAdaptiveEnterTimers(sessionId);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  adaptiveEnterTimers.set(sessionId, timers);

  const delays = [600, 1200, 2000];
  let idx = 0;
  /** F-1282: fase calma — escada acabou (ou viu busy), espera a TUI assentar. */
  let calm = false;
  const armedAt = Date.now();
  let lastDataAt = armedAt;
  // F-1282: turno que começou prova o submit (UserPromptSubmit nativo, F-735).
  // Sem turno novo, um busy foi só eco de colagem e o brief segue no composer.
  const turnStartBaseline = getAgentTurnStartSequence(sessionId);

  let untapExit: (() => void) | null = null;
  let untapState: (() => void) | null = null;
  let untapData: (() => void) | null = null;
  let untapTurnStart: (() => void) | null = null;

  const teardown = () => {
    untapExit?.();
    untapExit = null;
    untapState?.();
    untapState = null;
    untapData?.();
    untapData = null;
    untapTurnStart?.();
    untapTurnStart = null;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    adaptiveEnterTimers.delete(sessionId);
    adaptiveEnterCleanups.delete(sessionId);
  };

  adaptiveEnterCleanups.set(sessionId, teardown);

  untapExit = tapSessionExit((exitedSessionId) => {
    if (exitedSessionId === sessionId) teardown();
  });

  // Busy depois do Enter continua sendo prova de submit aceito (F-589): o
  // resgate para na hora para não duplicar um prompt que já pegou.
  untapState = tapSessionState((changedSessionId, state) => {
    if (changedSessionId === sessionId && state === 'busy') teardown();
  });

  untapData = tapSessionData((changedSessionId, _data) => {
    if (changedSessionId === sessionId) lastDataAt = Date.now();
  });

  // F-735: turno que começou (UserPromptSubmit nativo) também prova o aceite.
  untapTurnStart = tapAgentTurnStart((entry) => {
    if (entry.sessionId === sessionId && entry.sequence > turnStartBaseline) teardown();
  });

  function enterCalm(): void {
    if (calm) return;
    calm = true;
    scheduleCalmCheck();
  }

  function scheduleCalmCheck(): void {
    const nowMs = Date.now();
    if (nowMs - armedAt >= ENTER_CALM_RETRY_MAX_MS) {
      teardown();
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      // ponytail: a fase calma confia em "saída quieta + idle + nenhum turno
      // novo" — CLI sem UserPromptSubmit nativo e turno curto silencioso
      // levaria UM '\r\n' extra inócuo; o teto limita a janela.
      if (Date.now() - lastDataAt < ENTER_CALM_QUIESCE_MS) {
        scheduleCalmCheck();
        return;
      }
      if (
        getAgentTurnStartSequence(sessionId) > turnStartBaseline ||
        !isPromptRetryIdle(sessionId, requireInjectableIdle) ||
        getSessionState(sessionId) === 'busy'
      ) {
        teardown();
        return;
      }
      orchWriteSession(sessionId, '\r\n', { markInputBusy: false, inputWriter });
      teardown();
    }, Math.max(50, ENTER_CALM_QUIESCE_MS - (nowMs - lastDataAt)));
    if (typeof timer.unref === 'function') timer.unref();
    timers.add(timer);
  }

  function scheduleNext(): void {
    if (idx >= delays.length) {
      // F-1282: escada acabou sem prova nenhuma de aceite — a TUI pode ainda
      // estar ingerindo a colagem (Kimi 30 min com o brief colado). A fase
      // calma espera a saída assentar e reenvia UM Enter; teto de 20 s.
      enterCalm();
      return;
    }
    const delayMs = delays[idx++];
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (calm) return;
      const isIdleNow = isPromptRetryIdle(sessionId, requireInjectableIdle);
      if (!isIdleNow || getSessionState(sessionId) === 'busy') {
        teardown();
        return;
      }
      const enterKey = idx >= 2 ? '\r\n' : '\r';
      orchWriteSession(sessionId, enterKey, { markInputBusy: false, inputWriter });
      scheduleNext();
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    timers.add(timer);
  }

  scheduleNext();
}

/**
 * Submit the just-typed prompt. Some interactive CLIs consume the first CR
 * while leaving the pasted prompt in their editor (notably right after the
 * boot bypass/trust menus force-accepted by waitOutBootPrompts — the same
 * modal-transition failure idle-delivery guards against). A bounded second CR
 * is safe only while the session is still idle; once it turned busy the first
 * submit is proven and we stop.
 */
async function submitEnter(
  sessionId: string,
  invocation?: McpToolInvocation,
  onBeforeSubmit?: () => boolean | void,
  requireInjectableIdle = false,
  ingest: PasteIngestWatch | null = null,
  inputWriter: SystemInputWriter = 'nexus',
): Promise<void> {
  let observedBusy = getSessionState(sessionId) === 'busy';
  const untapState = tapSessionState((changedSessionId, state) => {
    if (changedSessionId === sessionId && state === 'busy') {
      observedBusy = true;
      clearAdaptiveEnterTimers(sessionId);
    }
  });
  try {
    const settled = delay(PROMPT_SETTLE_MS);
    // F-735: o Enter só sai depois que a TUI aceitou a colagem inteira.
    if (ingest && (await ingest.done) === 'marker') {
      await delay(PASTE_INGEST_GRACE_MS);
    }
    await settled;
    if (requireInjectableIdle && !isSessionInjectableIdle(sessionId)) {
      // After bracketed paste some CLIs flip to busy/semantic non-idle before
      // Enter; that is progress, not a permission modal. Only fail closed when
      // the session is still not busy and never observed a busy edge.
      const state = getSessionState(sessionId);
      const semanticStatus = getAgentSemanticStatusBySession(sessionId)?.status;
      // F-926: só um diálogo real (awaiting-input) impede o Enter — escrever
      // ali iria para o lugar errado. Semantic `working` com o PTY em idle
      // depois da colagem é o composer segurando o brief: Devin (SWE-2) e
      // Kimi (05/10) ficavam com o prompt COLADO e sem o Enter final até o
      // orquestrador digitar à mão. O estado idle + colagem já é prova
      // suficiente para submeter.
      if (semanticStatus === 'awaiting-input') {
        throw new Error('agent pane is awaiting operator input');
      }
      if (state !== 'busy' && !observedBusy && state !== 'idle') {
        throw new Error('agent pane is awaiting operator input');
      }
    }
    assertMcpInvocationCurrent(invocation);
    if (onBeforeSubmit?.() === false) return;
    // Paste-echo busy during settle is not proof that Enter was accepted.
    // Reset observedBusy right before sending Enter so only a busy transition
    // occurring AFTER Enter is treated as proof that Enter was accepted!
    let enterAcceptedBusy = false;
    const untapEnterBusy = tapSessionState((changedSessionId, state) => {
      if (changedSessionId === sessionId && state === 'busy') {
        enterAcceptedBusy = true;
        clearAdaptiveEnterTimers(sessionId);
      }
    });
    try {
      const firstEnter = orchWriteSession(sessionId, '\r', { markInputBusy: false, inputWriter });
      if (!firstEnter) {
        throw new Error('agent prompt Enter was not delivered to the PTY');
      }
      await delay(ENTER_RETRY_MS);
      const isIdleNow = isPromptRetryIdle(sessionId, requireInjectableIdle);
      if (!enterAcceptedBusy && isIdleNow) {
        assertMcpInvocationCurrent(invocation);
        if (onBeforeSubmit?.() === false) return;
        const secondEnter = orchWriteSession(sessionId, '\r', { markInputBusy: false, inputWriter });
        if (!secondEnter) {
          throw new Error('agent prompt Enter was not delivered to the PTY');
        }
        // F-589: Se o pane continua idle após 2 Enters, agenda resgate adaptativo
        // progressivo (600ms, 1200ms, 2000ms) com \r\n para acordar CLIs
        // que ainda estavam processando o paste ou repintando a TUI sob carga
        // alta. F-1282: esgotada a escada sem busy nem turno, a fase calma
        // espera a TUI assentar e reenvia UM Enter (Kimi 30 min colado).
        scheduleAdaptiveEnterRescue(sessionId, requireInjectableIdle, inputWriter);
      }
    } finally {
      untapEnterBusy();
    }
  } catch (error) {
    if (invocation) {
      let authorityLost = false;
      try {
        assertMcpInvocationCurrent(invocation);
      } catch {
        authorityLost = true;
      }
      if (authorityLost) {
        const exited = invocation.retireRevokedPrompt
          ? await invocation.retireRevokedPrompt(sessionId)
          : await orchTerminateSession(sessionId, { origin: 'tool-util:authority-revoked' });
        if (!exited) {
          throw new Error(
            'session_authority_revoked; pasted prompt could not be cleared ' +
              'because physical session exit was not proven',
          );
        }
      }
    }
    throw error;
  } finally {
    ingest?.cancel();
    untapState();
  }
}

/** Type a multi-line prompt as one bracketed-paste transaction. */
export async function injectPastedPrompt(
  sessionId: string,
  prompt: string,
  invocation?: McpToolInvocation,
  inputWriter: SystemInputWriter = 'nexus',
): Promise<void> {
  clearAdaptiveEnterTimers(sessionId);
  const safePrompt = assertSafePtyPrompt(prompt);
  assertMcpInvocationCurrent(invocation);
  const ingest = armPasteIngest(sessionId, safePrompt);
  if (!orchWriteSession(
    sessionId,
    `\x1b[200~${safePrompt}\x1b[201~`,
    { markInputBusy: false, inputWriter },
  )) {
    ingest?.cancel();
    throw new Error('session is gone');
  }
  await submitEnter(sessionId, invocation, undefined, false, ingest, inputWriter);
}

async function assertAcceptedPromptAuthority(
  sessionId: string,
  invocation?: McpToolInvocation,
): Promise<void> {
  try {
    assertMcpInvocationCurrent(invocation);
  } catch (error) {
    const exited = invocation?.retireRevokedPrompt
      ? await invocation.retireRevokedPrompt(sessionId)
      : await orchTerminateSession(sessionId, { origin: 'tool-util:authority-revoked' });
    if (!exited && getSessionState(sessionId) !== null) {
      throw new Error(
        'session_authority_revoked; accepted turn could not be fenced ' +
          'because physical session exit was not proven',
      );
    }
    throw error;
  }
}

/**
 * Execute one prompt injection while observing the complete idle→busy edge.
 * The observer is armed BEFORE submitEnter's 400 ms retry delay: polling only
 * after injectPrompt returned missed fast turns that became busy and idle
 * inside that delay, then re-sent an already completed prompt.
 */
async function injectWithBusyProof(
  sessionId: string,
  prompt: string,
  windowMs: number,
  invocation?: McpToolInvocation,
  requireTurnStartProof = false,
  canSubmit?: () => boolean,
): Promise<boolean> {
  // Never interleave a brief with boot or a turn already in progress. The
  // caller may retry only after an actual idle snapshot/edge.
  if (!isSessionInjectableIdle(sessionId)) return false;
  let observedBusy = false;
  let postSubmitBusy = false;
  let observedOutput = false;
  let observedOutputChunks = 0;
  let submitted = false;
  let sessionExited = false;
  let turnStartBaseline = getAgentTurnStartSequence(sessionId);
  let turnStartObserved = false;
  let sustainedPhysicalTurn = false;
  let physicalConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  let settle: ((accepted: boolean) => void) | null = null;
  // F-735: o UserPromptSubmit nativo (Codex, Kimi…) também prova o aceite —
  // é exatamente o turno que o Enter abriu, sem depender do busy do PTY.
  const hasAcceptanceProof = () =>
    requireTurnStartProof
      ? turnStartObserved || sustainedPhysicalTurn
      : turnStartObserved ||
        ((postSubmitBusy || (submitted && observedBusy)) && observedOutput);
  const maybeAccept = () => {
    if (hasAcceptanceProof()) settle?.(true);
  };
  const armPhysicalTurnConfirmation = () => {
    if (
      !requireTurnStartProof ||
      !submitted ||
      !observedBusy ||
      observedOutputChunks < 2 ||
      physicalConfirmTimer ||
      sustainedPhysicalTurn
    ) {
      return;
    }
    physicalConfirmTimer = setTimeout(() => {
      physicalConfirmTimer = null;
      // Claude installations with broken UserPromptSubmit hook wiring still
      // expose a real turn physically: multiple post-submit PTY chunks plus a
      // sustained busy state. Requiring both rejects paste echoes and the
      // one-frame/plugin-bootstrap repaint covered by the tests below.
      if (
        getSessionState(sessionId) === 'busy' &&
        observedOutputChunks >= 2
      ) {
        sustainedPhysicalTurn = true;
        maybeAccept();
      }
    }, NATIVE_ARGV_ACTIVITY_CONFIRM_MS);
  };
  const untapState = tapSessionState((changedSessionId, state) => {
    // Count busy even before submitted flips — paste can auto-start the turn.
    if (changedSessionId !== sessionId) return;
    if (state === 'busy') {
      observedBusy = true;
      if (submitted) {
        postSubmitBusy = true;
        armPhysicalTurnConfirmation();
        maybeAccept();
      }
    } else if (state === 'idle' && physicalConfirmTimer) {
      clearTimeout(physicalConfirmTimer);
      physicalConfirmTimer = null;
    }
  });
  // F-764 C.1: `immediate` — conta CHUNKS e depende da ordem exata com o
  // submit; é O(1) por chunk e nunca lê o texto.
  const untapData = tapSessionData((changedSessionId, data) => {
    if (
      changedSessionId !== sessionId ||
      data.length === 0 ||
      !submitted
    ) return;
    // A TUI commonly echoes/repaints the bracketed paste before Enter. That
    // output proves only local editing, not that the provider accepted the
    // turn. Count output only after the submit linearization point.
    observedOutput = true;
    observedOutputChunks += 1;
    armPhysicalTurnConfirmation();
    maybeAccept();
  }, { name: 'tool-util:busy-proof', delivery: 'immediate' });
  const untapExit = tapSessionExit((exitedSessionId) => {
    if (exitedSessionId !== sessionId) return;
    sessionExited = true;
    settle?.(false);
  });
  const untapTurnStart = tapAgentTurnStart((entry) => {
    if (
      entry.sessionId !== sessionId ||
      !submitted ||
      entry.sequence <= turnStartBaseline
    ) return;
    turnStartObserved = true;
    maybeAccept();
  });

  try {
    const safePrompt = assertSafePtyPrompt(prompt);
    const allowsBracketedPaste = adapterAcceptsBracketedPaste(
      getAgentSessionInfo(sessionId)?.adapterId,
    );
    const input =
      safePrompt.includes('\n') && allowsBracketedPaste
        ? `\x1b[200~${safePrompt}\x1b[201~`
        : safePrompt;
    if (!isSessionInjectableIdle(sessionId)) return false;
    assertMcpInvocationCurrent(invocation);
    const ingest = armPasteIngest(sessionId, safePrompt);
    if (!orchWriteSession(sessionId, input, { markInputBusy: false })) {
      ingest?.cancel();
      return false;
    }
    // Voo real 19/08: colagem sem prova de Enter deixava o briefing LARGADO
    // no composer ("checa o pane 5…" eterno) e o retry re-colava por cima.
    // Toda saída sem aceite após a colagem limpa a linha (Ctrl-U) — em TUI
    // readline isso mata o strand; num turno vivo é um control char inócuo.
    const clearStrandedComposer = () => {
      if (input.length === 0) return;
      if (getSessionState(sessionId) === null) return;
      try {
        orchWriteSession(sessionId, '\x15', { markInputBusy: false });
      } catch {
        // Best-effort: sessão pode ter morrido entre o check e o write.
      }
    };
    await submitEnter(
      sessionId,
      invocation,
      () => {
        if (canSubmit && !canSubmit()) return false;
        if (!submitted) {
          turnStartBaseline = getAgentTurnStartSequence(sessionId);
          submitted = true;
        }
        return true;
      },
      true,
      ingest,
    );
    if (!submitted) {
      clearStrandedComposer();
      return false;
    }
    if (getAgentTurnStartSequence(sessionId) > turnStartBaseline) {
      turnStartObserved = true;
    }
    if (getSessionState(sessionId) === 'busy') {
      observedBusy = true;
      postSubmitBusy = true;
    }
    armPhysicalTurnConfirmation();
    if (hasAcceptanceProof()) {
      await assertAcceptedPromptAuthority(sessionId, invocation);
      return true;
    }
    if (sessionExited || getSessionState(sessionId) === null) return false;
    const accepted = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        settle = null;
        resolve(hasAcceptanceProof());
      }, windowMs);
      settle = (accepted) => {
        clearTimeout(timer);
        settle = null;
        resolve(accepted);
      };
      // Immediate settle if we already have proof.
      if (hasAcceptanceProof()) settle(true);
    });
    if (submitted && getSessionState(sessionId) !== null) {
      await assertAcceptedPromptAuthority(sessionId, invocation);
    }
    if (!accepted && !submitted) clearStrandedComposer();
    return accepted;
  } finally {
    settle = null;
    if (physicalConfirmTimer) clearTimeout(physicalConfirmTimer);
    untapState();
    untapData();
    untapExit();
    untapTurnStart();
  }
}

/**
 * Submit text that the provider restored in its own editor after an
 * interrupted turn. No prompt bytes are added: this presses Enter only while
 * the main-owned semantic latch says the session is safely injectable, then
 * requires the same busy/output (or native UserPromptSubmit) proof used by a
 * fresh delivery.
 */
export function submitPendingAgentPrompt(
  sessionId: string,
  invocation?: McpToolInvocation,
  options: {
    readonly adapterId?: string;
    readonly canSubmit?: () => boolean;
    /**
     * Override the acceptance-proof window. A restored prompt re-submit is
     * near-instant (3s default); a boot-dialog/composer rescue needs the
     * provider's full turn-start latency.
     */
    readonly windowMs?: number;
  } = {},
): Promise<boolean> {
  return injectWithBusyProof(
    sessionId,
    '',
    options.windowMs ?? RESTORED_PROMPT_ACCEPTANCE_WINDOW_MS,
    invocation,
    requiresClaudeFamilyTurnProof(options.adapterId),
    options.canSubmit,
  );
}

/**
 * A quiet PTY is not a ready composer. Devin paints trust first; Kimi can
 * offer migration before its welcome screen (F-186). The first-run responder
 * already dismisses migration with Esc, but its repaint is not a model turn.
 * Wait for the provider's composer before any brief bytes or Enter are sent.
 */
async function waitUntilPasteComposerReady(
  sessionId: string,
  adapterId: string | undefined,
  invocation?: McpToolInvocation,
): Promise<boolean> {
  const ready = adapterId === 'devin' ? DEVIN_COMPOSER_READY
    : adapterId === 'kimi' ? KIMI_COMPOSER_READY
    : adapterId === 'qwen' ? QWEN_COMPOSER_READY
    : adapterId === 'mimo-code' ? MIMO_COMPOSER_READY : null;
  if (!ready) return true;
  const deadline = Date.now() + PASTE_COMPOSER_WAIT_MS;
  while (Date.now() < deadline) {
    assertMcpInvocationCurrent(invocation);
    if (getSessionState(sessionId) === null) return false;
    if (cliPromptAutoResponder.shouldDeferInjection(sessionId)) {
      await delay(50);
      continue;
    }
    if (ready.test(readSessionOutput(sessionId))) return true;
    await delay(50);
  }
  return !cliPromptAutoResponder.shouldDeferInjection(sessionId) &&
    ready.test(readSessionOutput(sessionId));
}

/** Bounded wait for an injectable idle edge (F-230, see INJECTABLE_IDLE_WAIT_MS). */
async function waitForInjectableIdle(
  sessionId: string,
  invocation?: McpToolInvocation,
): Promise<'idle' | 'exited' | 'timeout'> {
  const deadline = Date.now() + INJECTABLE_IDLE_WAIT_MS;
  for (;;) {
    assertMcpInvocationCurrent(invocation);
    if (getSessionState(sessionId) === null) return 'exited';
    if (
      isSessionInjectableIdle(sessionId) &&
      !cliPromptAutoResponder.shouldDeferInjection(sessionId)
    ) {
      return 'idle';
    }
    if (Date.now() >= deadline) return 'timeout';
    await delay(50);
  }
}

/**
 * Type a brief into an agent pane and PROVE it was accepted: after the paste,
 * the session must turn busy within the acceptance window, else we run the
 * boot-prompt gauntlet again and re-deliver once. Fire-and-forget injection
 * let boot dialogs without an autoresponder signature swallow briefs whole —
 * the pane then sat idle forever and no watchdog could see it.
 */
export async function deliverAgentPrompt(
  sessionId: string,
  prompt: string,
  invocation?: McpToolInvocation,
  options: { readonly adapterId?: string } = {},
): Promise<boolean> {
  clearAdaptiveEnterTimers(sessionId);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await waitOutBootPrompts(sessionId);
    const composerReady = await waitUntilPasteComposerReady(
      sessionId,
      options.adapterId,
      invocation,
    );
    if (!composerReady) {
      lastError = new Error(
        `${composerLabel(options.adapterId)} composer did not become ready before prompt delivery`,
      );
      continue;
    }
    const idle = await waitForInjectableIdle(sessionId, invocation);
    if (idle === 'exited') throw agentBootExitError(sessionId);
    // 'timeout': segue — injectWithBusyProof recusa sessão não-idle sem
    // escrever e a tentativa conta.
    // Linearization point after boot/menu waits and immediately before paste.
    assertMcpInvocationCurrent(invocation);
    try {
      if (
        await injectWithBusyProof(
          sessionId,
          prompt,
          PROMPT_ACCEPTANCE_WINDOW_MS,
          invocation,
          requiresClaudeFamilyTurnProof(options.adapterId),
        )
      ) {
        return true;
      }
    } catch (error) {
      lastError = error;
      // Fall through: a sessão pode continuar viva para a próxima tentativa.
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error('agent pane did not start after prompt delivery');
}

/**
 * Bounded watch for physical turn activity: a busy edge confirmed by a
 * continuing output stream (or sustained busy), so a one-frame TUI repaint
 * does not read as acceptance. Resolves true on the first confirmed activity,
 * false on window expiry or session exit.
 */
function waitForAgentActivity(
  sessionId: string,
  windowMs: number,
  signal?: AbortSignal,
  exactNativeReceipt?: () => boolean,
): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error('aborted'));
  }
  if (getSessionState(sessionId) === 'busy') return Promise.resolve(true);
  return new Promise<boolean>((resolve, reject) => {
    let confirmTimer: ReturnType<typeof setTimeout> | null = null;
    let edgeArmed = false;
    let dataAfterEdge = 0;
    const untapState = tapSessionState((changedSessionId, state) => {
      if (changedSessionId !== sessionId) return;
      if (state === 'busy' && !edgeArmed) {
        edgeArmed = true;
        dataAfterEdge = 0;
        confirmTimer = setTimeout(() => {
          confirmTimer = null;
          // Still busy past the confirm bound: a working turn, not a repaint.
          if (exactNativeReceipt?.() || getSessionState(sessionId) === 'busy') finish(true);
          else edgeArmed = false;
        }, NATIVE_ARGV_ACTIVITY_CONFIRM_MS);
      } else if (state === 'idle' && edgeArmed) {
        // Repaint burst settled without a stream: re-arm for a real edge.
        if (confirmTimer) clearTimeout(confirmTimer);
        confirmTimer = null;
        edgeArmed = false;
      }
    });
    // F-764 C.1: `immediate` — conta CHUNKS depois da borda de busy; O(1).
    const untapData = tapSessionData((changedSessionId, data) => {
      // The chunk that caused the busy edge arrives before the state tap, so
      // only data after the edge counts — a lone repaint frame never does.
      if (changedSessionId !== sessionId || data.length === 0 || !edgeArmed) {
        return;
      }
      dataAfterEdge += 1;
      if (dataAfterEdge >= 2) finish(true);
    }, { name: 'tool-util:activity', delivery: 'immediate' });
    const untapExit = tapSessionExit((exitedSessionId) => {
      if (exitedSessionId === sessionId) finish(false);
    });
    const untapNativeTurn = exactNativeReceipt ? tapAgentTurnStart((entry) => {
      if (entry.sessionId !== sessionId) return;
      // The reducer publishes turn-start before hook-status records the
      // digest. Observe after that synchronous endpoint transaction finishes.
      queueMicrotask(() => {
        if (!settled && exactNativeReceipt()) finish(true);
      });
    }) : undefined;
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error('aborted'));
    };
    const cleanup = () => {
      if (confirmTimer) clearTimeout(confirmTimer);
      clearTimeout(windowTimer);
      signal?.removeEventListener('abort', onAbort);
      untapState();
      untapData();
      untapExit();
      untapNativeTurn?.();
    };
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(accepted);
    };
    const windowTimer = setTimeout(() => finish(false), windowMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    // The edge may have landed between the entry snapshot and the taps.
    if (getSessionState(sessionId) === 'busy') finish(true);
  });
}

/**
 * AGY exits by itself right after printing its handoff block (verified on agy
 * 1.1.8). A handoff durably bound to THIS exact worker incarnation is a
 * stronger physical acceptance proof than any busy edge: the session exit
 * that follows is the provider's normal teardown, not a boot failure. Any
 * doubt fails closed — a store read error never fabricates acceptance.
 */
function hasBoundHandoffForExactWorker(
  scope: AgentGateContext['scope'],
  missionId: string | undefined,
  sessionId: string,
  workerIncarnationId: string | undefined,
): boolean {
  if (!missionId || !workerIncarnationId) return false;
  try {
    return getProjectDomainStores(scope)
      .taskDispatches.list(missionId)
      .some((dispatch) =>
        hasBoundHandoffForExactDispatchWorker(dispatch, {
          missionId,
          sessionId,
          workerIncarnationId,
        }),
      );
  } catch {
    return false;
  }
}

/**
 * Prove that a provider-native argv brief physically opened a turn. Spawn argv
 * retains an exact first native submission receipt through boot; providers
 * without that receipt keep PTY busy/stream proof and the exact worker's handoff. An
 * interactive provider may still need one bounded Enter nudge for its
 * preloaded composer. OpenCode's headless `run` normally exits after its
 * handoff; that exact durable receipt outranks the normal process exit. Any
 * failure throws so the caller tears the pane down instead of parking a mute
 * zombie worker.
 */
async function ensureNativeArgvPromptAccepted(
  sessionId: string,
  finalPrompt: string,
  adapterId: string,
  invocation?: McpToolInvocation,
  worker?: {
    readonly scope: AgentGateContext['scope'];
    readonly missionId?: string;
    readonly workerIncarnationId?: string;
  },
): Promise<void> {
  const handoffDelivered = (): boolean =>
    worker !== undefined &&
    hasBoundHandoffForExactWorker(
      worker.scope,
      worker.missionId,
      sessionId,
      worker.workerIncarnationId,
    );
  const boot = await waitForIdle(
    sessionId,
    AGENT_BOOT_TIMEOUT_MS,
    invocation?.signal,
  );
  if (boot === 'exited') {
    // A fast AGY turn can deliver the handoff and self-exit inside the boot
    // window; the durable handoff outranks the exit.
    if (handoffDelivered()) return;
    throw agentBootExitError(sessionId);
  }
  // A very fast worker can durably submit its exact handoff while the boot
  // observer is still settling. That transition legitimately revokes the
  // dispatch's running authority (`handoff_ready`); the bound handoff is a
  // stronger proof than the now-stale invocation, so recognize it before the
  // post-boot authority fence.
  if (handoffDelivered()) return;
  assertMcpInvocationCurrent(invocation);
  // The first exact argv submission can already have completed during boot.
  if (hasAcceptedNativeArgvPrompt(sessionId, finalPrompt, adapterId)) return;
  // Boot output never settled: the provider is already streaming the turn.
  if (boot === 'timeout' && getSessionState(sessionId) === 'busy') return;
  if (
    await waitForAgentActivity(
      sessionId,
      NATIVE_ARGV_PROMPT_ACTIVITY_WINDOW_MS,
      invocation?.signal,
      () => hasAcceptedNativeArgvPrompt(sessionId, finalPrompt, adapterId),
    )
  ) {
    if (handoffDelivered()) return;
    assertMcpInvocationCurrent(invocation);
    return;
  }
  // The activity wait also resolves false on physical session exit.
  if (handoffDelivered()) return;
  assertMcpInvocationCurrent(invocation);
  if (hasAcceptedNativeArgvPrompt(sessionId, finalPrompt, adapterId)) return;
  const rescued = await submitPendingAgentPrompt(sessionId, invocation, {
    adapterId,
    windowMs: PROMPT_ACCEPTANCE_WINDOW_MS,
  });
  // A busy session here means the turn opened while the proof was pending —
  // re-typing the brief would interleave with live work.
  if (handoffDelivered()) return;
  assertMcpInvocationCurrent(invocation);
  if (rescued || getSessionState(sessionId) === 'busy') return;
  if (handoffDelivered()) return;
  assertMcpInvocationCurrent(invocation);
  await deliverAgentPrompt(sessionId, finalPrompt, invocation, { adapterId });
}

/**
 * Fast-lane Maestro argv brief: same physical acceptance proof as a
 * provider-native spawn (`ensureNativeArgvPromptAccepted`). Throws if the
 * pane never opens a turn so the caller can tear it down.
 */
export async function proveNativeArgvBriefAccepted(
  sessionId: string,
  finalPrompt: string,
  adapterId: string,
  invocation?: McpToolInvocation,
): Promise<void> {
  await ensureNativeArgvPromptAccepted(sessionId, finalPrompt, adapterId, invocation);
}

/**
 * Memória do workspace no brief: worker/orquestrador de missão e o helper da
 * mão do operador (sem papel, sem missão), que também nasce com um brief. Só
 * memória trusted, com teto de bytes (workspaceMemoryContextBlock). Pane
 * interno transitório não recebe.
 */
type RecallCandidate = Pick<SpawnToolOptions, 'prompt' | 'missionId' | 'role' | 'transient'>;

export function recallsWorkspaceMemory(
  options: RecallCandidate,
): options is RecallCandidate & { prompt: string } {
  if (!options.prompt) return false;
  if (options.missionId) return true;
  return options.role === undefined && options.transient !== true;
}

type BriefCandidate = Pick<
  SpawnToolOptions,
  | 'prompt'
  | 'memoryQuery'
  | 'transient'
  | 'scope'
  | 'executionScope'
  | 'missionId'
  | 'role'
  | 'readOnly'
  | 'agentCategory'
>;

/**
 * Blocos de contexto do projeto no brief de TODA CLI (worker, helper,
 * orquestrador): `<business-model>` e `<workspace-memory>` (este só para
 * quem recallsWorkspaceMemory). Pane interno transitório (revisor
 * automático) não recebe.
 */
export function withProjectContextBlocks(options: BriefCandidate): string | undefined {
  if (!options.prompt || options.transient === true) return options.prompt;
  return mountPromptContextBlocks(options.prompt, [
    businessModelContextBlock(options.executionScope ?? options.scope, options.scope),
    recallsWorkspaceMemory(options)
      ? workspaceMemoryContextBlock(options.scope, options.memoryQuery ?? options.prompt, autoRecallPhaseForAgent(options), {
          missionId: options.missionId ?? undefined,
        })
      : null,
  ]);
}

/**
 * Variante async: o `<business-model>` vem da SELEÇÃO por tarefa (Jev ou
 * lexical sobre o modelo extraído do HEAD) — o bloco estático fica de
 * fallback quando a seleção não encontra nada. Nunca lança: seleção falhou
 * vira o bloco estático; sem modelo nenhum, só a memória.
 */
export async function withProjectContextBlocksAsync(
  options: BriefCandidate,
): Promise<string | undefined> {
  if (!options.prompt || options.transient === true) return options.prompt;
  const execScope = options.executionScope ?? options.scope;
  // Brief é ponto de trigger: garante o modelo extraído do HEAD em background
  // (dedup por commit + flight único), sem segurar o spawn.
  if (execScope) void ensureBusinessModel(execScope, { wait: false }).catch(() => {});
  const selected = execScope
    ? await taskBusinessContextBlock(execScope, options.prompt, options.scope, {
        missionId: options.missionId ?? undefined,
      }).catch(() => null)
    : null;
  return mountPromptContextBlocks(options.prompt, [
    selected ?? businessModelContextBlock(execScope, options.scope),
    recallsWorkspaceMemory(options)
      ? workspaceMemoryContextBlock(options.scope, options.memoryQuery ?? options.prompt, autoRecallPhaseForAgent(options), {
          missionId: options.missionId ?? undefined,
        })
      : null,
  ]);
}

export interface SpawnToolOptions {
  workerContinuation?: import('./mission-pane-store').WorkerContinuationRef;
  visualTask?: import('../../shared/orch-types').VisualTaskRequirement;
  adapterId: string;
  /** Origem da rota (A, 25/09) exibida no cabeçalho do pane; nunca autoridade. */
  spawnRoute?: SpawnRouteInfo;
  /** Main-only provider-native first turn; never accepted from renderer IPC. */
  initialPrompt?: string;
  /** Main-selected vault identity; never let the renderer choose for missions. */
  accountId?: string;
  model?: string;
  /** Per-spawn reasoning effort (task-router decision). */
  effort?: string;
  cwd?: string;
  title?: string;
  missionId?: string;
  /**
   * Internal process-local pane. Main runs it headless so it never contends
   * for renderer slots, mission composition, or durable workspace layout.
   */
  transient?: true;
  contextRevision?: string;
  /** Complete main-owned mission/workflow/squad revision; never renderer-authored. */
  authoritySeal?: MissionPaneAuthoritySeal;
  agentName?: string;
  workerIncarnationId?: string;
  /** Squad role category (scout/executor/reviewer/…) — tiers the charters. */
  agentCategory?: string;
  allowedTools?: string[] | null;
  allowedSkills?: string[] | null;
  role?: 'orchestrator' | 'worker';
  /** Forma de execução selada do dispatch; decide o escopo de escrita válido. */
  executionMode?: 'same_checkout' | 'isolated_worktree' | 'read_only';
  isolatedWriter?: boolean;
  /**
   * "Escolha livre de agentes" da missão (contract-sealed). Propagado ao
   * backstop físico assertReleaseQualifiedMissionWorkerSpawn para que o gate de
   * CLI release-qualified honre o opt-in por missão mesmo sob `governed`.
   */
  freeAgentChoice?: boolean;
  prompt?: string;
  /**
   * F-231: worker de missão aberto pelo operador — participa do Quadro e do
   * ledger, mas mortalidade/TTL/teardown não o fecham; no fim volta a `user`.
   */
  operatorOpened?: boolean;
  /** Main-only original task, before execution-authority boilerplate is prepended. */
  memoryQuery?: string;
  scope: AgentGateContext['scope'];
  executionScope?: AgentGateContext['executionScope'];
  readOnly?: boolean;
  /**
   * Merge-council / context reviewers finalize with nexus_merge_review_submit
   * (or draft review), not nexus_handoff_submit. Appending the worker handoff
   * contract makes Codex inspect the diff then stall looking for a tool that
   * is not in allowedTools.
   */
  omitHandoffContract?: boolean;
  /**
   * Resume a CLOSED worker with its context intact. Accepts task id ("h-N"),
   * paneId ("pane-N"), or boolean (resume mode on). The pty-manager resolves
   * the exact session and passes --resume <id> (or equivalent) to the CLI.
   */
  resume?: boolean | string;
  /** Only consider the latest session (no exact-session resume lookup). */
  resumeLatestOnly?: boolean;
  /** 0.76.45: retomar a conversa de um pane antigo (estacionado/fechado) no pane novo. */
  resumeFromPaneId?: string;
}

/**
 * Lifecycle hooks for the host-side spawn transaction. The pane-created hook
 * fires immediately after the PTY exists and before mission composition is
 * persisted, so budget callers can retain a reservation if persistence fails.
 */
export interface SpawnPaneHooks {
  readonly onPaneCreated?: (paneId: string, sessionId: string) => void;
  /**
   * Fires only after the exact final prompt (including the worker handoff
   * contract) has crossed the transport acceptance boundary.
   */
  readonly onPromptAccepted?: (
    paneId: string,
    sessionId: string,
    prompt: string,
  ) => void;
  /**
   * F-213/R6: medidor de fases do `pane-spawn-timing` — subdivide a fase
   * `pty-spawn` (que cobria a chamada inteira) nos awaits reais: probe de
   * credencial, alocação do pane (renderer attach/waitForSession dentro do
   * requestPaneSpawn), prova de writer e entrega do prompt.
   */
  readonly timer?: PhaseTimer;
  /** Exact dispatch authority propagated across asynchronous preflight. */
  readonly invocation?: McpToolInvocation;
  /**
   * F-723: o pane com briefing nasceu com ACK pendente — a tool vai responder
   * antes de a sessão existir. Quem pediu registra a ficha do watchdog de
   * início; `redeliver` é a mesma entrega comprovada deste spawn.
   */
  readonly onPendingSpawn?: (attempt: PendingSpawnAttemptInfo) => void;
  /**
   * F-793: pane de missão com ACK pendente — a linha de `missionPanes` só
   * nasce quando o Main vincula a sessão física a esta tentativa. Quem segura
   * a vaga de maxWorkers espera este desfecho antes de soltar a reserva.
   */
  readonly onPendingMissionPane?: (
    recorded: Promise<PendingMissionPaneRecord>,
  ) => void;
}

/**
 * F-793: desfecho da gravação adiada de um pane de missão com ACK pendente.
 * `no-session`: a tentativa acabou sem sessão (nada a contar);
 * `unrecorded`: a sessão nasceu, mas a conferência física recusou a linha.
 */
export type PendingMissionPaneRecord = 'recorded' | 'no-session' | 'unrecorded';

/** F-723: tentativa pendente com briefing (nunca carrega o texto do brief). */
export interface PendingSpawnAttemptInfo {
  readonly requestId: string;
  readonly paneId: string;
  readonly adapterId: string;
  /** CLI cujo UserPromptSubmit é prova confiável de turno (família Claude). */
  readonly turnProof: boolean;
  /** Reentrega o briefing na sessão desta tentativa; true = turno aceito. */
  readonly redeliver: () => Promise<boolean>;
}

/**
 * Brief adiado que perdeu a autoridade DURÁVEL do spawn (missão encerrada ou
 * selo trocado): não é falha da CLI e não vira reenvio para outra.
 */
class StaleBriefError extends Error {}

function requireMissionPaneAuthoritySeal(options: SpawnToolOptions) {
  if (!options.missionId) return undefined;
  const mission = getProjectDomainStores(options.scope).missions.get(
    options.missionId,
  );
  const squads = listSquads().filter(
    (candidate) => candidate.id === mission?.squadId,
  );
  const seal = mission
    ? resolveMissionPaneAuthoritySeal(options.scope, mission, squads.length === 1 ? squads[0] : null)
    : null;
  const autopilot = isOperatorChoicePolicy(
    getOrchSettings().squadCliPolicy,
  );
  if (!seal) {
    // Autopilot libre: continue without a seal so workers still spawn; Main
    // merge remains the promotion boundary. Hardened stays fail-closed.
    if (autopilot) {
      console.warn(
        `[spawn] Autopilot: mission pane authority seal unavailable for ` +
          `${options.missionId}; continuing without seal`,
      );
      return options.authoritySeal;
    }
    throw new Error(
      'mission pane authority seal is unavailable; replane and approve the current mission revision',
    );
  }
  if (
    options.contextRevision !== undefined &&
    options.contextRevision !== seal.contextRevision
  ) {
    if (autopilot) {
      console.warn(
        `[spawn] Autopilot: contextRevision drift for ${options.missionId}; ` +
          `using live seal`,
      );
      return seal;
    }
    throw new Error(
      'mission pane contextRevision is stale; replane and approve the current revision',
    );
  }
  if (
    options.authoritySeal &&
    (
      options.authoritySeal.intentVersion !== seal.intentVersion ||
      options.authoritySeal.intentContractHash !== seal.intentContractHash ||
      options.authoritySeal.contextRevision !== seal.contextRevision ||
      options.authoritySeal.contractHash !== seal.contractHash ||
      options.authoritySeal.squadRevisionHash !== seal.squadRevisionHash
    )
  ) {
    if (autopilot) {
      console.warn(
        `[spawn] Autopilot: authority seal drift for ${options.missionId}; ` +
          `using live seal`,
      );
      return seal;
    }
    throw new Error(
      'stale mission pane authority; replane and approve the current revision',
    );
  }
  return seal;
}

export {
  charterTierForWorker,
  withHandoffContract,
  type HandoffContractHints,
} from './worker-handoff-contract';

export { assertReleaseQualifiedMissionWorkerSpawn } from './mission-worker-spawn-authority';

/** Auth present real do CLI (mesma classificação do first-wave/revisor). */
function cliHasPresentAuth(cli: string): boolean {
  try {
    if (cli === 'qwen' && !providerReadiness(cli).ready) return false;
    const readiness = detectSubscriptionAuthReadiness(cli);
    return (
      classifySeatAuth({
        adapterId: cli,
        authStrategy: String(providerAuthStrategy(cli) ?? ''),
        hasKey: hasRuntimeKey(cli),
        kimiListReadiness: cli === 'kimi' ? readiness : undefined,
        hasCredentiallessModel: readiness === 'present',
      }) === 'present'
    );
  } catch {
    return false;
  }
}

export async function spawnPaneAndMaybePrompt(
  options: SpawnToolOptions,
  hooks: SpawnPaneHooks = {},
): Promise<{ paneId: string; sessionId: string }> {
  assertLicensedAgentCapacity();
  // F-1270: recusa de capacidade na HORA, no caminho MCP. O renderer já roda
  // este mesmo gate em `spawnAgentSession`; aqui o `nexus_pane_spawn` devolve
  // ok:false com a mensagem real em vez de um ACK pendente que depois vira
  // recusa perdida. Mesma contagem do renderer (worker usa reserva de licença).
  const admission = admitToolSpawnSync({
    role: options.role,
    missionId: options.missionId,
    operatorOpened: options.operatorOpened,
    liveAgentPanes: countLiveAgentSessions(),
    licensedAgentPanes: licensedAgentCount(),
  });
  if (!admission.ok) {
    // Aqui quem lê é o Maestro, não o supervisor (que só decodifica a recusa
    // do renderer): mensagem legível, sem o código cru `pane_admission_*`.
    throw new Error(
      `spawn recusado pela admissão de panes (${admission.reason === 'cap' ? 'teto' : 'memória'}): ${admission.message}`,
    );
  }
  assertMcpInvocationCurrent(hooks.invocation);
  let resolvedAdapter = getAdapter(options.adapterId);
  if (!resolvedAdapter) throw new Error(`unknown adapter: ${options.adapterId}`);
  if (resolvedAdapter.kind !== 'cli-pty') {
    // spawnPaneAndMaybePrompt only ever spawns terminal panes; API providers
    // have no pane representation.
    throw new Error(`adapter ${options.adapterId} is not spawnable as a pane`);
  }
  let adapter = resolvedAdapter;
  const authoritySeal = requireMissionPaneAuthoritySeal(options);
  assertReleaseQualifiedMissionWorkerSpawn(options);
  const contextRevision =
    authoritySeal?.contextRevision ?? options.contextRevision;
  const revisionBoundWritableWorker =
    options.role === 'worker' &&
    Boolean(contextRevision) &&
    options.readOnly !== true;
  // Caminho simples (06/08 + paridade Bridge/Bridge): escrita no workspace
  // de coordenação é o PADRÃO. Worktree distinta só quando o despacho pede
  // `isolated_worktree` (fan-out multi-escritor). Exigir worktree em todo
  // worker matou a entrega em loop de retries e deixou claim sem pane
  // (HiperGO dev 2026-08-07). A não-interferência no caminho simples é
  // provada na ADMISSÃO (ownership serializado) e no recibo.
  const requiresDistinctWorktree =
    options.executionMode === 'isolated_worktree';
  if (
    revisionBoundWritableWorker &&
    requiresDistinctWorktree &&
    (!options.executionScope ||
      options.executionScope.rootRealPath === options.scope.rootRealPath)
  ) {
    throw new Error(
      'workspace_write_scope_invalid: revision-bound writable worker ' +
        'requires a physically distinct main-owned execution worktree',
    );
  }
  if (
    revisionBoundWritableWorker &&
    requiresDistinctWorktree &&
    !isRevisionBoundWritableWorkerAdapterAllowed(adapter.id)
  ) {
    throw new Error(
      `workspace_write_unsupported: ${adapter.id} não oferece sandbox ` +
        'confiável para worker autônomo isolado (ative Escolha livre ou use Codex)',
    );
  }
  // Circuit half-open / closed only for auto traffic; explicit spawns still try.
  // Failures below trip the breaker for future routeTask multi-score.
  // Defesa em profundidade contra modelo-fantasma (caso de campo 17/07): a
  // superfície de seleção (dropdown do squad, roster, route_task) podia oferecer
  // um id que o CLI instalado não roda (ex.: `gpt-5.6` depois da OpenAI
  // renomear para `gpt-5.6-sol`/`-luna`/`-terra`). Sem isto o CLI ignora o
  // pedido e cai SILENCIOSAMENTE no seu default (`gpt-5.6-sol`), fazendo o modelo
  // escolhido pelo usuário NÃO valer. Aqui, imediatamente antes do PTY,
  // resolvemos o modelo contra a lista REAL do CLI (cache do próprio CLI quando
  // existe; senão a lista estática do adapter): id exato quando roda, senão a
  // 1ª variante da mesma família. Sem variante, mantém o pedido (não piora).
  const runnableModels =
    discoverCliModels().get(options.adapterId) ?? adapter.models.list;
  const rawModel = options.model?.trim();
  const preservingResume = Boolean(options.resume || options.resumeFromPaneId);
  const sealedModel = preservingResume ? rawModel : migrateModelId(rawModel);
  let effectiveModel = sealedModel ?? options.model;
  if (sealedModel && !preservingResume) {
    if (
      adapter.models.list.includes(sealedModel) ||
      runnableModels.includes(sealedModel)
    ) {
      effectiveModel = sealedModel;
    } else {
      const modelResolution = resolveRoutableModel(sealedModel, runnableModels);
      if (
        modelResolution.ok &&
        modelResolution.model &&
        modelResolution.model !== sealedModel &&
        !isRoutableModelResolution(sealedModel, modelResolution.model)
      ) {
        throw new Error(
          `${adapter.label}: modelo selado "${sealedModel}" não é executável ` +
            `neste CLI; recusando fallback silencioso para ${modelResolution.model}`,
        );
      }
      effectiveModel = modelResolution.ok
        ? modelResolution.model
        : sealedModel;
    }
  }
  // Pre-spawn credential probe (peer ADE F-256 harvest): judge the exact
  // effective model before a pane exists. This matters for OpenCode: its
  // pinned first-party free models need no credential, while external models
  // on the same installed CLI still return a typed credential error. Probe
  // infrastructure itself is fail-closed only in explicit Hardened mode:
  // autopilot and direct terminals must not stall because an optional local
  // readiness reader failed while the CLI can authenticate from its own HOME.
  const probeFailClosed = !isOperatorChoicePolicy(
    getOrchSettings().squadCliPolicy,
  );
  let activeAdapterId = options.adapterId;
  /**
   * Assento que o gate de credencial recusou e a cadeia de sucessão
   * substituiu. Guardado para avisar o operador DEPOIS que o pane existir —
   * antes disso não há sessão para nomear, e a troca silenciosa é justamente o
   * que fazia o pane parecer ter ignorado o pedido (campo 10/09).
   */
  let seatRemap: { readonly requested: string; readonly reason: string } | null =
    null;
  try {
    await assertPreSpawnProbe(activeAdapterId, {
      model: effectiveModel,
      failClosed: probeFailClosed,
      silentRemint: true,
    });
  } catch (error) {
    // F-101: assento sem credencial caminha a CADEIA de sucessão
    // (shared/seat-chains, mesma regra do remint do revisor) em vez de morrer
    // silencioso e prender a missão num pane que nunca nasce.
    if (!isCredentialProbeFailure(error)) throw error;
    // A successor CLI has no authority over the original conversation.
    if (preservingResume) throw error;
    const successor = await settleSeatAfterCredentialFailure({
      failedCli: activeAdapterId,
      probe: (cli) =>
        assertPreSpawnProbe(cli, {
          failClosed: probeFailClosed,
          silentRemint: true,
        }),
      deps: {
        isSpawnableCli: (cli) => {
          const candidate = getAdapter(cli);
          return Boolean(candidate && candidate.kind === 'cli-pty');
        },
        hasPresentAuth: cliHasPresentAuth,
      },
    });
    if (!successor) throw error;
    console.warn(
      `[pane-spawn] ${error.message} — assento remapeado para \`${successor}\`` +
        ` (role=${options.role ?? '?'} mission=${options.missionId ?? '?'})`,
    );
    seatRemap = { requested: activeAdapterId, reason: error.message };
    activeAdapterId = successor;
    options = { ...options, adapterId: successor, model: undefined };
  }
  if (activeAdapterId !== resolvedAdapter.id) {
    effectiveModel = undefined;
    const swapped = getAdapter(activeAdapterId);
    if (!swapped || swapped.kind !== 'cli-pty') {
      throw new Error(`unknown adapter: ${activeAdapterId}`);
    }
    // Review 21/08: o guard de sandbox roda no probe original; o fallback
    // NÃO pode herdar permissão de worktree isolado que o novo adapter
    // não oferece (fail-closed aqui, fail-open só na credencial).
    if (
      revisionBoundWritableWorker &&
      requiresDistinctWorktree &&
      !isRevisionBoundWritableWorkerAdapterAllowed(swapped.id)
    ) {
      throw new Error(
        `workspace_write_unsupported: ${swapped.id} não oferece sandbox ` +
          'confiável para worker autônomo isolado (ative Escolha livre ou use Codex)',
      );
    }
    resolvedAdapter = swapped;
    adapter = swapped;
  }
  // A sonda de credencial e a cadeia de sucessão de assento são os awaits
  // pré-alocação desta função. Em 28/09 a espera de ~50 s aconteceu antes da
  // alocação do pane, sem registro de em qual etapa — esta marca separa.
  hooks.timer?.mark('credential-probe');
  assertMcpInvocationCurrent(hooks.invocation);
  if (options.missionId && options.role) {
    // Best-effort only: never block spawn on attestation vault (pre-PTY slim).
    issueAgentIdentityBestEffort({
      missionId: options.missionId,
      scope: options.scope,
      agentId: options.agentName?.trim() || adapter.id,
    });
  }
  if (options.prompt) options = { ...options, prompt: await withProjectContextBlocksAsync(options) };
  const omitHandoff =
    options.omitHandoffContract === true ||
    options.role === 'orchestrator' ||
    (Array.isArray(options.allowedTools) &&
      options.allowedTools.includes('nexus_merge_review_submit') &&
      !options.allowedTools.includes('nexus_handoff_submit'));
  const handoffPrompt = options.prompt
    ? omitHandoff
      ? options.prompt
      : withHandoffContract(options.prompt, adapter, {
          category: options.agentCategory,
          hints: [options.title, options.agentName],
          readOnly: options.readOnly === true,
          // C-194.1: todo worker de missão com MCP tem fechamento mecânico
          // (turn-end-handoff colhe o fim de turno via /hook/status) — o
          // contrato ensina a regra condicional, não "sempre chame a tool".
          systemDelivers:
            options.role === 'worker' && Boolean(options.missionId),
          // F-781: a regra do navegador é recomendação (F-1157). Sem papel o
          // token nasce `user`; o filho do operador chega aqui com o pane pai
          // (tools-panes.ts, `operatorParentSessionId`). Um spawn rotulado
          // somente-leitura só responde: recebe SÓ o pedido, como na Via
          // Rápida (mission-fast-lane.ts).
          nexusBrowser: options.readOnly !== true && hasNexusBrowserAlternative({
            role: options.role ?? 'user',
            missionId: options.missionId,
            readOnly: options.readOnly,
            allowedTools: options.allowedTools ?? null,
            operatorChild:
              options.role === undefined &&
              typeof (options as { operatorParentSessionId?: unknown })
                .operatorParentSessionId === 'string',
          }),
        })
    : undefined;
  const finalPrompt = handoffPrompt
    ? withWorkspaceDesignRule(
        handoffPrompt,
        options.executionScope?.rootRealPath ?? options.scope.rootRealPath,
        options.prompt,
      )
    : undefined;
  // coordination parity (12/08): prompt entregue no argv de NASCENÇA para TODA
  // CLI que aceita — igual pane_spawn. Antes isso era restrito a 3 adapters
  // (agy/codex/opencode) e todo o resto recebia por colagem pós-boot, que é o
  // canal que falha contra TUI fria (timing race, eco, mutez). Agora o resolvedor
  // é o MESMO que o pty-manager e o deliveredByNativeChannel usam — uma lista só.
  const promptChannel = initialPromptChannel({
    declared: adapter.spawn.initialPrompt,
    oneshotArgs: adapter.spawn.initialPromptArgs,
    interactive: adapter.spawn.interactive,
  });
  const shouldUseNativeInitialPrompt = Boolean(
    finalPrompt &&
      promptChannel.kind !== 'paste' &&
      (options.role === 'worker' || promptChannel.kind === 'positional') &&
      // F-1316: PTY materializes large native prompts as private brief files.
      // F-721: spawn que retoma conversa não leva prompt no argv (regra do
      // pty-manager); o brief vai por colagem depois do boot.
      !options.resume,
  );
  let initialPrompt: string | undefined;
  if (shouldUseNativeInitialPrompt && finalPrompt) {
    initialPrompt = assertSafePtyPrompt(finalPrompt);
    if (
      Buffer.byteLength(initialPrompt, 'utf8') >
      MAX_NATIVE_INITIAL_PROMPT_BYTES
    ) {
      throw new Error(
        `${adapter.label} initial prompt exceeds ` +
          `${MAX_NATIVE_INITIAL_PROMPT_BYTES} bytes`,
      );
    }
  }
  // Agent CLIs can read and execute native tools. Pin every orchestrated spawn
  // to the active workspace before the renderer/PTY boundary; never inherit
  // pty-manager's user-shell fallback to HOME.
  const safeOptions: SpawnToolOptions = {
    ...options,
    visualTask: options.role === 'orchestrator' ? undefined : options.workerContinuation
      ? options.visualTask : options.visualTask
        ? createVisualTaskRequirement() : visualTaskRequirement(options.memoryQuery ?? options.prompt),
    model: effectiveModel,
    ...(initialPrompt === undefined ? {} : { initialPrompt }),
    // The durable pane seal is the authoritative mission revision. Main-owned
    // scheduler spawns do not originate from an MCP AgentGateContext, so
    // carrying this value here prevents a writable worker from being silently
    // downgraded to the native read-only policy.
    contextRevision,
    authoritySeal,
    executionScope: options.executionScope ?? options.scope,
    cwd: resolveCwdForScope(options.executionScope ?? options.scope, options.cwd),
  };
  assertMcpInvocationCurrent(hooks.invocation);
  const {
    prompt: _prompt,
    omitHandoffContract: _omitHandoffContract,
    agentCategory: _agentCategory,
    ...paneSpawnOptions
  } = safeOptions;
  const result = await requestPaneSpawn({
    ...paneSpawnOptions,
    ...(hooks.timer ? { spawnTimer: hooks.timer } : {}),
    ...(hooks.invocation?.signal
      ? { abortSignal: hooks.invocation.signal }
      : {}),
  });
  hooks.timer?.mark('pane-alloc');
  if (result.ok && result.pending === true && result.paneId && finalPrompt) {
    // F-723: a ficha nasce ANTES da entrega adiada, que pode falhar e avisar.
    const attempt = { requestId: result.requestId, paneId: result.paneId };
    const argvBrief = initialPrompt !== undefined;
    const sealNotice = {
      scope: options.scope,
      missionId: options.missionId,
      authoritySeal,
    };
    try {
      hooks.onPendingSpawn?.({
        ...attempt,
        adapterId: adapter.id,
        turnProof: requiresClaudeFamilyTurnProof(adapter.id),
        redeliver: () =>
          redeliverPendingSpawnBrief(
            attempt,
            finalPrompt,
            adapter.id,
            argvBrief,
            sealNotice,
          ),
      });
    } catch (error) {
      // A ficha é vigilância: nunca derruba um spawn que já nasceu.
      console.warn('[pane-start] ficha do spawn pendente não registrada:', error);
    }
  }
  if (
    result.ok &&
    result.pending === true &&
    result.paneId &&
    finalPrompt &&
    initialPrompt === undefined
  ) {
    // ACK pendente: o chamador recebe o paneId antes de a sessão existir. O
    // brief de argv já viajou no grant; o de COLAGEM (Kimi) não tem canal
    // nenhum — sem isto o helper abria mudo, sem o briefing.
    // A entrega é do SPAWN, não da requisição: `assertCurrentAuthority` vale
    // para a chamada MCP e já não é o corrente quando o pane nasce (a tool
    // respondeu) — com ele, a colagem morria em session_authority_revoked e
    // o Kimi abria mudo (smoke 28/09). Só o cancelamento explícito (signal)
    // segue valendo; a vida do pane/sessão é checada dentro da entrega.
    void deliverPromptAfterPendingSpawn(
      { requestId: result.requestId, paneId: result.paneId },
      finalPrompt,
      adapter.id,
      hooks.invocation?.signal ? { signal: hooks.invocation.signal } : undefined,
      {
        scope: options.scope,
        missionId: options.missionId,
        title: options.agentName ?? options.title,
        authoritySeal,
        operatorOpened: options.operatorOpened === true || undefined,
      },
    );
  }
  if (
    result.ok &&
    result.pending === true &&
    result.paneId &&
    options.missionId &&
    options.transient !== true
  ) {
    // F-793: o throw de compatibilidade logo abaixo pulava a gravação da
    // composição — helper despachado com ACK pendente nunca entrava em
    // `missionPanes` (03/10: 28 helpers, uma linha, só o orquestrador). A
    // linha nasce quando a sessão física se vincula a esta tentativa, com a
    // mesma conferência do caminho síncrono (nunca a resposta do renderer).
    const pane = { requestId: result.requestId, paneId: result.paneId };
    const missionId = options.missionId;
    const recordOptions = options;
    const recorded = recordMissionPaneAfterPendingSpawn(pane, (sessionId) =>
      recordSpawnedMissionPane(recordOptions, safeOptions, {
        missionId,
        model: effectiveModel,
        authoritySeal,
        paneId: pane.paneId,
        sessionId,
      }),
      recordOptions.workerContinuation
        ? () => workerContinuationBirthState(recordOptions.scope, recordOptions.workerContinuation!)
        : undefined,
    );
    try {
      hooks.onPendingMissionPane?.(recorded);
    } catch (error) {
      console.warn('[mission-panes] vigilância do pane pendente falhou:', error);
    }
  }
  if (!result.ok || !result.paneId || !result.sessionId) {
    const licenseError = licenseErrorFrom(result.error);
    if (licenseError) throw licenseError;
    // ACK pendente não é falha do adapter: o chamador traduz em sucesso e o
    // pane ainda vai nascer. Contar aqui abria o breaker com a grade oculta.
    if (!(result.ok && result.pending === true)) {
      adapterCircuitBreakers.recordFailure(options.adapterId);
    }
    throw new Error(result.error ?? 'pane spawn failed');
  }
  try {
    assertMcpInvocationCurrent(hooks.invocation);
  } catch (error) {
    await requestPaneClose(result.paneId);
    throw error;
  }
  const writerKey = {
    adapterId: options.adapterId,
    role: options.role ?? 'worker',
    missionId: options.missionId,
  };
  const writerReady =
    options.role === 'orchestrator'
      ? true
      : await proveWriterConnectedAndWritable(result.sessionId, {
          deps: {
            getState: getSessionState,
            isStdinWritable: (sessionId) =>
              typeof isSessionStdinWritable === 'function'
                ? isSessionStdinWritable(sessionId)
                : true,
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          },
        });
  hooks.timer?.mark('writer-ready');
  if (!writerReady) {
    const failures = writerCircuitBreakers.recordConnectFailure(writerKey);
    adapterCircuitBreakers.recordFailure(options.adapterId);
    const action = writerCircuitBreakers.decideAfterFailure(writerKey, []);
    if (writerCircuitBreakers.isTripped(writerKey)) {
      trace(
        writerCircuitBreakEvent({
          key: writerKey,
          failures,
          action,
          sessionId: result.sessionId,
        }),
      );
    }
    try {
      await requestPaneClose(result.paneId);
    } catch {
      // original connect failure matters more
    }
    throw new Error(
      writerCircuitBreakers.isTripped(writerKey)
        ? `writer_circuit_break: ${options.adapterId} não ficou connected+writable`
        : `${options.adapterId} PTY não ficou connected+writable`,
    );
  }
  writerCircuitBreakers.recordConnectSuccess(writerKey);
  // F-736: PTY gravável não prova que a CLI funciona — o Qwen chegava aqui e
  // morria no boot 3 s depois, e este sucesso zerava a contagem a cada spawn:
  // o disjuntor nunca abria. O sucesso do adapter é o início provado do turno
  // (pane-start watchdog, delegation-supervisor).
  hooks.onPaneCreated?.(result.paneId, result.sessionId);
  if (seatRemap) {
    // O pane ABRIU — em outro CLI. Sem este aviso o operador só descobre a
    // troca por acaso, e o pane parece ter ignorado o que foi pedido.
    try {
      emitWorkerSpawnFailed({
        missionId: options.missionId ?? '',
        deadAdapterId: seatRemap.requested,
        message: seatRemap.reason,
        title:
          `Assento ${seatRemap.requested} → ${options.adapterId}` +
          (options.agentName ? ` (${options.agentName})` : ''),
        successorCli: options.adapterId,
        successorName: getAdapter(options.adapterId)?.label,
        at: Date.now(),
        scope: options.scope,
      });
    } catch {
      // Aviso é best-effort: nunca derruba um spawn que já deu certo.
    }
  }
  // Remember the mission's composition so it can be reopened from history.
  if (options.missionId && options.transient !== true) {
    assertMcpInvocationCurrent(hooks.invocation);
    // F-1151: a continuation target becomes durable only once its exact attempt
    // reached the host post; a native readiness can outlive the session being visible.
    if (options.workerContinuation) {
      let birth: 'authorized' | 'gone';
      try {
        birth = await awaitWorkerContinuationBirth(options, hooks.invocation);
      } catch (error) {
        // Giving up while the readiness can still post would leave a live worker with no
        // durable row: close the pane so the full physical proof releases the source.
        try { await requestPaneClose(result.paneId); } catch { /* the original abort/deadline matters more */ }
        throw error;
      }
      if (birth === 'gone') {
        throw new Error('resume_authority_changed: a continuação foi liberada antes do nascimento do processo');
      }
    }
    recordSpawnedMissionPane(options, safeOptions, {
      missionId: options.missionId,
      model: effectiveModel,
      authoritySeal,
      paneId: result.paneId,
      sessionId: result.sessionId,
    });
  }
  if (finalPrompt) {
    try {
      if (initialPrompt) {
        assertMcpInvocationCurrent(hooks.invocation);
        // The argv brief has no delivery receipt: prove the turn physically
        // opened, nudge once (Enter) when it did not, and only then fall back
        // to the legacy typed injection. Any failure closes the pane (catch
        // below) instead of parking a mute worker no watchdog can see.
        await ensureNativeArgvPromptAccepted(
          result.sessionId,
          finalPrompt,
          adapter.id,
          hooks.invocation,
          {
            scope: options.scope,
            missionId: options.missionId,
            workerIncarnationId: options.workerIncarnationId,
          },
        );
        hooks.onPromptAccepted?.(
          result.paneId,
          result.sessionId,
          initialPrompt,
        );
      } else {
        // Let the CLI finish booting before typing (first idle or timeout).
        // Cancellation belongs inside the cleanup boundary because a pane
        // already exists at this point.
        const boot = await waitForIdle(
          result.sessionId,
          AGENT_BOOT_TIMEOUT_MS,
          hooks.invocation?.signal,
        );
        if (boot === 'exited') {
          // The exact PTY exit may already have moved the durable dispatch to
          // blocked. Inspect that physical outcome before re-running the spawn
          // authority fence; otherwise the generic blocked-state assertion
          // replaces the provider's real bootstrap failure.
          throw agentBootExitError(result.sessionId);
        }
        assertMcpInvocationCurrent(hooks.invocation);
        // 'idle' or 'timeout' (slow boot): deliver and prove acceptance —
        // a swallowed brief used to leave a zombie worker no watchdog can see.
        const promptAccepted = await deliverAgentPrompt(
          result.sessionId,
          finalPrompt,
          hooks.invocation,
          { adapterId: adapter.id },
        );
        if (promptAccepted) {
          hooks.onPromptAccepted?.(
            result.paneId,
            result.sessionId,
            finalPrompt,
          );
        } else {
          throw new Error(
            'agent prompt remained live without physical acceptance proof',
          );
        }
      }
    } catch (error) {
      // Never leave a mute zombie pane occupying a mission worker slot. The
      // durable row remains as audit history, but a fenced worker incarnation
      // is never respawned as a different physical process.
      logAgentPromptFailure(adapter.id, result.sessionId, error);
      recordWorkerPromptDeliveryFailure({
        scope: options.scope,
        missionId: options.missionId,
        paneId: result.paneId,
        sessionId: result.sessionId,
        adapterId: adapter.id,
        error,
      });
      // F-231: pane do operador nunca é fechado pela máquina — fica vivo e
      // mudo para o operador digitar; o erro ainda propaga como aviso.
      if (options.operatorOpened !== true) {
        try {
          await requestPaneClose(result.paneId);
        } catch {
          // best effort — the original error matters more
        }
      }
      throw error;
    }
  }
  hooks.timer?.mark('prompt-delivery');
  return { paneId: result.paneId, sessionId: result.sessionId };
}

const WORKER_CONTINUATION_BIRTH_POLL_MS = 100;

/**
 * F-1151: the synchronous result can arrive while the native readiness still owns
 * the host post. Wait (bounded, abortable) until the exact attempt authorized the
 * birth; a released reservation means no child will ever exist for it.
 */
async function awaitWorkerContinuationBirth(
  options: SpawnToolOptions,
  invocation: Parameters<typeof assertMcpInvocationCurrent>[0],
): Promise<'authorized' | 'gone'> {
  const deadline = Date.now() + ORCH_SPAWN_GRANT_TTL_MS;
  for (;;) {
    const state = workerContinuationBirthState(options.scope, options.workerContinuation!);
    // `gone`: the reservation was released, so no child can ever appear for it.
    if (state === 'authorized' || state === 'gone') return state;
    // Abort or deadline: the readiness may STILL end in a birth, so the caller must close the pane.
    assertMcpInvocationCurrent(invocation);
    if (Date.now() >= deadline) {
      throw new Error('resume_authority_changed: o nascimento do processo não foi autorizado a tempo');
    }
    await delay(WORKER_CONTINUATION_BIRTH_POLL_MS);
  }
}

/**
 * Grava a composição da missão (reopen do histórico, contagem de maxWorkers,
 * grafo do Quadro) com a seleção FÍSICA do Main — nunca a resposta do
 * renderer. Sessão física que não confere com o pane pedido lança e não grava.
 */
function recordSpawnedMissionPane(
  options: SpawnToolOptions,
  safeOptions: SpawnToolOptions,
  pane: {
    readonly missionId: string;
    readonly model: string | undefined;
    readonly authoritySeal: MissionPaneAuthoritySeal | undefined;
    readonly paneId: string;
    readonly sessionId: string;
  },
): void {
  const physicalPty = getAgentSessionInfo(pane.sessionId);
  const physical = physicalPty ?? getAcpDriverSession(pane.sessionId)?.agent;
  const physicalScope = physicalPty
    ? safeOptions.executionScope ?? options.scope
    : options.scope;
  if (physical && (
    physical.sessionId !== pane.sessionId || physical.paneId !== pane.paneId ||
    physical.adapterId !== options.adapterId || physical.missionId !== pane.missionId ||
    !sameProjectScope(physical.scope, physicalScope) ||
    (options.accountId !== undefined && physical.accountId !== options.accountId)
  )) {
    throw new Error('physical pane account authority does not match the spawned mission pane');
  }
  const record = {
    missionId: pane.missionId,
    adapterId: options.adapterId,
    model: pane.model,
    // Use Main's physical selection, never a renderer-authored spawn reply.
    accountId: physical?.accountId ?? options.accountId,
    effort: options.effort,
    cwd: safeOptions.cwd,
    executionScope: safeOptions.executionScope,
    title: options.title,
    agentName: options.agentName,
    workerIncarnationId: physical?.workerIncarnationId ?? options.workerIncarnationId,
    role: options.role ?? 'worker' as const,
    allowedTools: options.allowedTools,
    allowedSkills: options.allowedSkills,
    readOnly: options.readOnly,
    authoritySeal: pane.authoritySeal,
    visualTask: safeOptions.visualTask,
    operatorOpened: options.operatorOpened === true || undefined,
    // Chave do resume direcionado: o reopen reusa este paneId para o CLI
    // voltar à MESMA conversa (não à mais recente do cwd).
    paneId: pane.paneId,
  };
  if (options.workerContinuation) {
    if (!physical || !record.workerIncarnationId) throw new Error('resume_physical_unproved: a continuação ainda não possui identidade física provada');
    commitWorkerContinuation(options.scope, options.workerContinuation, record, pane.sessionId);
  } else getProjectDomainStores(options.scope).missionPanes.record(record);
}

const PENDING_SPAWN_SESSION_POLL_MS = 500;

/**
 * F-793: espera a sessão que o Main vinculou a ESTA tentativa (requestId,
 * nunca "a sessão atual do paneId") e grava a linha com a conferência física.
 * Como a entrega adiada do brief, não depende da autoridade da requisição — a
 * tool já respondeu; vale o que o Main vinculou. Só leitura de mapas em
 * memória a cada 500 ms (uma continuação de worker também lê o claim durável,
 * uma consulta indexada por pane): nada síncrono pesado no Main.
 */
export async function recordMissionPaneAfterPendingSpawn(
  attempt: { readonly requestId: string; readonly paneId: string },
  record: (sessionId: string) => void,
  /** F-1151: a worker continuation records only after its exact attempt reached the host post. */
  birth?: () => WorkerContinuationBirthState,
): Promise<PendingMissionPaneRecord> {
  const deadline = Date.now() + ORCH_SPAWN_GRANT_TTL_MS;
  try {
    for (;;) {
      const bound = pendingSpawnAttemptSession(attempt.requestId);
      // Tentativa encerrada sem sessão: o registry já limpou o spawn falho.
      if (bound.state === 'gone') return 'no-session';
      if (bound.state === 'bound') {
        const physical =
          getAgentSessionInfo(bound.sessionId) ??
          getAcpDriverSession(bound.sessionId)?.agent;
        if (physical?.paneId === attempt.paneId) {
          // A visible session is not a born one: the native readiness can still
          // fail, and the durable target needs `childPossible` (host post authorized).
          const birthState = birth?.() ?? 'authorized';
          if (birthState === 'gone') return 'no-session';
          if (birthState === 'authorized') {
            record(bound.sessionId);
            return 'recorded';
          }
        } else if (!physical && getSessionState(bound.sessionId) === null) {
          // A sessão da tentativa morreu antes de se registrar: nada a contar.
          return 'no-session';
        }
      }
      if (Date.now() >= deadline) return 'no-session';
      await delay(PENDING_SPAWN_SESSION_POLL_MS);
    }
  } catch (error) {
    // Conferência física recusou (ou falha inesperada): sem linha, e quem
    // segura a vaga de maxWorkers a mantém — bloquear uma vaga é melhor que
    // passar do teto.
    console.warn(
      '[mission-panes] pane com ACK pendente não gravado:',
      error instanceof Error ? error.message : error,
    );
    return 'unrecorded';
  }
}

/**
 * Entrega pós-boot de um brief de colagem cujo pane nasceu com ACK pendente.
 * O destinatário é a sessão que o Main vinculou a ESTA tentativa (requestId),
 * nunca "a sessão atual do paneId" — um pane reciclado mantém o id. A tool já
 * respondeu sucesso pendente, então falha aqui é visível: fecha o pane se a
 * sessão ainda for desta tentativa e avisa o operador; nunca helper mudo.
 */
/**
 * A entrega adiada não tem mais a autoridade da requisição; o que ela tem é a
 * autoridade DURÁVEL do spawn: a missão ainda viva e o mesmo selo com que o
 * pane foi aberto. Missão bloqueada/encerrada ou selo trocado enquanto o CLI
 * subia → o brief velho não entra no PTY (Astra P2-8, 28/09).
 */
function assertMissionStillWantsBrief(notice: {
  readonly scope: SpawnToolOptions['scope'];
  readonly missionId?: string;
  readonly authoritySeal?: MissionPaneAuthoritySeal;
}): void {
  if (!notice.missionId) return;
  const mission = getProjectDomainStores(notice.scope).missions.get(notice.missionId);
  if (!mission) throw new StaleBriefError(`mission ${notice.missionId} is gone; stale brief not delivered`);
  if (mission.status === 'done' || mission.status === 'failed' || mission.status === 'blocked') {
    throw new StaleBriefError(`mission ${notice.missionId} is ${mission.status}; stale brief not delivered`);
  }
  if (!notice.authoritySeal) return;
  const squads = listSquads().filter((candidate) => candidate.id === mission.squadId);
  const live = resolveMissionPaneAuthoritySeal(
    notice.scope,
    mission,
    squads.length === 1 ? squads[0] : null,
  );
  if (live && !sameMissionPaneAuthoritySeal(notice.authoritySeal, live)) {
    throw new StaleBriefError('mission authority changed while the pane booted; stale brief not delivered');
  }
}

/**
 * F-723 "corrigir ali": reentrega o briefing de uma tentativa pendente na
 * sessão que o Main vinculou a ELA (nunca na do paneId), pela mesma entrega
 * comprovada do spawn — argv: Enter de resgate e colagem com prova de turno
 * (`ensureNativeArgvPromptAccepted`); colagem: `deliverAgentPrompt`. Missão
 * encerrada ou selo trocado não recebe o brief velho.
 */
async function redeliverPendingSpawnBrief(
  attempt: { readonly requestId: string; readonly paneId: string },
  prompt: string,
  adapterId: string,
  argvBrief: boolean,
  notice: {
    readonly scope: SpawnToolOptions['scope'];
    readonly missionId?: string;
    readonly authoritySeal?: MissionPaneAuthoritySeal;
  },
): Promise<boolean> {
  const bound = pendingSpawnAttemptSession(attempt.requestId);
  if (bound.state !== 'bound') return false;
  const info = getAgentSessionInfo(bound.sessionId);
  if (info?.paneId !== attempt.paneId || info.adapterId !== adapterId) {
    return false;
  }
  assertMissionStillWantsBrief(notice);
  if (argvBrief) {
    const identity = JSON.stringify(info);
    const durableInvocation: McpToolInvocation = { assertCurrentAuthority: () => {
      const current = pendingSpawnAttemptSession(attempt.requestId);
      if (current.state !== 'bound' || current.sessionId !== bound.sessionId ||
          JSON.stringify(getAgentSessionInfo(bound.sessionId)) !== identity) {
        throw new StaleBriefError('pending spawn binding changed; stale brief not delivered');
      }
      assertMissionStillWantsBrief(notice);
    } };
    await ensureNativeArgvPromptAccepted(bound.sessionId, prompt, adapterId, durableInvocation);
    assertMcpInvocationCurrent(durableInvocation);
    return true;
  }
  return deliverAgentPrompt(bound.sessionId, prompt, undefined, { adapterId });
}

export async function deliverPromptAfterPendingSpawn(
  attempt: { readonly requestId: string; readonly paneId: string },
  prompt: string,
  adapterId: string,
  invocation: McpToolInvocation | undefined,
  notice: {
    readonly scope: SpawnToolOptions['scope'];
    readonly missionId?: string;
    readonly title?: string;
    /** Selo com que o pane foi aberto: revalidado antes de colar. */
    readonly authoritySeal?: MissionPaneAuthoritySeal;
    /**
     * F-231: pane do operador nunca é fechado pela máquina da missão — numa
     * falha de entrega do brief ele fica vivo e mudo, para o operador digitar.
     */
    readonly operatorOpened?: boolean;
  },
): Promise<boolean> {
  const { paneId } = attempt;
  const deadline = Date.now() + ORCH_SPAWN_GRANT_TTL_MS;
  let sessionId: string | null = null;
  try {
    while (!sessionId) {
      assertMcpInvocationCurrent(invocation);
      const bound = pendingSpawnAttemptSession(attempt.requestId);
      // Tentativa encerrada sem sessão: o registry já limpou o spawn falho.
      if (bound.state === 'gone') return false;
      if (bound.state === 'bound') {
        const info = getAgentSessionInfo(bound.sessionId);
        if (info?.paneId === paneId) {
          // O brief leva contrato de handoff do adapter pedido.
          if (info.adapterId !== adapterId) {
            throw new Error(`spawned session runs ${info.adapterId}, not ${adapterId}`);
          }
          sessionId = bound.sessionId;
          break;
        }
        if (getSessionState(bound.sessionId) === null) {
          throw new Error('spawned session exited before the brief was delivered');
        }
      }
      if (Date.now() >= deadline) {
        throw new Error('pending pane session never became deliverable');
      }
      await delay(PENDING_SPAWN_SESSION_POLL_MS);
    }
    const boot = await waitForIdle(
      sessionId,
      AGENT_BOOT_TIMEOUT_MS,
      invocation?.signal,
    );
    if (boot === 'exited') throw agentBootExitError(sessionId);
    assertMcpInvocationCurrent(invocation);
    assertMissionStillWantsBrief(notice);
    const accepted = await deliverAgentPrompt(sessionId, prompt, invocation, {
      adapterId,
    });
    if (!accepted) {
      throw new Error('agent prompt remained live without physical acceptance proof');
    }
    // F-723: prova física de turno — o watchdog de início dá o pane por iniciado.
    notePaneStartAccepted(paneId);
    return true;
  } catch (error) {
    // F-723: falha de início da CLI (saiu no boot ou não aceitou o brief) vai
    // ao watchdog, que avisa quem pediu e reroteia. Brief velho (missão
    // encerrada/selo trocado) e chamador revogado não são falha da CLI.
    if (!(error instanceof StaleBriefError) && !invocation?.signal?.aborted) {
      notePaneStartFailure(
        paneId,
        /exited (?:during boot|before the brief)/.test(
          error instanceof Error ? error.message : String(error),
        )
          ? 'boot-exit'
          : 'brief-rejected',
      );
    }
    logAgentPromptFailure(adapterId, sessionId ?? paneId, error);
    recordWorkerPromptDeliveryFailure({
      scope: notice.scope,
      missionId: notice.missionId,
      paneId,
      sessionId: sessionId ?? null,
      adapterId,
      error,
    });
    // Só fecha se o pane ainda roda a sessão desta tentativa: um substituto
    // (resume) no mesmo paneId não é nosso. Pane `operatorOpened` (F-231)
    // nunca é fechado pela máquina — a mão do operador decide o destino.
    const bound = pendingSpawnAttemptSession(attempt.requestId);
    const attemptSessionId =
      sessionId ?? (bound.state === 'bound' ? bound.sessionId : null);
    if (
      notice.operatorOpened !== true &&
      attemptSessionId &&
      getPaneAuthzInfo(paneId)?.sessionId === attemptSessionId
    ) {
      try {
        await requestPaneClose(paneId);
      } catch {
        // best effort — o aviso abaixo é o que importa
      }
    }
    if (!invocation?.signal?.aborted) {
      try {
        emitWorkerSpawnFailed({
          missionId: notice.missionId ?? '',
          deadAdapterId: adapterId,
          message:
            'o briefing não foi entregue ao pane recém-aberto: ' +
            (error instanceof Error ? error.message : String(error)),
          title: notice.title,
          at: Date.now(),
          scope: notice.scope,
        });
      } catch {
        // aviso best-effort
      }
    }
    return false;
  }
}

export { waitOutBootPrompts } from './boot-prompt-hold';
