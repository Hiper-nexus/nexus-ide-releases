import {
  ipcMain,
  BrowserWindow,
  dialog,
  app,
  type WebContents,
} from "electron";
import { VOICE_CHANNELS } from "../../shared/voice-channels";
import {
  transcribeRequestSchema,
  speakRequestSchema,
  setConfigRequestSchema,
  setVoiceKeyRequestSchema,
  jarvisRequestSchema,
  jarvisLiveInterruptRequestSchema,
  jarvisLiveSayRequestSchema,
  jarvisLiveRescueRequestSchema,
  jarvisLiveAudioPlaybackEventSchema,
  jarvisLiveSmokeTestRequestSchema,
  jarvisLiveStartRequestSchema,
  jarvisLiveStatusPatchSchema,
  jarvisLiveToolResultInputSchema,
  jarvisLiveTranscriptInputSchema,
  voiceLogSchema,
  type VoiceRuntimeInfo,
  type TranscribeResult,
  type SpeakResult,
  type JarvisReply,
} from "../../shared/voice-ipc";
import {
  loadVoiceConfig,
  getVoiceConfig,
  applyConfigPatch,
  buildRuntimeInfo,
  currentProbes,
  setHotkeyMode,
  storeVoiceApiKey,
} from "./voice-config-store";
import { defaultBrainDeps, jarvisThink } from "./jarvis-brain";
import { createScopedJarvisConversation } from "./jarvis-conversation";
import {
  createScopedJarvisMemory,
  type JarvisMemoryAccess,
} from "./jarvis-memory";
import { WakeEngine } from "./wake-engine";
import { getAecRuntimeStatus } from "./aec-runtime";
import { startNativeAecRuntime, type NativeAecRuntime } from "./aec-native-runtime";
import { logVoice } from "./voice-log";
import { spawn } from "node:child_process";
import { transcribe } from "./stt-service";
import { speak, stopSystemSpeech } from "./tts-service";
import { echoSuppressor } from "./echo-suppress";
import { matchWakeWord } from "../../shared/overclock-voice-nlu";
import {
  appBundlePathFromExecPath,
  readBundleId,
  resetMicrophoneTcc,
} from "./mic-tcc";
import { acquireWakeLock, releaseWakeLock, wakeLockHolder } from "./wake-lock";
import { JarvisLiveSession } from "./jarvis-live";
import {
  LiveTransportController,
  type PendingQuestionSource,
} from "./live-transport-controller";
import { getProjectDomainStores } from "../orch/project-domain-store-registry";
import {
  getRendererWorkspaceScope,
  requireRendererWorkspaceScope,
} from "../persistence/renderer-workspace-scope";
import { sameProjectScope } from "../orch/project-scoped-broadcast";
import type { ProjectExecutionScope } from "../../shared/types";
import type { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import { jarvisLatencyTracker } from "../jarvis/realtime/metrics";
import { createScopedTranscriptStore } from "../jarvis/transcript-store";
import {
  registerVoiceHotkey,
  disposeVoiceHotkey,
  isVoiceHotkeyArmed,
} from "./voice-hotkey";
import { initJarvisNarrator, shutdownJarvisNarrator } from "./jarvis-narrator";
import {
  isLiveTransportCredential,
  liveRuntimeFingerprint,
} from "./live-runtime-config";
import { requiresVoiceCommandConfirmation } from "../jarvis/guardrails";
import { ensureAllDefaultWakeModelsInstalled } from "./ensure-wake-models";

/**
 * Wires the voice pipeline into IPC. Every renderer payload is zod-validated
 * before any network/subprocess work. API keys are resolved from process.env
 * inside the STT/TTS services (main only) and never cross to the renderer — the
 * only thing sent back is the secret-free VoiceRuntimeInfo.
 */

/**
 * Send an event to every live window, pruning nothing but skipping any
 * webContents that is destroyed or crashed. Same discipline as the PTY / adapter
 * broadcasts: a late send must never throw "Object has been destroyed".
 */
function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    const wc = win.webContents;
    if (wc.isDestroyed() || wc.isCrashed()) continue;
    wc.send(channel, payload);
  }
}

function broadcastToScope(
  scope: ProjectExecutionScope,
  channel: string,
  payload?: unknown,
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    const wc = win.webContents;
    if (wc.isDestroyed() || wc.isCrashed()) continue;
    const rendererScope = getRendererWorkspaceScope(wc);
    if (rendererScope && sameProjectScope(rendererScope, scope)) {
      wc.send(channel, payload);
    }
  }
}

interface ActiveLiveOwnership {
  readonly owner: WebContents;
  readonly scope: ProjectExecutionScope;
  readonly releaseOnOwnerGone: () => void;
}

interface LiveTransportAffinity {
  readonly owner: WebContents;
  readonly scope: ProjectExecutionScope;
}

let activeLiveOwnership: ActiveLiveOwnership | null = null;
let voiceRuntimeManager: ProjectRuntimeManager | null = null;
let nativeAecRuntime: NativeAecRuntime = { stop() {} };

function requireVoiceRuntimeManager(): ProjectRuntimeManager {
  if (!voiceRuntimeManager) {
    throw new Error("voice transcript runtime manager is not configured");
  }
  return voiceRuntimeManager;
}

function assertRendererStillInScope(
  owner: WebContents,
  expectedScope: ProjectExecutionScope,
): void {
  const currentScope = getRendererWorkspaceScope(owner);
  if (!currentScope || !sameProjectScope(currentScope, expectedScope)) {
    throw new Error("voice request project scope changed");
  }
}

