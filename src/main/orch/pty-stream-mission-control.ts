import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { PaneSessionState } from "../../shared/types";
import { extractJsonObject } from "./legacy-handoff";

const ACTION_MARKER_PREFIX = "### NEXUS_ACTION v1 ";
const MAX_ACTION_BLOCK_CHARS = 256 * 1024;
const MAX_RESULT_CHARS = 32 * 1024;
const RESULT_SUBMIT_DELAY_MS = 150;
const RESULT_RETRY_DELAY_MS = 400;
const RESULT_ACCEPTANCE_WINDOW_MS = 12_000;
const MAX_TRACKED_CALLS = 1_024;

const ptyStreamMissionActionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9._:-]+$/u),
    tool: z
      .string()
      .min(1)
      .max(128)
      .regex(/^nexus_[a-z0-9_]+$/u),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();

export type PtyStreamMissionAction = z.infer<
  typeof ptyStreamMissionActionSchema
>;

export interface PtyStreamMissionActionOutcome {
  readonly ok: boolean;
  readonly tool: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly denied?: boolean;
  readonly requiredConfirmation?: boolean;
  readonly confirmationReason?: string;
  readonly effectMayHaveCommitted?: boolean;
}

export interface PtyStreamMissionControlPorts {
  readonly createChannelId?: () => string;
  readonly invoke: (
    sessionId: string,
    request: PtyStreamMissionAction,
  ) => Promise<PtyStreamMissionActionOutcome>;
  readonly isAuthorized: (sessionId: string) => boolean;
  readonly isInjectableIdle: (sessionId: string) => boolean;
  readonly write: (
    sessionId: string,
    data: string,
    options: { readonly markInputBusy: false },
  ) => boolean;
}

interface PendingResult {
  readonly callId: string;
  readonly text: string;
  pasted: boolean;
  submitted: boolean;
  attempts: number;
  submitTimer?: ReturnType<typeof setTimeout>;
  acceptanceTimer?: ReturnType<typeof setTimeout>;
}

interface MissionControlChannel {
  readonly id: string;
  pendingText: string;
  collectingText: string | null;
  readonly callSignatures: Map<string, string>;
  invocationFlight: Promise<void>;
  readonly results: PendingResult[];
}

function actionMarker(channelId: string): string {
  return `${ACTION_MARKER_PREFIX}${channelId}`;
}

function safeOutcomeJson(
  callId: string,
  outcome: PtyStreamMissionActionOutcome,
): string {
  let serialized: string;
  try {
    serialized = JSON.stringify({
      id: callId,
      ok: outcome.ok,
      tool: outcome.tool,
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.denied ? { denied: true } : {}),
      ...(outcome.requiredConfirmation
        ? { requiredConfirmation: true }
        : {}),
      ...(outcome.confirmationReason
        ? { confirmationReason: outcome.confirmationReason }
        : {}),
      ...(outcome.effectMayHaveCommitted
        ? { effectMayHaveCommitted: true }
        : {}),
    });
  } catch {
    serialized = JSON.stringify({
      id: callId,
      ok: false,
      tool: outcome.tool,
      error: "A resposta Nexus não pôde ser serializada.",
    });
  }
  if (serialized.length <= MAX_RESULT_CHARS) return serialized;
  return JSON.stringify({
    id: callId,
    ok: outcome.ok,
    tool: outcome.tool,
    resultTruncated: true,
    preview: serialized.slice(0, MAX_RESULT_CHARS - 512),
    ...(outcome.effectMayHaveCommitted
      ? { effectMayHaveCommitted: true }
      : {}),
  });
}

function formatResult(
  callId: string,
  outcome: PtyStreamMissionActionOutcome,
): string {
  const warning = outcome.effectMayHaveCommitted
    ? "\nA ação pode ter sido aplicada. Não repita cegamente; consulte o estado antes de decidir."
    : "";
  return (
    `[NEXUS_RESULT v1 id=${callId}]\n` +
    `${safeOutcomeJson(callId, outcome)}${warning}\n` +
    "Continue a missão a partir deste resultado Main-owned."
  );
}

function invalidInvocationOutcome(
  request: PtyStreamMissionAction,
  error: unknown,
): PtyStreamMissionActionOutcome {
  return {
    ok: false,
    tool: request.tool,
    error:
      error instanceof Error
        ? error.message
        : "Falha interna ao executar a ação Nexus.",
  };
}

/**
 * Bidirectional, provider-independent Maestro control over an observable PTY.
 *
 * Terminal text carries only a request envelope. Session/mission/scope/role
 * authority always comes from Main's current PTY bearer, and the caller-supplied
 * tool/args still traverse the central Nexus dispatcher.
 */
