import { withWorkspaceDesignRule } from './workspace-design-rule';
import {
  getPaneAuthzInfo,
  listLivePaneNumbers,
  readSessionOutput,
  requestPaneClose,
  requestPaneSpawn,
  waitForIdle,
} from './pane-registry';
import { parsePaneNumberRef } from '../../shared/pane-number';
import {
  authorizePaneAccess,
  type PaneAction,
  type PaneAuthzInfo,
} from './pane-authz';
import type { AgentGateContext } from './gate';
import {
  getAgentSessionInfo,
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
import { emitWorkerSpawnFailed } from './spawn-fail-events';
import { getAdapter } from '../adapters/adapter-registry';
import { discoverCliModels } from '../adapters/cli-model-discovery';
import {
  isRoutableModelResolution,
  resolveRoutableModel,
} from './task-router';
import { getProjectDomainStores } from './project-domain-store-registry';
import { hasBoundHandoffForExactDispatchWorker } from './task-dispatch-codec';
import { migrateModelId } from '../../shared/model-defaults';
import { resolveCwdForScope } from './workspace-path';
import { withHandoffContract } from './worker-handoff-contract';
import {
  assertReleaseQualifiedMissionWorkerSpawn,
  isRevisionBoundWritableWorkerAdapterAllowed,
} from './mission-worker-spawn-authority';
import { waitOutBootPrompts } from './boot-prompt-hold';
import { adapterCircuitBreakers } from './circuit-breaker';
import { assertPreSpawnProbe } from '../pty/pre-spawn-probe';
import { classifySeatAuth } from '../adapters/seat-auth-readiness';
import { detectSubscriptionAuthReadiness } from '../adapters/subscription-auth';
import {
  hasRuntimeKey,
  providerAuthStrategy,
} from '../persistence/provider-config-store';
import {
  isCredentialProbeFailure,
  settleSeatAfterCredentialFailure,
} from './spawn-seat-fallback';
import { assertSafePtyPrompt } from './pty-prompt-safety';
import {
  getAgentTurnStartSequence,
  isSessionInjectableIdle,
  tapAgentTurnStart,
} from './agent-status';
import { listSquads } from './squad-store';
import { resolveMissionPaneAuthoritySeal } from './mission-pane-authority';
import {
  assertMcpInvocationCurrent,
  type McpToolInvocation,
} from './mcp-protocol';
import type { MissionPaneAuthoritySeal } from '../../shared/orch-types';
import { sanitizeMissionOrchestratorExitOutput } from './mission-orchestrator-exit-policy';
import {
  autoRecallPhaseForAgent,
  withAutoRecalledWorkspaceMemory,
} from '../memory/workspace-memory-context';
import { getOrchSettings } from '../persistence/settings-store';
import { isOperatorChoicePolicy } from '../../shared/squad-cli-policy';
import { issueAgentIdentityBestEffort } from './agent-identity-spawn';
import { initialPromptChannel, spawnBinaryName } from '../../shared/cli-initial-prompt';

export { assertSafePtyPrompt } from './pty-prompt-safety';

/** Shared argument helpers + pane-spawn plumbing for the MCP toolset. */

// Interactive agent editors need one repaint after bracketed paste before
// Enter. Claude and Codex both exhibit swallowed submits below ~500 ms on a
// cold TUI; Orca uses the same bounded settle without weakening acceptance
// proof or any authority recheck.
const PROMPT_SETTLE_MS = 500;
/** Janela para provar o submit: sessão ainda idle depois disto → CR comido. */
const ENTER_RETRY_MS = 400;
// Wait for the CLI's first idle before typing. Expiring early types the brief
// into a terminal that is still booting, so the prompt is swallowed and the
// pane sits idle while every watchdog waits for a busy transition.
const AGENT_BOOT_TIMEOUT_MS = 120_000;
/** Max wait for Claude-family bypass/trust menus before typing the mission prompt. */
/**
 * After a brief is typed, the session must report busy within this window.
 * A still-idle session means a dialog with no autoresponder signature ate the
 * paste — re-deliver instead of letting the pane sit idle (every watchdog is
 * blind to idle panes: stall needs busy, login-stuck needs a busy transition).
 */
const PROMPT_ACCEPTANCE_WINDOW_MS = 12_000;
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
function unknownPaneMessage(paneRef: string): string {
  if (parsePaneNumberRef(paneRef) === null) return `unknown pane: ${paneRef}`;
  const valid = listLivePaneNumbers();
  return valid.length === 0
    ? `unknown pane: ${paneRef} (no numbered pane is open)`
    : `unknown pane: ${paneRef} (valid pane numbers: ${valid.join(', ')})`;
}

/**
 * Object-level authorization gate for the pane tools (SEC#5): resolve a pane
 * ref and confirm `ctx` may perform `action` on it. Inside the caller's
 * mission any pane may read any other (including the orchestrator); workers
 * still cannot write/close the orchestrator or touch the user's shell/browser.
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
  if (!info) throw new Error(unknownPaneMessage(paneRef));
  const decision = authorizePaneAccess(ctx, info, action);
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
  return info.sessionId;
}

/** Type text into a pane's PTY, then press Enter (as a user would). */
export async function injectPrompt(
  sessionId: string,
  prompt: string,
  invocation?: McpToolInvocation,
): Promise<void> {
  const safePrompt = assertSafePtyPrompt(prompt);
  // Agent briefs routinely contain Markdown and many newlines. Sending those
  // bytes as ordinary keypresses makes interactive TUIs execute/repaint each
  // line independently, producing the mashed, apparently frozen terminal.
  // Bracketed paste makes the entire brief one editor transaction.
  const input = safePrompt.includes('\n')
    ? `\x1b[200~${safePrompt}\x1b[201~`
    : safePrompt;
  assertMcpInvocationCurrent(invocation);
  if (!orchWriteSession(sessionId, input, { markInputBusy: false })) {
    throw new Error('session is gone');
  }
  await submitEnter(sessionId, invocation);
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
): Promise<void> {
  let observedBusy = getSessionState(sessionId) === 'busy';
  const untapState = tapSessionState((changedSessionId, state) => {
    if (changedSessionId === sessionId && state === 'busy') observedBusy = true;
  });
  try {
    await delay(PROMPT_SETTLE_MS);
    if (requireInjectableIdle && !isSessionInjectableIdle(sessionId)) {
      // After bracketed paste some CLIs flip to busy/semantic non-idle before
      // Enter; that is progress, not a permission modal. Only fail closed when
      // the session is still not busy and never observed a busy edge.
      const state = getSessionState(sessionId);
      if (state !== 'busy' && !observedBusy) {
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
      }
    });
    try {
      const firstEnter = orchWriteSession(sessionId, '\r', { markInputBusy: false });
      if (!firstEnter) {
        throw new Error('agent prompt Enter was not delivered to the PTY');
      }
      await delay(ENTER_RETRY_MS);
      const isIdleNow = requireInjectableIdle
        ? isSessionInjectableIdle(sessionId)
        : getSessionState(sessionId) === 'idle';
      if (!enterAcceptedBusy && isIdleNow) {
        assertMcpInvocationCurrent(invocation);
        if (onBeforeSubmit?.() === false) return;
        const secondEnter = orchWriteSession(sessionId, '\r', { markInputBusy: false });
        if (!secondEnter) {
          throw new Error('agent prompt Enter was not delivered to the PTY');
        }
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
        const exited = await orchTerminateSession(sessionId);
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
    untapState();
  }
}

/** Type a multi-line prompt as one bracketed-paste transaction. */
export async function injectPastedPrompt(
  sessionId: string,
  prompt: string,
  invocation?: McpToolInvocation,
): Promise<void> {
  const safePrompt = assertSafePtyPrompt(prompt);
  assertMcpInvocationCurrent(invocation);
  if (!orchWriteSession(
    sessionId,
    `\x1b[200~${safePrompt}\x1b[201~`,
    { markInputBusy: false },
  )) {
    throw new Error('session is gone');
  }
  await submitEnter(sessionId, invocation);
}

async function assertAcceptedPromptAuthority(
  sessionId: string,
  invocation?: McpToolInvocation,
): Promise<void> {
  try {
    assertMcpInvocationCurrent(invocation);
  } catch (error) {
    const exited = await orchTerminateSession(sessionId);
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
  const hasAcceptanceProof = () =>
    requireTurnStartProof
      ? turnStartObserved || sustainedPhysicalTurn
      : (postSubmitBusy || (submitted && observedBusy)) && observedOutput;
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
  });
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
    const agent = getAgentSessionInfo(sessionId);
    const adapter = agent?.adapterId ? getAdapter(agent.adapterId) : null;
    const allowsBracketedPaste =
      (adapter && adapter.kind === 'cli-pty' ? adapter.promptInjection?.bracketedPaste : undefined) ??
      (agent?.adapterId ? !['kimi', 'agy', 'devin'].includes(agent.adapterId) : true);
    const input =
      safePrompt.includes('\n') && allowsBracketedPaste
        ? `\x1b[200~${safePrompt}\x1b[201~`
        : safePrompt;
    if (!isSessionInjectableIdle(sessionId)) return false;
    assertMcpInvocationCurrent(invocation);
    if (!orchWriteSession(sessionId, input, { markInputBusy: false })) {
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
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await waitOutBootPrompts(sessionId);
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
          if (getSessionState(sessionId) === 'busy') finish(true);
          else edgeArmed = false;
        }, NATIVE_ARGV_ACTIVITY_CONFIRM_MS);
      } else if (state === 'idle' && edgeArmed) {
        // Repaint burst settled without a stream: re-arm for a real edge.
        if (confirmTimer) clearTimeout(confirmTimer);
        confirmTimer = null;
        edgeArmed = false;
      }
    });
    const untapData = tapSessionData((changedSessionId, data) => {
      // The chunk that caused the busy edge arrives before the state tap, so
      // only data after the edge counts — a lone repaint frame never does.
      if (changedSessionId !== sessionId || data.length === 0 || !edgeArmed) {
        return;
      }
      dataAfterEdge += 1;
      if (dataAfterEdge >= 2) finish(true);
    });
    const untapExit = tapSessionExit((exitedSessionId) => {
      if (exitedSessionId === sessionId) finish(false);
    });
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
 * has no delivery receipt, so acceptance is observed on the PTY: boot held
 * busy, a confirmed busy edge, or the exact worker's durable handoff. An
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
  // Boot output never settled: the provider is already streaming the turn.
  if (boot === 'timeout' && getSessionState(sessionId) === 'busy') return;
  assertMcpInvocationCurrent(invocation);
  if (
    await waitForAgentActivity(
      sessionId,
      NATIVE_ARGV_PROMPT_ACTIVITY_WINDOW_MS,
      invocation?.signal,
    )
  ) {
    return;
  }
  // The activity wait also resolves false on physical session exit.
  if (handoffDelivered()) return;
  assertMcpInvocationCurrent(invocation);
  const rescued = await submitPendingAgentPrompt(sessionId, invocation, {
    adapterId,
    windowMs: PROMPT_ACCEPTANCE_WINDOW_MS,
  });
  // A busy session here means the turn opened while the proof was pending —
  // re-typing the brief would interleave with live work.
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
): Promise<void> {
  await ensureNativeArgvPromptAccepted(sessionId, finalPrompt, adapterId);
}