function stageJarvisMemory(memory: JarvisMemoryAccess): {
  readonly access: JarvisMemoryAccess;
  commit(): void;
} {
  const operations: Array<
    | { type: "remember"; key: string; content: string }
    | { type: "forget"; key: string }
  > = [];
  let committed = false;
  return {
    access: Object.freeze({
      remember: (key: string, content: string) => {
        if (committed) throw new Error("JARVIS memory request is already committed");
        operations.push({ type: "remember", key, content });
      },
      forget: (key: string) => {
        if (committed) throw new Error("JARVIS memory request is already committed");
        operations.push({ type: "forget", key });
        return true;
      },
      list: () => memory.list(),
      factsBlock: (maxChars?: number) => memory.factsBlock(maxChars),
    }),
    commit: () => {
      if (committed) throw new Error("JARVIS memory request is already committed");
      committed = true;
      for (const operation of operations) {
        if (operation.type === "remember") {
          memory.remember(operation.key, operation.content);
        } else {
          memory.forget(operation.key);
        }
      }
    },
  };
}

function validLiveOwnership(): ActiveLiveOwnership | null {
  const ownership = activeLiveOwnership;
  if (!ownership) return null;
  if (ownership.owner.isDestroyed() || ownership.owner.isCrashed()) return null;
  const currentScope = getRendererWorkspaceScope(ownership.owner);
  return currentScope && sameProjectScope(currentScope, ownership.scope)
    ? ownership
    : null;
}

/** Live events belong to one renderer session, never to every open window. */
function sendToLiveOwner(channel: string, payload?: unknown): void {
  validLiveOwnership()?.owner.send(channel, payload);
}

/**
 * Resolve a single trustworthy PTT target.
 * Prefer Live owner; otherwise only the focused renderer with a main-side
 * authorized ProjectExecutionScope. Fail closed — never broadcast PTT.
 */
function resolvePttTarget(): WebContents | null {
  const live = validLiveOwnership();
  if (live) return live.owner;

  const focused = BrowserWindow.getFocusedWindow()?.webContents;
  if (!focused || focused.isDestroyed() || focused.isCrashed()) return null;
  const scope = getRendererWorkspaceScope(focused);
  if (!scope) return null;
  return focused;
}

function sendPttAction(channel: string): void {
  const target = resolvePttTarget();
  if (!target) return;
  if (target.isDestroyed() || target.isCrashed()) return;

  const live = validLiveOwnership();
  if (live) {
    if (target !== live.owner) return;
    if (!validLiveOwnership()) return;
    live.owner.send(channel);
    return;
  }

  // Re-read focus + scope immediately before send (fail closed on race).
  const focused = BrowserWindow.getFocusedWindow()?.webContents;
  if (!focused || focused !== target) return;
  if (focused.isDestroyed() || focused.isCrashed()) return;
  const scopeBefore = getRendererWorkspaceScope(focused);
  if (!scopeBefore) return;
  if (focused.isDestroyed() || focused.isCrashed()) return;
  const scopeAfter = getRendererWorkspaceScope(focused);
  if (!scopeAfter || !sameProjectScope(scopeBefore, scopeAfter)) return;
  focused.send(channel);
}

// ── Wake ownership (one renderer + ProjectExecutionScope per generation) ──

interface WakeOwnership {
  readonly owner: WebContents;
  readonly scope: ProjectExecutionScope;
  readonly generation: number;
  readonly releaseOnOwnerGone: () => void;
}

let wakeOwnership: WakeOwnership | null = null;
let wakeGeneration = 0;
// Módulo-level para o closeVoiceIpc() poder liberar as sessões ONNX no quit.
let wakeEngine: WakeEngine | null = null;
let wakeFramesSeen = false;
let wakeLockWarned = false;

function disposeWakeEngineOnly(): void {
  const engine = wakeEngine;
  wakeEngine = null;
  wakeFramesSeen = false;
  if (engine) void engine.dispose();
}

function releaseWakeOwnership(expectedGeneration?: number): void {
  const ownership = wakeOwnership;
  if (!ownership) {
    disposeWakeEngineOnly();
    return;
  }
  if (
    expectedGeneration !== undefined &&
    ownership.generation !== expectedGeneration
  ) {
    return;
  }
  wakeOwnership = null;
  ownership.owner.removeListener("destroyed", ownership.releaseOnOwnerGone);
  ownership.owner.removeListener(
    "render-process-gone",
    ownership.releaseOnOwnerGone,
  );
  disposeWakeEngineOnly();
}

function isTrustedWakeOwner(ownership: WakeOwnership): boolean {
  if (ownership.owner.isDestroyed() || ownership.owner.isCrashed()) return false;
  if (wakeOwnership !== ownership) return false;
  if (ownership.generation !== wakeGeneration) return false;
  const currentScope = getRendererWorkspaceScope(ownership.owner);
  return (
    !!currentScope && sameProjectScope(currentScope, ownership.scope)
  );
}

function sendToWakeOwner(channel: string, payload?: unknown): void {
  const ownership = wakeOwnership;
  if (!ownership || !isTrustedWakeOwner(ownership)) return;
  ownership.owner.send(channel, payload);
}

/**
 * Accept a wake PCM frame only from one trusted owner at a time.
 * Focused window may claim/switch; without focus, preserve existing owner.
 * Returns the ownership to feed, or null when the frame must be dropped.
 */
