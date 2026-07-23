import {
  getPaneAuthzInfo,
  requestPaneClose,
  requestPaneSpawn,
  waitForIdle,
} from './pane-registry';
import {
  authorizePaneAccess,
  type PaneAction,
  type PaneAuthzInfo,
} from './pane-authz';
import type { AgentGateContext } from './gate';
import {
  getSessionState,
  orchTerminateSession,
  orchWriteSession,
  tapSessionData,
  tapSessionExit,
  tapSessionState,
} from '../pty/pty-manager';
import { getAdapter } from '../adapters/adapter-registry';
import { discoverCliModels } from '../adapters/cli-model-discovery';
import { resolveRoutableModel } from './task-router';
import { getProjectDomainStores } from './project-domain-store-registry';
import { LEGACY_MARKER } from './legacy-handoff';
import { PONYTAIL_RULES } from './ponytail';
import { ENGINEERING_CHARTER } from './engineering-charter';
import { composeDesignCharter } from './design-profile';
import { getOrchSettings } from '../persistence/settings-store';
import { resolveCwdForScope } from './workspace-path';
import { canUseNexusMcp } from './cli-mcp-inject';
import { cliPromptAutoResponder } from './cli-prompt-autoresponder';
import {
  isSafeOmpMissionPreflightFailure,
  spawnMissionOmpRpcWorker,
  terminateOmpRpcSession,
} from '../adapters/omp-rpc-ipc';
import { isAdapterInstalled } from '../adapters/adapter-registry';
import { hasAvailableAccount } from '../persistence/account-store';
import {
  buildOmpAutoSpawnPrompt,
  shouldAutoSpawnOmpCompanion,
} from './omp-roster-policy';
import { adapterCircuitBreakers } from './circuit-breaker';
import { assertPreSpawnProbe } from '../pty/pre-spawn-probe';
import { OmpAutoCompanionSingleFlight } from './omp-auto-companion-single-flight';
import { assertSafePtyPrompt } from './pty-prompt-safety';
import { isSessionInjectableIdle } from './agent-status';
import { listSquads } from './squad-store';
import { resolveMissionPaneAuthoritySeal } from './mission-pane-authority';
import {
  assertMcpInvocationCurrent,
  type McpToolInvocation,
} from './mcp-protocol';

export { assertSafePtyPrompt } from './pty-prompt-safety';

/** Shared argument helpers + pane-spawn plumbing for the MCP toolset. */

const PROMPT_SETTLE_MS = 250;
/** Janela para provar o submit: sessão ainda idle depois disto → CR comido. */
const ENTER_RETRY_MS = 400;
const AGENT_BOOT_TIMEOUT_MS = 20_000;
/** Max wait for Claude-family bypass/trust menus before typing the mission prompt. */
const BOOT_PROMPT_HOLD_MS = 5_000;
/**
 * After a brief is typed, the session must report busy within this window.
 * A still-idle session means a dialog with no autoresponder signature ate the
 * paste — re-deliver instead of letting the pane sit idle (every watchdog is
 * blind to idle panes: stall needs busy, login-stuck needs a busy transition).
 */
