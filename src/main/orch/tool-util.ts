import {
  getPaneAuthzInfo,
  requestPaneSpawn,
  waitForIdle,
} from './pane-registry';
import {
  authorizePaneAccess,
  type PaneAction,
  type PaneAuthzInfo,
} from './pane-authz';
import type { AgentGateContext } from './gate';
import { orchWriteSession } from '../pty/pty-manager';
import { getAdapter } from '../adapters/adapter-registry';
import { getProjectDomainStores } from './project-domain-store-registry';
import { LEGACY_MARKER } from './legacy-handoff';
import { PONYTAIL_RULES } from './ponytail';
import { ENGINEERING_CHARTER } from './engineering-charter';
import { composeDesignCharter } from './design-profile';
import { getOrchSettings } from '../persistence/settings-store';
import { resolveCwdForScope } from './workspace-path';
import { canUseNexusMcp } from './cli-mcp-inject';
import {
  ACCEPT_SECOND_OPTION_BY_NUMBER,
  cliPromptAutoResponder,
} from './cli-prompt-autoresponder';

/** Shared argument helpers + pane-spawn plumbing for the MCP toolset. */

const PROMPT_SETTLE_MS = 250;
const AGENT_BOOT_TIMEOUT_MS = 20_000;
/** Max wait for Claude-family bypass/trust menus before typing the mission prompt. */
const BOOT_PROMPT_HOLD_MS = 5_000;
const UNSAFE_TERMINAL_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reject bytes that can escape bracketed paste or submit/cancel PTY input. */
export function assertSafePtyPrompt(prompt: string): string {
  if (UNSAFE_TERMINAL_CONTROL.test(prompt)) {
    throw new Error('unsafe terminal control in prompt');
  }
  return prompt;
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
): Promise<void> {
  const safePrompt = assertSafePtyPrompt(prompt);
  // Agent briefs routinely contain Markdown and many newlines. Sending those
  // bytes as ordinary keypresses makes interactive TUIs execute/repaint each
  // line independently, producing the mashed, apparently frozen terminal.
  // Bracketed paste makes the entire brief one editor transaction.
  const input = safePrompt.includes('\n')
    ? `\x1b[200~${safePrompt}\x1b[201~`
    : safePrompt;
  if (!orchWriteSession(sessionId, input)) {
    throw new Error('session is gone');
  }
  await delay(PROMPT_SETTLE_MS);
  orchWriteSession(sessionId, '\r');
}

/** Type a multi-line prompt as one bracketed-paste transaction. */
export async function injectPastedPrompt(
  sessionId: string,
  prompt: string,
): Promise<void> {
  const safePrompt = assertSafePtyPrompt(prompt);
  if (!orchWriteSession(sessionId, `\x1b[200~${safePrompt}\x1b[201~`)) {
    throw new Error('session is gone');
  }
  await delay(PROMPT_SETTLE_MS);
  orchWriteSession(sessionId, '\r');
}

export interface SpawnToolOptions {
  adapterId: string;
  model?: string;
  /** Per-spawn reasoning effort (task-router decision). */
  effort?: string;
  cwd?: string;
  title?: string;
  missionId?: string;
  contextRevision?: string;
  agentName?: string;
  /** Squad role category (scout/executor/reviewer/…) — tiers the charters. */
  agentCategory?: string;
  allowedTools?: string[] | null;
  allowedSkills?: string[] | null;
  role?: 'orchestrator' | 'worker';
  prompt?: string;
  scope: AgentGateContext['scope'];
  executionScope?: AgentGateContext['executionScope'];
  readOnly?: boolean;
}

/**
 * Lifecycle hooks for the host-side spawn transaction. The pane-created hook
 * fires immediately after the PTY exists and before mission composition is
 * persisted, so budget callers can retain a reservation if persistence fails.
 */
export interface SpawnPaneHooks {
  readonly onPaneCreated?: (paneId: string, sessionId: string) => void;
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

export async function spawnPaneAndMaybePrompt(
  options: SpawnToolOptions,
  hooks: SpawnPaneHooks = {},
): Promise<{ paneId: string; sessionId: string }> {
  const adapter = getAdapter(options.adapterId);
  if (!adapter) throw new Error(`unknown adapter: ${options.adapterId}`);
  // Agent CLIs can read and execute native tools. Pin every orchestrated spawn
  // to the active workspace before the renderer/PTY boundary; never inherit
  // pty-manager's user-shell fallback to HOME.
  const safeOptions: SpawnToolOptions = {
    ...options,
    executionScope: options.executionScope ?? options.scope,
    cwd: resolveCwdForScope(options.executionScope ?? options.scope, options.cwd),
  };
  const result = await requestPaneSpawn(safeOptions);
  if (!result.ok || !result.paneId || !result.sessionId) {
    throw new Error(result.error ?? 'pane spawn failed');
  }
  hooks.onPaneCreated?.(result.paneId, result.sessionId);
  // Remember the mission's composition so it can be reopened from history.
  if (options.missionId) {
    getProjectDomainStores(options.scope).missionPanes.record({
      missionId: options.missionId,
      adapterId: options.adapterId,
      model: options.model,
      effort: options.effort,
      cwd: safeOptions.cwd,
      executionScope: safeOptions.executionScope,
      title: options.title,
      agentName: options.agentName,
      role: options.role ?? 'worker',
      allowedTools: options.allowedTools,
      allowedSkills: options.allowedSkills,
      // Chave do resume direcionado: o reopen reusa este paneId para o CLI
      // voltar à MESMA conversa (não à mais recente do cwd).
      paneId: result.paneId,
    });
  }
  if (options.prompt) {
    // Let the CLI finish booting before typing (first idle or timeout).
    await waitForIdle(result.sessionId, AGENT_BOOT_TIMEOUT_MS);
    // Claude / GLM / Longcat can still paint the Bypass Permissions menu after
    // "idle" (static TUI). Never type the mission brief into that dialog.
    await waitOutBootPrompts(result.sessionId);
    const prompt =
      options.role === 'orchestrator'
        ? options.prompt
        : withHandoffContract(options.prompt, adapter, {
            category: options.agentCategory,
            hints: [options.title, options.agentName],
          });
    await injectPrompt(result.sessionId, prompt);
  }
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
    orchWriteSession(sessionId, forced);
    await delay(120);
    // Some Claude Code builds ignore Down+Enter on the numbered menu.
    orchWriteSession(sessionId, ACCEPT_SECOND_OPTION_BY_NUMBER);
  }
  const settleDeadline = Date.now() + 600;
  while (
    cliPromptAutoResponder.shouldDeferInjection(sessionId) &&
    Date.now() < settleDeadline
  ) {
    await delay(50);
  }
}