function acceptWakeFrame(sender: WebContents): WakeOwnership | null {
  if (sender.isDestroyed() || sender.isCrashed()) return null;
  const senderScope = getRendererWorkspaceScope(sender);
  if (!senderScope) return null;

  const focused = BrowserWindow.getFocusedWindow()?.webContents ?? null;
  const focusedAlive =
    focused && !focused.isDestroyed() && !focused.isCrashed() ? focused : null;

  // When a focused window exists, only it may claim or feed wake.
  if (focusedAlive && focusedAlive !== sender) return null;

  const current = wakeOwnership;
  if (current && isTrustedWakeOwner(current)) {
    if (current.owner === sender && sameProjectScope(current.scope, senderScope)) {
      // Existing owner may keep feeding even without focus.
      return current;
    }
    if (current.owner === sender) {
      // Scope drift on the captured owner — invalidate generation + engine.
      releaseWakeOwnership(current.generation);
      // Re-claim only if this owner is currently focused.
      if (!focusedAlive || focusedAlive !== sender) return null;
    } else if (!focusedAlive) {
      // No focus: another renderer must never steal the captured owner.
      return null;
    } else {
      // Intentional switch: focused sender takes over.
      releaseWakeOwnership(current.generation);
    }
  } else if (current) {
    // Stale / unauthorized owner — free it so a valid claim can proceed.
    releaseWakeOwnership(current.generation);
  }

  // A single authorized renderer must be able to claim wake at cold start even
  // while another application has OS focus. Requiring Nexus focus here made
  // every startup deaf until the user clicked the window. When a Nexus window
  // is focused it still has exclusive priority; without one, the first
  // project-bound renderer becomes the captured owner and subsequent senders
  // cannot steal it through the guards above.
  if (focusedAlive && focusedAlive !== sender) return null;

  const generation = ++wakeGeneration;
  const releaseOnOwnerGone = () => {
    if (wakeOwnership?.generation === generation) {
      releaseWakeOwnership(generation);
    }
  };
  const ownership: WakeOwnership = Object.freeze({
    owner: sender,
    scope: Object.freeze({ ...senderScope }),
    generation,
    releaseOnOwnerGone,
  });
  wakeOwnership = ownership;
  sender.once("destroyed", releaseOnOwnerGone);
  sender.once("render-process-gone", releaseOnOwnerGone);
  return ownership;
}

function emitWakeDetected(generation: number, owner: WebContents, scope: ProjectExecutionScope): void {
  const ownership = wakeOwnership;
  if (!ownership) return;
  if (ownership.generation !== generation) return;
  if (ownership.owner !== owner) return;
  if (!isTrustedWakeOwner(ownership)) return;
  if (!sameProjectScope(ownership.scope, scope)) return;
  ownership.owner.send(VOICE_CHANNELS.wakeDetected);
}

const liveSession = new JarvisLiveSession(
  sendToLiveOwner,
  Date.now,
  (sessionId, line) => {
    const ownership = validLiveOwnership();
    if (!ownership) {
      throw new Error("voice transcript has no valid project owner");
    }
    if (liveSession.getState().sessionId !== sessionId) {
      throw new Error("voice transcript session authority changed");
    }
    jarvisLatencyTracker.markTranscript(sessionId, line.final, line.turnId);
    const record = createScopedTranscriptStore(
      requireVoiceRuntimeManager(),
      ownership.scope,
    ).append(
      sessionId,
      {
        role: line.role,
        text: line.text,
        final: line.final,
        audio_url: null,
      },
    );
    if (!record) return;
    sendToLiveOwner(VOICE_CHANNELS.jarvisTranscriptAppend, record);
  },
);
// C-085 r3 (upstream QUESTION_POLL): um handoff `blocked` = uma pane delegada
// travada precisando do usuário — i.e. uma pergunta narrada pendente. O poll do
// controller registra cada uma para que a PRÓXIMA fala final do usuário seja
// roteada de volta à pane (send_to_pane, modelo bypassado), sem re-wake.
const pendingQuestionSource: PendingQuestionSource = {
  poll: () => {
    const ownership = validLiveOwnership();
    return (
      ownership
        ? getProjectDomainStores(ownership.scope).handoffs.list({
            includeDelivered: false,
          })
        : []
    )
      .filter((handoff) => handoff.status === "blocked")
      .map((handoff) => ({
        paneId: handoff.sessionId ?? handoff.id,
        questionHash: handoff.summary,
      }));
  },
};
function createLiveTransport(
  scope?: ProjectExecutionScope,
): LiveTransportController {
  return new LiveTransportController(
    sendToLiveOwner,
    liveSession,
    Date.now,
    pendingQuestionSource,
    scope
      ? createScopedJarvisMemory(requireVoiceRuntimeManager(), scope)
      : undefined,
    nativeAecRuntime.processor,
  );
}

let liveTransport = createLiveTransport();
let liveTransportAffinity: LiveTransportAffinity | null = null;

function bindLiveTransport(
  owner: WebContents,
  scope: ProjectExecutionScope,
): void {
  if (
    liveTransportAffinity?.owner === owner &&
    sameProjectScope(liveTransportAffinity.scope, scope)
  ) {
    return;
  }
  liveTransport.hardStop();
  liveTransport = createLiveTransport(scope);
  liveTransportAffinity = Object.freeze({
    owner,
    scope: Object.freeze({ ...scope }),
  });
}

function releaseLiveOwnership(expectedOwner?: WebContents): void {
  const ownership = activeLiveOwnership;
  if (!ownership || (expectedOwner && ownership.owner !== expectedOwner))
    return;
  activeLiveOwnership = null;
  ownership.owner.removeListener("destroyed", ownership.releaseOnOwnerGone);
  ownership.owner.removeListener(
    "render-process-gone",
    ownership.releaseOnOwnerGone,
  );
}

function stopLiveAndRelease(
  owner: WebContents,
  hard: boolean,
): ReturnType<JarvisLiveSession["getState"]> {
  let stopped = liveSession.getState();
  try {
    try {
      if (hard) liveTransport.hardStop();
      else liveTransport.onStop();
    } finally {
      stopped = liveSession.stop();
    }
    return stopped;
  } finally {
    if (hard) liveTransportAffinity = null;
    releaseLiveOwnership(owner);
  }
}