const PROMPT_ACCEPTANCE_WINDOW_MS = 12_000;
const ompAutoCompanionFlights = new OmpAutoCompanionSingleFlight();

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
 * Object-level authorization gate for the pane tools (SEC#5): resolve a pane
 * ref and confirm `ctx` may perform `action` on it. A worker cannot
 * read/write/close another agent's or the user's pane. Throws on unknown pane
 * or refusal. Returns the pane info (session may be dead — fine for `close`).
 */
export function authorizePaneRef(
  ctx: AgentGateContext,
  paneRef: string,
  action: PaneAction,
): PaneAuthzInfo {
  const info = getPaneAuthzInfo(paneRef);
  if (!info) throw new Error(`unknown pane: ${paneRef}`);
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
  onBeforeSubmit?: () => void,
  requireInjectableIdle = false,
): Promise<void> {
  let observedBusy = getSessionState(sessionId) === 'busy';
  const untapState = tapSessionState((changedSessionId, state) => {
    if (changedSessionId === sessionId && state === 'busy') observedBusy = true;
  });
  try {
    await delay(PROMPT_SETTLE_MS);
    if (requireInjectableIdle && !isSessionInjectableIdle(sessionId)) {
      throw new Error('agent pane is awaiting operator input');
    }
    assertMcpInvocationCurrent(invocation);
    onBeforeSubmit?.();
    orchWriteSession(sessionId, '\r', { markInputBusy: false });
    await delay(ENTER_RETRY_MS);
    if (
      !observedBusy &&
      (requireInjectableIdle
        ? isSessionInjectableIdle(sessionId)
        : getSessionState(sessionId) === 'idle')
    ) {
      assertMcpInvocationCurrent(invocation);
      orchWriteSession(sessionId, '\r', { markInputBusy: false });
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
): Promise<boolean> {
  // Never interleave a brief with boot or a turn already in progress. The
  // caller may retry only after an actual idle snapshot/edge.
  if (!isSessionInjectableIdle(sessionId)) return false;
  let observedBusy = false;
  let observedOutput = false;
  let submitted = false;
  let sessionExited = false;
  let settle: ((accepted: boolean) => void) | null = null;
  const maybeAccept = () => {
    if (observedBusy && observedOutput) settle?.(true);
  };
  const untapState = tapSessionState((changedSessionId, state) => {
    if (changedSessionId !== sessionId || !submitted || state !== 'busy') return;
    observedBusy = true;
    maybeAccept();
  });
  const untapData = tapSessionData((changedSessionId, data) => {
    if (changedSessionId !== sessionId || !submitted || data.length === 0) return;
    observedOutput = true;
    maybeAccept();
  });
  const untapExit = tapSessionExit((exitedSessionId) => {
    if (exitedSessionId !== sessionId) return;
    sessionExited = true;
    settle?.(false);
  });

  try {
    const safePrompt = assertSafePtyPrompt(prompt);
    const input = safePrompt.includes('\n')
      ? `\x1b[200~${safePrompt}\x1b[201~`
      : safePrompt;
    if (!isSessionInjectableIdle(sessionId)) return false;
    assertMcpInvocationCurrent(invocation);
    if (!orchWriteSession(sessionId, input, { markInputBusy: false })) {
      return false;
    }
    await submitEnter(
      sessionId,
      invocation,
      () => { submitted = true; },
      true,
    );
    if (observedBusy && observedOutput) return true;
    if (sessionExited || getSessionState(sessionId) === null) return false;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        settle = null;
        resolve(false);
      }, windowMs);
      settle = (accepted) => {
        clearTimeout(timer);
        settle = null;
        resolve(accepted);
      };
    });
  } finally {
    settle = null;
    untapState();
    untapData();
    untapExit();
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
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await waitOutBootPrompts(sessionId);
    // Linearization point after boot/menu waits and immediately before paste.
    assertMcpInvocationCurrent(invocation);
    if (
      await injectWithBusyProof(
        sessionId,
        prompt,
        PROMPT_ACCEPTANCE_WINDOW_MS,
        invocation,
      )
    ) {
      return;
    }
  }
  throw new Error('agent pane did not start after prompt delivery');
}

export interface SpawnToolOptions {
  adapterId: string;
  /** Main-selected vault identity; never let the renderer choose for missions. */
  accountId?: string;
  model?: string;
  /** Per-spawn reasoning effort (task-router decision). */
  effort?: string;
  cwd?: string;
  title?: string;
  missionId?: string;
  contextRevision?: string;
  agentName?: string;
  workerIncarnationId?: string;
  /** Squad role category (scout/executor/reviewer/…) — tiers the charters. */
  agentCategory?: string;
  allowedTools?: string[] | null;
  allowedSkills?: string[] | null;
  role?: 'orchestrator' | 'worker';
  prompt?: string;
  scope: AgentGateContext['scope'];
  executionScope?: AgentGateContext['executionScope'];
  readOnly?: boolean;
  /**
   * Internal: skip the zero-friction omp companion auto-spawn (used when this
   * spawn IS the companion, to prevent recursion).
   */
  suppressOmpAutoSpawn?: boolean;
}