export class PtyStreamMissionControl {
  private readonly channels = new Map<string, MissionControlChannel>();

  constructor(private readonly ports: PtyStreamMissionControlPorts) {}

  ensureChannel(sessionId: string): string {
    const existing = this.channels.get(sessionId);
    if (existing) return existing.id;
    const channel: MissionControlChannel = {
      id:
        this.ports.createChannelId?.() ??
        randomBytes(18).toString("base64url"),
      pendingText: "",
      collectingText: null,
      callSignatures: new Map(),
      invocationFlight: Promise.resolve(),
      results: [],
    };
    this.channels.set(sessionId, channel);
    return channel.id;
  }

  instructionsForSession(sessionId: string): string {
    const channelId = this.ensureChannel(sessionId);
    return [
      "## Canal Nexus Main-owned (fallback PTY)",
      "Se as tools Nexus não aparecerem no cliente MCP, use este canal. Ele executa a mesma validação, auditoria, budget e confirmação do Nexus; não use shell para imitar ações Nexus.",
      "- standard: nexus_task, nexus_handoff_list e nexus_handoff_ack.",
      "- plan: nexus_plan_write e nexus_handoff_submit.",
      "- ops: nexus_terminal_run, nexus_bg_run/wait/kill e nexus_mission_set_status.",
      "- handoff final: nexus_handoff_submit funciona por este canal sem MCP.",
      "Para UMA ação, responda somente com o bloco abaixo, trocando id/tool/args pelos valores reais, e pare o turno. O Nexus enviará o resultado como a próxima mensagem:",
      actionMarker(channelId),
      '{"id":"<id-unico>","tool":"<nexus_tool>","args":{}}',
      "O exemplo acima é propositalmente inválido e nunca é executado.",
    ].join("\n");
  }

  hasChannel(sessionId: string): boolean {
    return this.channels.has(sessionId);
  }

  isCollecting(sessionId: string): boolean {
    const channel = this.channels.get(sessionId);
    return channel ? channel.collectingText !== null : false;
  }

  feed(sessionId: string, chunk: string): void {
    const channel = this.channels.get(sessionId);
    if (!channel || !this.ports.isAuthorized(sessionId)) return;
    if (channel.collectingText !== null) {
      this.collect(sessionId, channel, chunk);
      return;
    }
    const buffered = channel.pendingText + chunk;
    const marker = actionMarker(channel.id);
    const markerIndex = buffered.indexOf(marker);
    if (markerIndex < 0) {
      channel.pendingText = buffered.slice(-(marker.length - 1));
      return;
    }
    channel.pendingText = "";
    channel.collectingText = "";
    this.collect(
      sessionId,
      channel,
      buffered.slice(markerIndex + marker.length),
    );
  }

  observeSessionState(
    sessionId: string,
    state: PaneSessionState,
  ): void {
    const channel = this.channels.get(sessionId);
    const pending = channel?.results[0];
    if (!channel || !pending) return;
    if (state === "busy" && pending.submitted) {
      this.clearResultTimers(pending);
      channel.results.shift();
      return;
    }
    if (state === "idle") this.flushResult(sessionId, channel);
  }

  dropSession(sessionId: string): void {
    const channel = this.channels.get(sessionId);
    if (!channel) return;
    for (const pending of channel.results) this.clearResultTimers(pending);
    this.channels.delete(sessionId);
  }

  clear(): void {
    for (const sessionId of [...this.channels.keys()]) {
      this.dropSession(sessionId);
    }
  }

  private collect(
    sessionId: string,
    channel: MissionControlChannel,
    chunk: string,
  ): void {
    const body = (channel.collectingText ?? "") + chunk;
    const extracted = extractJsonObject(body);
    if (extracted) {
      channel.collectingText = null;
      const request = ptyStreamMissionActionSchema.safeParse(extracted.value);
      if (request.success) this.acceptAction(sessionId, channel, request.data);
      this.feed(sessionId, body.slice(extracted.end));
      return;
    }
    if (body.length > MAX_ACTION_BLOCK_CHARS) {
      channel.collectingText = null;
      this.feed(sessionId, body.slice(-MAX_ACTION_BLOCK_CHARS));
      return;
    }
    channel.collectingText = body;
  }

  private acceptAction(
    sessionId: string,
    channel: MissionControlChannel,
    request: PtyStreamMissionAction,
  ): void {
    const signature = JSON.stringify(request);
    const previous = channel.callSignatures.get(request.id);
    if (previous !== undefined) return;
    channel.callSignatures.set(request.id, signature);
    if (channel.callSignatures.size > MAX_TRACKED_CALLS) {
      const oldest = channel.callSignatures.keys().next().value;
      if (oldest) channel.callSignatures.delete(oldest);
    }
    channel.invocationFlight = channel.invocationFlight
      .then(() => this.invokeAction(sessionId, channel, request))
      .catch((error) => {
        console.warn("[pty-control] invocation queue failed:", error);
      });
  }