function releaseUnavailableLiveOwner(owner: WebContents): void {
  if (activeLiveOwnership?.owner !== owner) return;
  try {
    stopLiveAndRelease(owner, true);
  } catch (err) {
    logVoice(
      "warn",
      "live.ownerGoneTeardownFail",
      "falha ao liberar sessão órfã",
      {
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
}

function claimLiveOwnership(
  owner: WebContents,
  scope: ProjectExecutionScope,
): boolean {
  let current = activeLiveOwnership;
  if (current && !validLiveOwnership()) {
    releaseUnavailableLiveOwner(current.owner);
    current = activeLiveOwnership;
  }
  if (current) {
    if (current.owner !== owner) {
      if (!current.owner.isDestroyed() && !current.owner.isCrashed()) {
        throw new Error("voice live session is owned by another window");
      }
      releaseUnavailableLiveOwner(current.owner);
    } else if (sameProjectScope(current.scope, scope)) {
      return false;
    } else {
      releaseUnavailableLiveOwner(owner);
    }
  }

  bindLiveTransport(owner, scope);
  const releaseOnOwnerGone = () => releaseUnavailableLiveOwner(owner);
  activeLiveOwnership = Object.freeze({
    owner,
    scope: Object.freeze({ ...scope }),
    releaseOnOwnerGone,
  });
  owner.once("destroyed", releaseOnOwnerGone);
  owner.once("render-process-gone", releaseOnOwnerGone);
  return true;
}

function requireLiveOwnership(owner: WebContents): ActiveLiveOwnership {
  const ownership = activeLiveOwnership;
  if (!ownership) throw new Error("voice live session has no owner");
  if (ownership.owner !== owner) {
    throw new Error("voice live session is owned by another window");
  }
  const currentScope = getRendererWorkspaceScope(owner);
  if (!currentScope || !sameProjectScope(currentScope, ownership.scope)) {
    releaseUnavailableLiveOwner(owner);
    throw new Error("voice live session project scope changed");
  }
  return ownership;
}

function acceptLiveEvent(owner: WebContents): boolean {
  try {
    requireLiveOwnership(owner);
    return true;
  } catch {
    return false;
  }
}

function wireHotkey(): void {
  const config = getVoiceConfig();
  const mainKeyCode = config.input.pushToTalkKey?.code ?? "Space";
  const mode = registerVoiceHotkey(config.input.shortcut, mainKeyCode, {
    onStart: () => sendPttAction(VOICE_CHANNELS.pttStart),
    onStop: () => sendPttAction(VOICE_CHANNELS.pttStop),
    onToggle: () => sendPttAction(VOICE_CHANNELS.pttToggle),
  });
  setHotkeyMode(mode);
}

/** Runtime snapshot + whether the OS actually accepted the accelerator. */
function fullInfo(): VoiceRuntimeInfo {
  const aec = getAecRuntimeStatus(app.isPackaged ? process.resourcesPath : undefined);
  return {
    ...buildRuntimeInfo(),
    hotkeyArmed: isVoiceHotkeyArmed(),
    wakeLockHolderPid: wakeLockHolder(),
    aec: {
      backend: aec.backend,
      native: aec.native,
      degraded: aec.degraded,
      reason: aec.reason,
    },
  };
}

export function registerVoiceIpc(runtimeManager: ProjectRuntimeManager): void {
  voiceRuntimeManager = runtimeManager;
  // Atribuição de "duas vozes": identifica ESTA instância no voice.log para
  // distinguir colisão interna de colisão cross-app (sidecar do Overclock).
  logVoice("info", "voice.instanceBoot", "instância de voz iniciada", {
    pid: process.pid,
    execPath: process.execPath,
    version: app.getVersion(),
  });
  const aec = getAecRuntimeStatus(app.isPackaged ? process.resourcesPath : undefined);
  logVoice(aec.degraded ? "warn" : "info", "voice.aecRuntime", aec.reason, {
    backend: aec.backend,
    native: aec.native,
    degraded: aec.degraded,
    platform: process.platform,
    arch: process.arch,
  });
  nativeAecRuntime.stop();
  nativeAecRuntime = startNativeAecRuntime(aec);
  // The module-level controller is created before app registration. Rebuild it
  // once so packaged native AEC is actually wired into the live audio path.
  liveTransport.hardStop();
  liveTransport = createLiveTransport();
  loadVoiceConfig();
  wireHotkey();
  const restartMarker =
    process.env.NEXUS_VOICE_RESTART_MARKER?.trim() || "APP_RESTART";
  logVoice(
    "info",
    "voice.restart",
    `=== ${restartMarker} ${new Date().toISOString()} ===`,
  );
  const wakeModels = ensureAllDefaultWakeModelsInstalled();
  logVoice("info", "wake.defaultModels", "modelos wake padrão verificados", {
    en: Boolean(wakeModels.en),
    ptbr: Boolean(wakeModels.ptbr),
  });
  // Narração proativa: handoff novo (entrega/travamento/falha) vira aviso de
  // voz — o renderer fala quando não houver turno ativo.
  initJarvisNarrator(broadcastToScope);
  liveSession.setEnabled(getVoiceConfig().jarvisLive.enabled);

  ipcMain.handle(VOICE_CHANNELS.getInfo, (): VoiceRuntimeInfo => fullInfo());

  ipcMain.handle(VOICE_CHANNELS.setConfig, (_event, raw): VoiceRuntimeInfo => {
    const parsed = setConfigRequestSchema.safeParse(raw);
    if (!parsed.success) return fullInfo();
    const previousConfig = getVoiceConfig();
    const before = previousConfig.input.shortcut;
    const beforeKey = previousConfig.input.pushToTalkKey?.code;
    const previousLiveFingerprint = liveRuntimeFingerprint(previousConfig);
    applyConfigPatch(parsed.data);
    const nextConfig = getVoiceConfig();
    if (liveRuntimeFingerprint(nextConfig) !== previousLiveFingerprint) {
      logVoice(
        "info",
        "live.configChanged",
        "recriando provider após mudança de configuração",
      );
      liveTransport.hardStop();
    }
    liveSession.setEnabled(nextConfig.jarvisLive.enabled);
    // Re-register the accelerator only if it actually changed.
    const nextInput = getVoiceConfig().input;
    if (
      nextInput.shortcut !== before ||
      nextInput.pushToTalkKey?.code !== beforeKey
    ) {
      wireHotkey();
    }
    const info = fullInfo();
    broadcast(VOICE_CHANNELS.infoChanged, info);
    return info;
  });

  ipcMain.handle(
    VOICE_CHANNELS.setKey,
    (_event, raw): { ok: boolean; error?: string } => {
      const parsed = setVoiceKeyRequestSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: "invalid key request" };
      const result = storeVoiceApiKey(parsed.data.envVar, parsed.data.key);
      if (isLiveTransportCredential(parsed.data.envVar)) {
        logVoice(
          "info",
          "live.credentialChanged",
          "recriando provider após mudança de credencial",
          {
            envVar: parsed.data.envVar,
          },
        );
        liveTransport.hardStop();
      }
      const info = fullInfo();
      broadcast(VOICE_CHANNELS.infoChanged, info);
      return result;
    },
  );

  ipcMain.handle(
    VOICE_CHANNELS.transcribe,
    async (_event, raw): Promise<TranscribeResult> => {
      const parsed = transcribeRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          needsKey: false,
          error: "invalid transcribe request",
          attempts: [],
        };
      }
      try {
        const res = await transcribe(
          parsed.data,
          getVoiceConfig(),
          currentProbes(),
        );
        // ITEM 7: a wake-path STT stall (cloud skipped to local por orçamento)
        // nunca é silenciosa — o motivo/attempts entram no voice.log.
        if (res.stalled) {
          logVoice(
            "warn",
            "stt.stall",
            "wake STT estourou o orçamento; pulou p/ local",
            {
              budgetMs: parsed.data.budgetMs,
              ok: res.ok,
              provider: res.ok ? res.provider : null,
              attempts: res.attempts.map((a) => `${a.provider}: ${a.reason}`),
            },
          );
        }
        // Terceira camada anti-eco (após o AEC do mic e antes do filtro de
        // fantasmas do renderer): transcrição que é o próprio TTS recente
        // vazando do alto-falante volta marcada para descarte silencioso.
        const containsRequestedWake =
          res.ok &&
          parsed.data.purpose === "passive-wake" &&
          Boolean(matchWakeWord(res.text, parsed.data.passiveWakeWord || "Jarvis"));
        if (res.ok && !containsRequestedWake && echoSuppressor.isEcho(res.text)) {
          logVoice("info", "stt.echoDiscarded", "eco do TTS descartado", {
            text: res.text.slice(0, 120),
          });
          return { ...res, discarded: "echo" };
        }
        return res;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, needsKey: false, error: message, attempts: [] };
      }
    },
  );

  // Wake word "Hey Jarvis" (openWakeWord/onnx, sem conta): o renderer faz
  // stream dos frames PCM; a detecção volta somente ao owner capturado.
  ipcMain.on(VOICE_CHANNELS.wakeAudio, (event, raw: unknown) => {
    if (!getVoiceConfig().wakeWord.enabled) return;
    const ownership = acceptWakeFrame(event.sender);
    if (!ownership) return;

    // Mutex entre instâncias (dev + empacotado abertos juntos): só a dona do
    // lock processa wake — senão as DUAS respondem ao mesmo "Hey Jarvis".
    if (!acquireWakeLock()) {
      if (!wakeLockWarned) {
        wakeLockWarned = true;
        logVoice(
          "warn",
          "wake.lockContention",
          "outra instância do NexusIDE detém o wake — frames ignorados aqui",
          { holderPid: wakeLockHolder() },
        );
        // Contention is process-local; notify only the wake owner, not every project.
        sendToWakeOwner(VOICE_CHANNELS.infoChanged, fullInfo());
      }
      return;
    }
    if (wakeLockWarned) {
      wakeLockWarned = false;
      sendToWakeOwner(VOICE_CHANNELS.infoChanged, fullInfo());
    }
    // Electron entrega o ArrayBuffer do renderer como Buffer/TypedArray —
    // normalize os três formatos (respeitando byteOffset/length!).
    let frame: Float32Array | null = null;
    if (raw instanceof ArrayBuffer) {
      frame = new Float32Array(raw);
    } else if (ArrayBuffer.isView(raw)) {
      const v = raw as ArrayBufferView;
      frame = new Float32Array(
        v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength),
      );
    }
    if (!frame || frame.length === 0 || frame.length > 16_384) return;

    // Re-validate before mutating engine state (scope/owner may have raced).
    if (!isTrustedWakeOwner(ownership)) {
      releaseWakeOwnership(ownership.generation);
      return;
    }

    if (!wakeFramesSeen) {
      wakeFramesSeen = true;
      logVoice("info", "wake.framesStart", "recebendo áudio do renderer", {
        frameSamples: frame.length,
        generation: ownership.generation,
      });
    }
    if (!wakeEngine) {
      const claimedGeneration = ownership.generation;
      const claimedOwner = ownership.owner;
      const claimedScope = ownership.scope;
      const engine = new WakeEngine(
        () => {
          logVoice("info", "wake.detected", '"Hey Jarvis"', {
            generation: claimedGeneration,
          });
          emitWakeDetected(claimedGeneration, claimedOwner, claimedScope);
        },
        (telemetry) => {
          logVoice("info", "wake.score", "janela de score do detector", {
            ...telemetry,
            generation: claimedGeneration,
          });
        },
      );
      wakeEngine = engine;
      void engine
        .init()
        .then(() => {
          if (
            wakeOwnership?.generation !== claimedGeneration ||
            wakeEngine !== engine
          ) {
            return;
          }
          logVoice("info", "wake.engineReady", "openWakeWord pronto", {
            generation: claimedGeneration,
          });
        })
        .catch((err) => {
          const m = err instanceof Error ? err.message : String(err);
          logVoice("error", "wake.engineInitFail", m, {
            generation: claimedGeneration,
          });
          if (
            wakeOwnership?.generation === claimedGeneration &&
            wakeEngine === engine
          ) {
            releaseWakeOwnership(claimedGeneration);
          }
        });
      // Sem return: o primeiro lote também alimenta — o engine enfileira os
      // frames recebidos durante a init e processa quando ela completar.
    }
    wakeEngine.feed(frame);
  });

  // Eventos do pipeline vindos do renderer (mic do wake morreu/reconstruiu,
  // etc.) → log persistente. Observabilidade da morte silenciosa do mic.
  ipcMain.on(VOICE_CHANNELS.logEvent, (_event, raw: unknown) => {
    const parsed = voiceLogSchema.safeParse(raw);
    if (parsed.success) {
      logVoice(
        parsed.data.level,
        parsed.data.event,
        parsed.data.msg,
        parsed.data.data,
      );
    }
  });

  // Deep-links pra Ajustes do macOS: o renderer pede quando a JARVIS detecta
  // que tá sem permissão de mic (Privacy → Microfone) ou com input mudo (Som).
  ipcMain.on(VOICE_CHANNELS.openMicSettings, () => {
    spawn("open", [
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    ]);
    logVoice("info", "mic.openMicSettings", "abriu Ajustes → Microfone");
  });
  ipcMain.on(VOICE_CHANNELS.openSoundSettings, () => {
    spawn("open", ["x-apple.systempreferences:com.apple.preference.sound"]);
    logVoice("info", "mic.openSoundSettings", "abriu Ajustes → Som");
  });

  // Grant TCC fantasma (WAKE-BROKEN-001 Rank 1): macOS diz 'granted' mas
  // entrega PCM zerado. Reset guiado com confirmação nativa + relaunch.
  ipcMain.handle(
    VOICE_CHANNELS.micResetTcc,
    async (): Promise<{ ok: boolean; error?: string }> => {
      if (process.platform !== "darwin")
        return { ok: false, error: "só macOS" };
      const appPath = appBundlePathFromExecPath(process.execPath);
      const bundleId = appPath ? await readBundleId(appPath) : null;
      if (!bundleId) {
        return {
          ok: false,
          error:
            "bundle id não resolvido — rode: tccutil reset Microphone <seu-bundle-id>",
        };
      }
      const { response } = await dialog.showMessageBox({
        type: "warning",
        buttons: ["Resetar e reiniciar", "Cancelar"],
        defaultId: 0,
        cancelId: 1,
        message: "Resetar a permissão de microfone?",
        detail: `Vou rodar "tccutil reset Microphone ${bundleId}" e reiniciar o app. Na volta, clique Permitir quando o macOS pedir o microfone.`,
      });
      if (response !== 0) return { ok: false, error: "cancelado" };
      try {
        await resetMicrophoneTcc(bundleId);
      } catch (err) {
        logVoice("warn", "mic.tccResetFailed", "tccutil falhou", {
          error: String(err),
        });
        return { ok: false, error: `tccutil falhou: ${String(err)}` };
      }
      logVoice("warn", "mic.tccReset", "TCC Microphone resetado — relançando", {
        bundleId,
      });
      app.relaunch();
      app.exit(0);
      return { ok: true };
    },
  );

  ipcMain.handle(
    VOICE_CHANNELS.jarvis,
    async (event, raw): Promise<JarvisReply> => {
      // Classic replies are mirrored into an active Live session. Once Live
      // has an owner, another window must not inject transcript/tool events.
      const scope = activeLiveOwnership
        ? requireLiveOwnership(event.sender).scope
        : requireRendererWorkspaceScope(event.sender);
      const parsed = jarvisRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return { say: "Não entendi o pedido.", action: { type: "none" } };
      }
      try {
        // Gap 9: se o renderer perdeu o histórico (morte/reinício da sessão),
        // reinjeta a conversa persistida em disco dentro da janela de resume, para
        // a JARVIS retomar o fio em vez de recomeçar e re-perguntar o que já sabia.
        const conversation = createScopedJarvisConversation(
          requireVoiceRuntimeManager(),
          scope,
        );
        const memory = createScopedJarvisMemory(
          requireVoiceRuntimeManager(),
          scope,
        );
        const stagedMemory = stageJarvisMemory(memory);
        const history =
          parsed.data.history.length > 0
            ? parsed.data.history
            : conversation.resume();
        const reply = await jarvisThink(
          parsed.data.transcript,
          parsed.data.context,
          history,
          { ...defaultBrainDeps, memory: stagedMemory.access },
        );
        assertRendererStillInScope(event.sender, scope);
        stagedMemory.commit();
        conversation.record(parsed.data.transcript, reply.say);
        liveSession.onJarvisReply(parsed.data.transcript, reply);
        console.log(
          `[voice] jarvis: "${parsed.data.transcript}" → ${reply.action.type}` +
            ` | say="${reply.say.slice(0, 80)}"`,
        );
        return reply;
      } catch (err) {
        assertRendererStillInScope(event.sender, scope);
        const message = err instanceof Error ? err.message : String(err);
        return {
          say: `Deu erro ao pensar: ${message}`,
          action: { type: "none" },
        };
      }
    },
  );

  ipcMain.handle(
    VOICE_CHANNELS.speak,
    async (_event, raw): Promise<SpeakResult> => {
      const parsed = speakRequestSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: "invalid speak request" };
      try {
        return await speak(parsed.data, getVoiceConfig(), currentProbes());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },
  );

  ipcMain.handle(VOICE_CHANNELS.recordEcho, (_event, raw: unknown) => {
    const text =
      typeof (raw as { text?: unknown })?.text === "string"
        ? (raw as { text: string }).text
        : "";
    if (text.trim()) echoSuppressor.record(text);
    return { ok: true as const };
  });

  // Barge-in do fallback `say` (mode 'played' toca no main — o renderer não
  // tem como calar sem isto).
  ipcMain.handle(VOICE_CHANNELS.speakStop, () => {
    stopSystemSpeech();
  });

  // Routine local development commands stay hands-free. Destructive or remote
  // publication/deployment commands retain an un-spoofable main-owned prompt.
  ipcMain.handle(
    VOICE_CHANNELS.confirmCommand,
    async (_event, raw): Promise<boolean> => {
      if (typeof raw !== "string" || raw.trim() === "" || raw.length > 4096) {
        return false;
      }
      if (!requiresVoiceCommandConfirmation(raw)) {
        logVoice("info", "jarvis.commandAutoApproved", "comando local de baixo risco", {
          chars: raw.length,
        });
        return true;
      }
      const opts = {
        type: "warning" as const,
        buttons: ["Cancelar", "Executar"],
        defaultId: 0,
        cancelId: 0,
        title: "Confirmar ação de alto impacto?",
        message: "A JARVIS detectou um comando destrutivo ou de publicação:",
        detail: `${raw}\n\nConfirme apenas se deseja esse efeito externo ou irreversível.`,
        noLink: true,
      };
      const win = BrowserWindow.getFocusedWindow();
      const result = win
        ? await dialog.showMessageBox(win, opts)
        : await dialog.showMessageBox(opts);
      return result.response === 1;
    },
  );

  ipcMain.handle(VOICE_CHANNELS.liveStart, async (event, raw) => {
    const scope = getRendererWorkspaceScope(event.sender);
    if (!scope)
      throw new Error("voice session requires an authorized project scope");
    const claimed = claimLiveOwnership(event.sender, scope);
    const parsed = jarvisLiveStartRequestSchema.safeParse(raw ?? {});
    const req = parsed.success ? parsed.data : {};
    try {
      let state = liveSession.start(req);
      // Se a config pede transporte realtime, conecta o socket antes do mic;
      // senão isto é no-op e o Classic segue (fallback keyless).
      if (liveSession.getState().sessionId) {
        await liveTransport.onStart({ greeting: req.greeting, freshTurn: true });
        requireLiveOwnership(event.sender);
        state = liveSession.getState();
      } else {
        releaseLiveOwnership(event.sender);
      }
      return state;
    } catch (err) {
      if (claimed) releaseUnavailableLiveOwner(event.sender);
      throw err;
    }
  });

  ipcMain.handle(VOICE_CHANNELS.livePrewarm, async (event, raw) => {
    const enabled = raw?.enabled === true;
    if (!enabled) {
      if (activeLiveOwnership?.owner === event.sender) {
        return stopLiveAndRelease(event.sender, true);
      }
      return liveSession.getState();
    }
    const scope = getRendererWorkspaceScope(event.sender);
    if (!scope)
      throw new Error("voice prewarm requires an authorized project scope");
    const claimed = claimLiveOwnership(event.sender, scope);
    try {
      liveSession.start({ reason: "wake" });
      await liveTransport.onStart({ prewarm: true });
      requireLiveOwnership(event.sender);
      return liveSession.getState();
    } catch (err) {
      if (claimed) releaseUnavailableLiveOwner(event.sender);
      throw err;
    }
  });

  ipcMain.handle(VOICE_CHANNELS.liveStop, (event) => {
    requireLiveOwnership(event.sender);
    return stopLiveAndRelease(event.sender, false);
  });
  ipcMain.handle(VOICE_CHANNELS.liveHardRebuild, async (event) => {
    requireLiveOwnership(event.sender);
    logVoice(
      "warn",
      "live.hardRebuild",
      "destruindo socket zumbi + nova conexão",
    );
    liveTransport.hardStop();
    liveSession.start({ reason: "manual" });
    await liveTransport.onStart();
    requireLiveOwnership(event.sender);
    return liveSession.getState();
  });
  ipcMain.handle(VOICE_CHANNELS.liveHardTeardown, (event) => {
    requireLiveOwnership(event.sender);
    logVoice("warn", "live.hardTeardown", "destruindo socket — sem reconexão");
    return stopLiveAndRelease(event.sender, true);
  });
  ipcMain.handle(VOICE_CHANNELS.liveQuiesce, (event, raw) => {
    // Classic has two independent ownership boundaries (action bridge and
    // output/TTS). The first one may already have quiesced and released Live;
    // the second call is therefore an idempotent success, not an operational
    // error. Still fail closed when another renderer owns the session.
    if (!activeLiveOwnership) {
      liveTransport.hardStop();
      return liveSession.getState();
    }
    requireLiveOwnership(event.sender);
    const parsed = jarvisLiveInterruptRequestSchema.safeParse(raw ?? {});
    try {
      return liveTransport.quiesce(
        parsed.success ? parsed.data.reason : "classic-fallback",
      );
    } finally {
      liveTransportAffinity = null;
      releaseLiveOwnership(event.sender);
    }
  });
  ipcMain.handle(VOICE_CHANNELS.liveEndTurn, (event) => {
    if (!activeLiveOwnership) return liveSession.getState();
    requireLiveOwnership(event.sender);
    liveTransport.endTurn();
    return liveSession.endTurn();
  });
  ipcMain.handle(VOICE_CHANNELS.liveEndUserAudio, (event) => {
    if (!activeLiveOwnership) return liveSession.getState();
    requireLiveOwnership(event.sender);
    liveTransport.endTurn();
    return liveSession.getState();
  });
  ipcMain.on(VOICE_CHANNELS.liveTurnBegin, (event, raw: unknown) => {
    if (!acceptLiveEvent(event.sender)) return;
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 128) return;
    liveTransport.beginTurn(raw);
  });
  ipcMain.handle(VOICE_CHANNELS.liveSmokeTest, async (event, raw) => {
    // Diagnostic from Settings must work without a prior liveStart. Claim
    // ownership here (same window/scope rules as liveStart); still refuse
    // when another live window already owns the session.
    const parsed = jarvisLiveSmokeTestRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        evidence: "none",
        latencyMs: null,
        reason: "invalid_request",
        state: liveSession.getState(),
      } as const;
    }
    const scope = getRendererWorkspaceScope(event.sender);
    if (!scope) {
      throw new Error("voice session requires an authorized project scope");
    }
    let claimed = false;
    try {
      claimed = claimLiveOwnership(event.sender, scope);
      return await liveTransport.smokeTest(parsed.data.text, event.sender.id);
    } catch (err) {
      if (claimed) releaseUnavailableLiveOwner(event.sender);
      throw err;
    }
  });
  ipcMain.handle(VOICE_CHANNELS.liveSay, async (event, raw) => {
    requireLiveOwnership(event.sender);
    const parsed = jarvisLiveSayRequestSchema.safeParse(raw);
    if (!parsed.success) return liveSession.getState();
    return liveTransport.say(parsed.data.text);
  });

  // Mic PCM 16 kHz base64 do renderer → transporte realtime (no-op no Classic).
  ipcMain.on(VOICE_CHANNELS.liveMicIn, (event, raw: unknown) => {
    if (!acceptLiveEvent(event.sender)) return;
    if (typeof raw === "string" && raw.length > 0 && raw.length <= 256 * 1024) {
      liveTransport.micIn(raw);
    }
  });
  ipcMain.handle(VOICE_CHANNELS.liveRescueIn, (event, raw: unknown) => {
    requireLiveOwnership(event.sender);
    const parsed = jarvisLiveRescueRequestSchema.safeParse(raw);
    if (!parsed.success) return { accepted: false, turnId: "" };
    return {
      accepted: liveTransport.rescueText(parsed.data.turnId, parsed.data.text),
      turnId: parsed.data.turnId,
    };
  });
  ipcMain.on(VOICE_CHANNELS.liveContextIn, (event, raw: unknown) => {
    if (!acceptLiveEvent(event.sender)) return;
    if (typeof raw === "string" && raw.trim()) liveTransport.contextIn(raw);
  });
  ipcMain.on(VOICE_CHANNELS.liveAudioPlayback, (event, raw: unknown) => {
    if (!acceptLiveEvent(event.sender)) return;
    const parsed = jarvisLiveAudioPlaybackEventSchema.safeParse(raw);
    if (!parsed.success) return;
    liveTransport.reportAudioPlayback(parsed.data, event.sender.id);
  });

  ipcMain.handle(VOICE_CHANNELS.liveStatus, (event, raw) => {
    requireLiveOwnership(event.sender);
    const parsed = jarvisLiveStatusPatchSchema.safeParse(raw);
    if (!parsed.success) return liveSession.getState();
    return liveSession.patchStatus(parsed.data);
  });

  ipcMain.on(VOICE_CHANNELS.liveTranscriptIn, (event, raw) => {
    if (!acceptLiveEvent(event.sender)) return;
    const parsed = jarvisLiveTranscriptInputSchema.safeParse(raw);
    if (!parsed.success) return;
    liveSession.transcript(parsed.data);
  });

  ipcMain.on(VOICE_CHANNELS.liveToolResultIn, (event, raw) => {
    if (!acceptLiveEvent(event.sender)) return;
    const parsed = jarvisLiveToolResultInputSchema.safeParse(raw);
    if (!parsed.success) return;
    const resultEvent = liveSession.toolResult(parsed.data);
    if (resultEvent) {
      liveTransport.toolResult(resultEvent);
    }
  });

  ipcMain.handle(VOICE_CHANNELS.liveInterrupt, (event, raw) => {
    // Soft no-op before Live owns the session (wake race logs: "no owner").
    try {
      requireLiveOwnership(event.sender);
    } catch {
      return { ok: false, reason: "no-owner" as const };
    }
    const parsed = jarvisLiveInterruptRequestSchema.safeParse(raw ?? {});
    return liveTransport.interrupt(
      parsed.success ? parsed.data.reason : "interrupted",
    );
  });
}

export function closeVoiceIpc(): void {
  disposeVoiceHotkey();
  shutdownJarvisNarrator();
  stopSystemSpeech();
  // P4: hard teardown on quit — never leave a grace socket dangling.
  const owner = activeLiveOwnership?.owner;
  try {
    if (owner) stopLiveAndRelease(owner, true);
    else {
      try {
        liveTransport.hardStop();
      } finally {
        liveTransportAffinity = null;
        liveSession.stop();
      }
    }
  } finally {
    nativeAecRuntime.stop();
    nativeAecRuntime = { stop() {} };
    // Wake ownership + ONNX engine: release listeners once, dispose once.
    releaseWakeOwnership();
    wakeLockWarned = false;
    releaseWakeLock();
    voiceRuntimeManager = null;
  }
}