/**
 * Lifecycle hooks for the host-side spawn transaction. The pane-created hook
 * fires immediately after the PTY exists and before mission composition is
 * persisted, so budget callers can retain a reservation if persistence fails.
 */
export interface SpawnPaneHooks {
  readonly onPaneCreated?: (paneId: string, sessionId: string) => void;
  /** Exact dispatch authority propagated across asynchronous preflight. */
  readonly invocation?: McpToolInvocation;
}

function requireMissionPaneAuthoritySeal(options: SpawnToolOptions) {
  if (!options.missionId) return undefined;
  const stores = getProjectDomainStores(options.scope);
  const mission = stores.missions.get(options.missionId);
  const squads = listSquads().filter(
    (candidate) => candidate.id === mission?.squadId,
  );
  const seal =
    mission && squads.length === 1
      ? resolveMissionPaneAuthoritySeal(options.scope, mission, squads[0])
      : null;
  if (!seal) {
    throw new Error(
      'mission pane authority seal is unavailable; replane and approve the current mission revision',
    );
  }
  return seal;
}

/**
 * UI-shaped work, detected on the task brief + pane title/agent name. Biased
 * generous (false positive = status quo ante: charter included); superset of
 * the contract-compiler UI_SIGNAL so design guidance never misses real UI.
 */
const WORKER_UI_SIGNAL =
  /\b(ui|ux|frontend|front-end|design|layout|estilo|style|styling|css|tailwind|component|componente|tsx|jsx|html|tela|p[aá]gina|bot[aã]o|modal|landing|website|interface|responsive|responsivo|acessibilidade|accessibility|dashboard|visual|dark ?mode|tema|theme|icon|[ií]cone)\b/i;

export interface HandoffContractHints {
  /** Squad role category — scouts/architects read and plan, they don't ship diffs. */
  category?: string;
  /** Extra corpus (title, agent name) for the UI-task detection. */
  hints?: Array<string | undefined>;
}

/** Charters only help roles that produce code/UI; for the rest they are noise. */
export function charterTierForWorker(
  input: { prompt: string } & HandoffContractHints,
): { engineering: boolean; design: boolean; lean: boolean } {
  const category = input.category?.toLowerCase();
  // Recon/planning roles deliver analysis, not diffs — build discipline and
  // diff-size rules only dilute their brief.
  if (category === 'scout' || category === 'architect') {
    return { engineering: false, design: false, lean: false };
  }
  const corpus = [input.prompt, ...(input.hints ?? [])]
    .filter(Boolean)
    .join('\n');
  const uiTask = WORKER_UI_SIGNAL.test(corpus);
  if (category === 'reviewer') {
    // Reviewers judge against the engineering bar (and may refine code), but
    // the ponytail diff ladder targets authors, not critics.
    return { engineering: true, design: uiTask, lean: false };
  }
  // Executors and unclassified spawns: full build discipline; design charter
  // only when the task actually touches UI (its own applicability rule).
  return { engineering: true, design: uiTask, lean: true };
}

/**
 * Append the handoff contract a WORKER must fulfil, matched to what its CLI
 * can actually do: MCP-wired adapters get the
 * nexus_handoff_submit tool; every other CLI has NO route to the embedded MCP
 * server, so its only completion signal is printing the legacy marker block —
 * without this instruction those workers finish silently and the orchestrator
 * waits forever.
 */