  private async invokeAction(
    sessionId: string,
    channel: MissionControlChannel,
    request: PtyStreamMissionAction,
  ): Promise<void> {
    if (
      this.channels.get(sessionId) !== channel ||
      !this.ports.isAuthorized(sessionId)
    ) {
      return;
    }
    let outcome: PtyStreamMissionActionOutcome;
    try {
      outcome = await this.ports.invoke(sessionId, request);
    } catch (error) {
      outcome = invalidInvocationOutcome(request, error);
    }
    if (
      this.channels.get(sessionId) !== channel ||
      !this.ports.isAuthorized(sessionId)
    ) {
      return;
    }
    channel.results.push({
      callId: request.id,
      text: formatResult(request.id, outcome),
      pasted: false,
      submitted: false,
      attempts: 0,
    });
    this.flushResult(sessionId, channel);
  }

  private flushResult(
    sessionId: string,
    channel: MissionControlChannel,
  ): void {
    const pending = channel.results[0];
    if (
      !pending ||
      pending.submitted ||
      pending.submitTimer ||
      !this.ports.isAuthorized(sessionId) ||
      !this.ports.isInjectableIdle(sessionId)
    ) {
      return;
    }
    if (!pending.pasted) {
      pending.pasted = this.ports.write(sessionId, pending.text, {
        markInputBusy: false,
      });
      if (!pending.pasted) return;
    }
    this.scheduleResultSubmit(sessionId, channel, pending);
  }

  private scheduleResultSubmit(
    sessionId: string,
    channel: MissionControlChannel,
    pending: PendingResult,
    delayMs = RESULT_SUBMIT_DELAY_MS,
  ): void {
    pending.submitTimer = setTimeout(() => {
      pending.submitTimer = undefined;
      if (
        this.channels.get(sessionId) !== channel ||
        channel.results[0] !== pending ||
        !this.ports.isAuthorized(sessionId) ||
        !this.ports.isInjectableIdle(sessionId)
      ) {
        return;
      }
      const submitted = this.ports.write(sessionId, "\r", {
        markInputBusy: false,
      });
      if (!submitted) return;
      pending.submitted = true;
      pending.attempts += 1;
      this.armResultAcceptance(sessionId, channel, pending);
    }, delayMs);
  }

  private armResultAcceptance(
    sessionId: string,
    channel: MissionControlChannel,
    pending: PendingResult,
  ): void {
    pending.acceptanceTimer = setTimeout(() => {
      pending.acceptanceTimer = undefined;
      pending.submitted = false;
      const current =
        this.channels.get(sessionId) === channel &&
        channel.results[0] === pending;
      if (!current) return;
      if (pending.attempts >= 2) {
        // The tool effect is already complete and must never be re-invoked.
        // Drop only the undeliverable result envelope so later mission
        // actions cannot deadlock behind a TUI that swallowed both Enters.
        channel.results.shift();
        console.warn(
          `[pty-control] result not accepted after two submits ` +
            `(session=${sessionId}, call=${pending.callId})`,
        );
        this.flushResult(sessionId, channel);
        return;
      }
      if (
        this.ports.isAuthorized(sessionId) &&
        this.ports.isInjectableIdle(sessionId)
      ) {
        this.scheduleResultSubmit(
          sessionId,
          channel,
          pending,
          RESULT_RETRY_DELAY_MS,
        );
      }
    }, RESULT_ACCEPTANCE_WINDOW_MS);
  }

  private clearResultTimers(pending: PendingResult): void {
    if (pending.submitTimer) clearTimeout(pending.submitTimer);
    if (pending.acceptanceTimer) clearTimeout(pending.acceptanceTimer);
    pending.submitTimer = undefined;
    pending.acceptanceTimer = undefined;
  }
}

let activePtyStreamMissionControl: PtyStreamMissionControl | null = null;

export function installPtyStreamMissionControl(
  control: PtyStreamMissionControl,
): () => void {
  activePtyStreamMissionControl?.clear();
  activePtyStreamMissionControl = control;
  return () => {
    if (activePtyStreamMissionControl !== control) return;
    control.clear();
    activePtyStreamMissionControl = null;
  };
}

export function getPtyStreamMissionControl(): PtyStreamMissionControl | null {
  return activePtyStreamMissionControl;
}