export interface SpawnToolOptions {
  adapterId: string;
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
  /**
   * "Escolha livre de agentes" da missão (contract-sealed). Propagado ao
   * backstop físico assertReleaseQualifiedMissionWorkerSpawn para que o gate de
   * CLI release-qualified honre o opt-in por missão mesmo sob `governed`.
   */
  freeAgentChoice?: boolean;
  prompt?: string;
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
  /** Exact dispatch authority propagated across asynchronous preflight. */
  readonly invocation?: McpToolInvocation;
}

function requireMissionPaneAuthoritySeal(options: SpawnToolOptions) {
  if (!options.missionId) return undefined;
  const mission = getProjectDomainStores(options.scope).missions.get(
    options.missionId,
  );
  const squads = listSquads().filter(
    (candidate) => candidate.id === mission?.squadId,
  );
  const seal =
    mission && squads.length === 1
      ? resolveMissionPaneAuthoritySeal(options.scope, mission, squads[0])
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
  const sealedModel = migrateModelId(rawModel);
  let effectiveModel = sealedModel ?? options.model;
  if (sealedModel) {
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
  assertMcpInvocationCurrent(hooks.invocation);
  if (options.missionId && options.role) {
    // Best-effort only: never block spawn on attestation vault (pre-PTY slim).
    issueAgentIdentityBestEffort({
      missionId: options.missionId,
      scope: options.scope,
      agentId: options.agentName?.trim() || adapter.id,
    });
  }
  if (options.missionId && options.prompt) {
    options = {
      ...options,
      prompt: withAutoRecalledWorkspaceMemory(
        options.scope,
        options.prompt,
        autoRecallPhaseForAgent(options),
      ),
    };
  }
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
          // C-194.1: todo worker de missão com MCP tem fechamento mecânico
          // (turn-end-handoff colhe o fim de turno via /hook/status) — o
          // contrato ensina a regra condicional, não "sempre chame a tool".
          systemDelivers:
            options.role === 'worker' && Boolean(options.missionId),
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
      (options.role === 'worker' || promptChannel.kind === 'positional'),
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
    ...(hooks.invocation?.signal
      ? { abortSignal: hooks.invocation.signal }
      : {}),
  });
  if (!result.ok || !result.paneId || !result.sessionId) {
    adapterCircuitBreakers.recordFailure(options.adapterId);
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
  adapterCircuitBreakers.recordSuccess(options.adapterId);
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
    getProjectDomainStores(options.scope).missionPanes.record({
      missionId: options.missionId,
      adapterId: options.adapterId,
      model: effectiveModel,
      accountId: options.accountId,
      effort: options.effort,
      cwd: safeOptions.cwd,
      executionScope: safeOptions.executionScope,
      title: options.title,
      agentName: options.agentName,
      workerIncarnationId: options.workerIncarnationId,
      role: options.role ?? 'worker',
      allowedTools: options.allowedTools,
      allowedSkills: options.allowedSkills,
      readOnly: options.readOnly,
      authoritySeal,
      // Chave do resume direcionado: o reopen reusa este paneId para o CLI
      // voltar à MESMA conversa (não à mais recente do cwd).
      paneId: result.paneId,
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
      try {
        await requestPaneClose(result.paneId);
      } catch {
        // best effort — the original error matters more
      }
      throw error;
    }
  }
  return { paneId: result.paneId, sessionId: result.sessionId };
}

export { waitOutBootPrompts } from './boot-prompt-hold';