export function withHandoffContract(
  prompt: string,
  adapter: { quirks: Record<string, unknown> },
  hints: HandoffContractHints = {},
): string {
  const viaMcp = canUseNexusMcp(adapter);
  const contract = viaMcp
    ? 'Ao concluir sua tarefa, finalize chamando a tool nexus_handoff_submit ' +
      'com {status: "success"|"partial"|"failed", summary, artifacts}.'
    : 'Ao concluir sua tarefa, imprima EXATAMENTE este bloco como texto no ' +
      'terminal (é seu sinal de conclusão para o orquestrador):\n' +
      `${LEGACY_MARKER}\n` +
      '{"status":"success","summary":"<resumo objetivo do que fez>","artifacts":[]}';
  // Disciplina em camadas (toggles em Configurações › Squads): a Carta de
  // Engenharia dita o comportamento sênior (stack certa, gates verdes,
  // segurança, spec viva); o ponytail dita o tamanho do diff. O tier por
  // papel/tarefa mantém o prompt proporcional: missão curta não paga ~8 KB
  // de cartas que não se aplicam a ela.
  const orch = getOrchSettings();
  const tier = charterTierForWorker({ prompt, ...hints });
  const charter =
    orch.seniorMode && tier.engineering ? `\n\n${ENGINEERING_CHARTER}` : '';
  // A carta de design é composta com o perfil (direção + dials) do workspace;
  // perfil neutro degrada para a carta pura, sem custo extra de prompt.
  const design =
    orch.designPro && tier.design ? `\n\n${composeDesignCharter(orch)}` : '';
  const lean = orch.leanCode && tier.lean ? `\n\n${PONYTAIL_RULES}` : '';
  return `${prompt}${charter}${design}${lean}\n\n${contract}`;
}

/**
 * Fire-and-forget: after a non-omp worker starts, ensure one Oh My Pi worker
 * is also running on the mission — no Maestro/human required.
 */
function scheduleOmpAutoCompanion(
  options: SpawnToolOptions,
  workspaceRoot: string,
): void {
  if (options.suppressOmpAutoSpawn) return;
  if (!options.missionId) return;
  // An unconfined companion would silently widen a read-only task.
  if (options.readOnly === true) return;
  const settings = getOrchSettings();
  let missionHasOmp = false;
  try {
    missionHasOmp = getProjectDomainStores(options.scope)
      .missionPanes.list(options.missionId)
      .some((pane) => pane.adapterId === 'omp');
  } catch {
    missionHasOmp = false;
  }
  if (
    !shouldAutoSpawnOmpCompanion({
      ompParticipation: settings.ompParticipation,
      ompAutoSpawn: settings.ompAutoSpawn,
      ompInstalled: isAdapterInstalled('omp'),
      ompAvailable: hasAvailableAccount('omp'),
      justSpawnedAdapterId: options.adapterId,
      missionHasOmp,
      role: options.role,
    })
  ) {
    return;
  }
  const missionId = options.missionId;
  const prompt = buildOmpAutoSpawnPrompt({
    missionId,
    goalHint: options.prompt ?? options.title,
  });
  const missionKey = [
    options.scope.projectId,
    options.scope.checkoutId,
    missionId,
  ].join(':');
  ompAutoCompanionFlights.start(
    missionKey,
    async () => {
      await spawnPaneAndMaybePrompt({
        adapterId: 'omp',
        model: getAdapter('omp')?.models.default,
        effort: 'medium',
        cwd: workspaceRoot,
        executionScope: options.executionScope ?? options.scope,
        scope: options.scope,
        missionId,
        agentName: 'Oh My Pi (auto)',
        title: 'Oh My Pi · auto',
        role: 'worker',
        prompt,
        allowedTools: null,
        allowedSkills: null,
        suppressOmpAutoSpawn: true,
      });
    },
    (err) => {
      console.warn(
        '[spawn] omp auto-companion falhou (missão segue sem ele):',
        err instanceof Error ? err.message : err,
      );
    },
  );
}

export async function spawnPaneAndMaybePrompt(
  options: SpawnToolOptions,
  hooks: SpawnPaneHooks = {},
): Promise<{ paneId: string; sessionId: string }> {
  assertMcpInvocationCurrent(hooks.invocation);
  // The cli-rpc adapter IS the omp rpc transport: normalize to `omp` BEFORE
  // resolving anything else so the rest of the path (models, handoff
  // contract, transport branch) only ever sees the cli-pty omp adapter.
  // Grid-form RPC panes spawn via the renderer IPC route (pty-ipc), not here.
  if (options.adapterId === 'omp-rpc') {
    options = { ...options, adapterId: 'omp' };
  }
  const resolvedAdapter = getAdapter(options.adapterId);
  if (!resolvedAdapter) throw new Error(`unknown adapter: ${options.adapterId}`);
  if (resolvedAdapter.kind !== 'cli-pty') {
    // spawnPaneAndMaybePrompt only ever spawns terminal panes; api-provider
    // adapters have no pane representation and cli-rpc was normalized above.
    throw new Error(`adapter ${options.adapterId} is not spawnable as a pane`);
  }
  const adapter = resolvedAdapter;
  if (options.adapterId === 'omp' && options.readOnly === true) {
    throw new Error(
      'OMP does not provide enforceable read-only native confinement',
    );
  }
  // Pre-spawn credential probe (Overclock F-256 harvest): a spawn with a
  // missing credential used to surface as a dead pane or a mute login TUI.
  // Fail here — before any pane exists — with a typed, actionable error.
  // Cheap (<50ms, no network) and never judges what it cannot prove.
  await assertPreSpawnProbe(options.adapterId);
  assertMcpInvocationCurrent(hooks.invocation);
  // Circuit half-open / closed only for auto traffic; explicit spawns still try.
  // Failures below trip the breaker for future routeTask multi-score.
  // Defesa em profundidade contra modelo-fantasma (caso de campo 17/07): a
  // superfície de seleção (dropdown do squad, roster, route_task) podia oferecer
  // um id que o CLI instalado não roda (ex.: `gpt-5.6` depois da OpenAI
  // renomear para `gpt-5.6-sol`/`-luna`/`-terra`). Sem isto o CLI ignora o
  // pedido e cai SILENCIOSAMENTE no seu default (`gpt-5.5`), fazendo o modelo
  // escolhido pelo usuário NÃO valer. Aqui, imediatamente antes do PTY,
  // resolvemos o modelo contra a lista REAL do CLI (cache do próprio CLI quando
  // existe; senão a lista estática do adapter): id exato quando roda, senão a
  // 1ª variante da mesma família. Sem variante, mantém o pedido (não piora).
  const runnableModels =
    discoverCliModels().get(options.adapterId) ?? adapter.models.list;
  const modelResolution = resolveRoutableModel(options.model, runnableModels);
  const effectiveModel = modelResolution.ok ? modelResolution.model : options.model;
  if (
    options.model &&
    modelResolution.ok &&
    modelResolution.model !== options.model
  ) {
    console.warn(
      `[spawn] ${options.adapterId}:${options.model} não é um modelo que o CLI roda; ` +
        `usando a variante real ${modelResolution.model ?? '(default)'}.`,
    );
  }
  // Agent CLIs can read and execute native tools. Pin every orchestrated spawn
  // to the active workspace before the renderer/PTY boundary; never inherit
  // pty-manager's user-shell fallback to HOME.
  const safeOptions: SpawnToolOptions = {
    ...options,
    model: effectiveModel,
    executionScope: options.executionScope ?? options.scope,
    cwd: resolveCwdForScope(options.executionScope ?? options.scope, options.cwd),
  };
  const authoritySeal = requireMissionPaneAuthoritySeal(options);

  // Oh My Pi dual transport: rpc-ui for deterministic lifecycle, PTY for full
  // MCP inject. `auto` prefers rpc and falls back to PTY on failure.
  if (options.adapterId === 'omp' && options.role !== 'orchestrator') {
    const transport = getOrchSettings().ompMissionTransport;
    if (transport === 'rpc' || transport === 'auto') {
      try {
        assertMcpInvocationCurrent(hooks.invocation);
        const prompt = options.prompt
          ? withHandoffContract(options.prompt, adapter, {
              category: options.agentCategory,
              hints: [options.title, options.agentName],
            })
          : undefined;
        const rpc = await spawnMissionOmpRpcWorker({
          scope: options.scope,
          executionScope: {
            ...(safeOptions.executionScope ?? options.scope),
          },
          missionId: options.missionId,
          model: effectiveModel,
          title: options.title,
          agentName: options.agentName,
          workerIncarnationId: options.workerIncarnationId,
          prompt,
          // Unattended mission path: audited yolo (safe hangs without UI attach).
          approvalPolicy: 'yolo',
          allowedTools: options.allowedTools,
          signal: hooks.invocation?.signal,
          assertCurrentAuthority:
            hooks.invocation?.assertCurrentAuthority,
          onSessionReady: (paneId, sessionId) => {
            // Bind the dispatch before the first OMP prompt can emit
            // agent_start and a same-turn handoff.
            hooks.onPaneCreated?.(paneId, sessionId);
          },
          onAccepted: (paneId) => {
            // Persist composition only after agent_start. A rejected prompt
            // must not leave a dead pane identity that blocks safe recovery.
            if (options.missionId) {
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
                paneId,
              });
            }
          },
        });
        try {
          assertMcpInvocationCurrent(hooks.invocation);
        } catch (error) {
          await terminateOmpRpcSession(rpc.sessionId);
          throw error;
        }
        // rpc path already is omp — no companion needed.
        adapterCircuitBreakers.recordSuccess(options.adapterId);
        return rpc;
      } catch (err) {
        adapterCircuitBreakers.recordFailure(options.adapterId);
        if (transport === 'rpc' || !isSafeOmpMissionPreflightFailure(err)) {
          throw err;
        }
        console.warn(
          '[spawn] preflight omp rpc-ui falhou; caindo para PTY:',
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  assertMcpInvocationCurrent(hooks.invocation);
  const result = await requestPaneSpawn({
    ...safeOptions,
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
  adapterCircuitBreakers.recordSuccess(options.adapterId);
  hooks.onPaneCreated?.(result.paneId, result.sessionId);
  // Remember the mission's composition so it can be reopened from history.
  if (options.missionId) {
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
  if (options.prompt) {
    // Let the CLI finish booting before typing (first idle or timeout).
    const boot = await waitForIdle(result.sessionId, AGENT_BOOT_TIMEOUT_MS);
    const prompt =
      options.role === 'orchestrator'
        ? options.prompt
        : withHandoffContract(options.prompt, adapter, {
            category: options.agentCategory,
            hints: [options.title, options.agentName],
          });
    try {
      assertMcpInvocationCurrent(hooks.invocation);
      if (boot === 'exited') {
        throw new Error('agent session exited during boot');
      }
      // 'idle' or 'timeout' (slow boot): deliver and prove acceptance —
      // a swallowed brief used to leave a zombie worker no watchdog can see.
      await deliverAgentPrompt(
        result.sessionId,
        prompt,
        hooks.invocation,
      );
    } catch (error) {
      // Never leave a mute zombie pane occupying a mission worker slot. The
      // durable row remains as audit history, but a fenced worker incarnation
      // is never respawned as a different physical process.
      try {
        await requestPaneClose(result.paneId);
      } catch {
        // best effort — the original error matters more
      }
      throw error;
    }
  }
  // Zero-friction: first non-omp mission worker also pulls Oh My Pi online.
  scheduleOmpAutoCompanion(
    options,
    safeOptions.cwd ?? options.scope.rootRealPath,
  );
  return { paneId: result.paneId, sessionId: result.sessionId };
}

/**
 * Block inject while a known interactive boot prompt is visible or just
 * accepted. If the menu is still up after maxMs, force-dismiss it (Down+Enter,
 * then numeric "2") so we never type the mission brief into the dialog.
 */
export async function waitOutBootPrompts(
  sessionId: string,
  maxMs = BOOT_PROMPT_HOLD_MS,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (
    cliPromptAutoResponder.shouldDeferInjection(sessionId) &&
    Date.now() < deadline
  ) {
    await delay(50);
  }
  if (!cliPromptAutoResponder.shouldDeferInjection(sessionId)) return;

  const forced = cliPromptAutoResponder.forceAcceptResponse(sessionId);
  if (forced) {
    orchWriteSession(sessionId, forced.response);
    if (forced.fallbackResponse) {
      await delay(120);
      // Some Claude Code builds ignore the primary keys on numbered menus.
      orchWriteSession(sessionId, forced.fallbackResponse);
    }
  }
  const settleDeadline = Date.now() + 600;
  while (
    cliPromptAutoResponder.shouldDeferInjection(sessionId) &&
    Date.now() < settleDeadline
  ) {
    await delay(50);
  }
}
