import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VOICE_CHANNELS } from "../../shared/voice-channels";
import type { ProjectExecutionScope } from "../../shared/types";

type IpcHandler = (event: { sender: TestRenderer }, raw?: unknown) => unknown;

const electronDeps = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  const listeners = new Map<string, IpcHandler>();
  return {
    handlers,
    listeners,
    windows: [] as Array<{ webContents: unknown }>,
    focusedWindow: null as null | { webContents: unknown },
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, listener: IpcHandler) => {
      listeners.set(channel, listener);
    }),
  };
});

const scopeDeps = vi.hoisted(() => ({
  scopes: new Map<number, ProjectExecutionScope>(),
  getRendererWorkspaceScope: vi.fn(
    (owner: { id: number }) => scopeDeps.scopes.get(owner.id) ?? null,
  ),
  requireRendererWorkspaceScope: vi.fn((owner: { id: number }) => {
    const scope = scopeDeps.scopes.get(owner.id);
    if (!scope) throw new Error("renderer has no authorized workspace scope");
    return scope;
  }),
}));

const brainDeps = vi.hoisted(() => ({
  jarvisThink: vi.fn(),
}));

const domainDeps = vi.hoisted(() => {
  const missionList = vi.fn(() => [] as {
    id: string;
    status: string;
    updatedAt: number;
    title: string;
  }[]);
  const missionCreate = vi.fn((input: { title: string }) => ({
    id: "mission-voice-new",
    title: input.title,
    status: "pending" as const,
    updatedAt: Date.now(),
  }));
  const missionSetStatus = vi.fn((id: string, status: string) => ({
    id,
    status,
  }));
  return {
    missionList,
    missionCreate,
    missionSetStatus,
    getProjectDomainStores: vi.fn((scope: ProjectExecutionScope) => ({
      handoffs: {
        list: vi.fn(() =>
          scope.projectId === "project-a"
            ? [
                {
                  id: "handoff-a",
                  sessionId: "pane-a",
                  status: "blocked",
                  summary: "Pergunta A",
                },
              ]
            : [],
        ),
      },
      missions: {
        list: missionList,
        create: missionCreate,
        setStatus: missionSetStatus,
      },
    })),
  };
});

const liveTransportDeps = vi.hoisted(() => ({
  constructed: 0,
  emit: null as null | ((channel: string, payload?: unknown) => void),
  pendingQuestionSource: null as null | { poll: () => unknown[] },
  onStart: vi.fn(async () => undefined),
  onStop: vi.fn(),
  hardStop: vi.fn(),
  quiesce: vi.fn(() => ({ ok: true })),
  endTurn: vi.fn(),
  beginTurn: vi.fn(),
  smokeTest: vi.fn(async () => ({ ok: true })),
  say: vi.fn(async () => ({ ok: true })),
  micIn: vi.fn(),
  rescueText: vi.fn(() => true),
  contextIn: vi.fn(),
  reportAudioPlayback: vi.fn(),
  toolResult: vi.fn(),
  interrupt: vi.fn(() => ({ ok: true })),
}));

const narratorDeps = vi.hoisted(() => ({
  emit: null as
    | null
    | ((
        scope: ProjectExecutionScope,
        channel: string,
        payload?: unknown,
      ) => void),
}));

const transcriptDeps = vi.hoisted(() => ({
  append: vi.fn(
    (
      _sessionId: string,
      _line: { role: string; text: string; final: boolean },
    ) => null as unknown,
  ),
  createScopedTranscriptStore: vi.fn(
    (_runtimeManager: unknown, _scope: ProjectExecutionScope) => ({
      append: transcriptDeps.append,
    }),
  ),
}));
const projectMemoryDeps = vi.hoisted(() => ({
  factsBlock: vi.fn(() => ''),
  remember: vi.fn(),
  forget: vi.fn(() => false),
  list: vi.fn(() => []),
  createMemory: vi.fn(() => ({
    factsBlock: projectMemoryDeps.factsBlock,
    remember: projectMemoryDeps.remember,
    forget: projectMemoryDeps.forget,
    list: projectMemoryDeps.list,
  })),
  resume: vi.fn(() => []),
  record: vi.fn(),
  createConversation: vi.fn(() => ({
    resume: projectMemoryDeps.resume,
    record: projectMemoryDeps.record,
  })),
}));

const voiceConfig = {
  input: {
    shortcut: "CommandOrControl+Shift+Space",
    pushToTalkKey: { code: "Space" },
  },
  wakeWord: { enabled: false },
  jarvisLive: { enabled: true },
};

const wakeEngineDeps = vi.hoisted(() => {
  type DetectedCb = () => void;
  const instances: Array<{
    onDetected: DetectedCb;
    feed: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    init: ReturnType<typeof vi.fn>;
  }> = [];
  let nextInitError: Error | null = null;
  return {
    instances,
    lastOnDetected: null as null | DetectedCb,
    failNextInit(error: Error) {
      nextInitError = error;
    },
    consumeInitError() {
      const error = nextInitError;
      nextInitError = null;
      return error;
    },
    reset() {
      instances.length = 0;
      this.lastOnDetected = null;
      nextInitError = null;
    },
  };
});

const hotkeyDeps = vi.hoisted(() => ({
  callbacks: null as null | {
    onStart: () => void;
    onStop: () => void;
    onToggle: () => void;
  },
  registerVoiceHotkey: vi.fn(
    (
      _shortcut: string,
      _keyCode: string,
      callbacks: {
        onStart: () => void;
        onStop: () => void;
        onToggle: () => void;
      },
    ) => {
      hotkeyDeps.callbacks = callbacks;
      return "global";
    },
  ),
  disposeVoiceHotkey: vi.fn(),
  isVoiceHotkeyArmed: vi.fn(() => true),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: electronDeps.handle,
    on: electronDeps.on,
  },
  BrowserWindow: {
    getAllWindows: () => electronDeps.windows,
    getFocusedWindow: () => electronDeps.focusedWindow,
  },
  dialog: {
    showMessageBox: vi.fn(async () => ({ response: 0 })),
  },
  app: {
    getVersion: () => "0.12.0-test",
    relaunch: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../persistence/renderer-workspace-scope", () => ({
  getRendererWorkspaceScope: scopeDeps.getRendererWorkspaceScope,
  requireRendererWorkspaceScope: scopeDeps.requireRendererWorkspaceScope,
}));

vi.mock("../orch/project-domain-store-registry", () => ({
  getProjectDomainStores: domainDeps.getProjectDomainStores,
}));

vi.mock("./live-transport-controller", () => ({
  LiveTransportController: class {
    constructor(
      emit: (channel: string, payload?: unknown) => void,
      _session: unknown,
      _now: () => number,
      pendingQuestionSource: { poll: () => unknown[] },
    ) {
      liveTransportDeps.constructed += 1;
      liveTransportDeps.emit = emit;
      liveTransportDeps.pendingQuestionSource = pendingQuestionSource;
    }

    onStart = liveTransportDeps.onStart;
    onStop = liveTransportDeps.onStop;
    hardStop = liveTransportDeps.hardStop;
    quiesce = liveTransportDeps.quiesce;
    endTurn = liveTransportDeps.endTurn;
    beginTurn = liveTransportDeps.beginTurn;
    smokeTest = liveTransportDeps.smokeTest;
    say = liveTransportDeps.say;
    micIn = liveTransportDeps.micIn;
    rescueText = liveTransportDeps.rescueText;
    contextIn = liveTransportDeps.contextIn;
    reportAudioPlayback = liveTransportDeps.reportAudioPlayback;
    toolResult = liveTransportDeps.toolResult;
    interrupt = liveTransportDeps.interrupt;
  },
}));

vi.mock("./voice-config-store", () => ({
  loadVoiceConfig: vi.fn(),
  getVoiceConfig: () => voiceConfig,
  applyConfigPatch: vi.fn(),
  buildRuntimeInfo: () => ({}),
  currentProbes: () => ({}),
  setHotkeyMode: vi.fn(),
  storeVoiceApiKey: vi.fn(() => ({ ok: true })),
}));

vi.mock("./jarvis-brain", () => ({
  defaultBrainDeps: {},
  jarvisThink: brainDeps.jarvisThink,
}));
vi.mock("./jarvis-conversation", () => ({
  createScopedJarvisConversation: projectMemoryDeps.createConversation,
}));
vi.mock("./jarvis-memory", () => ({
  createScopedJarvisMemory: projectMemoryDeps.createMemory,
}));
vi.mock("./wake-engine", () => ({
  WakeEngine: class {
    init = vi.fn(async () => {
      const error = wakeEngineDeps.consumeInitError();
      if (error) throw error;
    });
    feed = vi.fn();
    dispose = vi.fn(async () => undefined);
    constructor(onDetected: () => void) {
      wakeEngineDeps.lastOnDetected = onDetected;
      wakeEngineDeps.instances.push({
        onDetected,
        feed: this.feed,
        dispose: this.dispose,
        init: this.init,
      });
    }
  },
}));
vi.mock("./voice-log", () => ({ logVoice: vi.fn() }));
// F-1161: preferências de decisão controladas pelo teste; o padrão (sem
// opt-in de áudio) mantém os demais casos exatamente como antes.
const decisionDeps = vi.hoisted(() => ({ settings: null as unknown, clef: true }));
vi.mock("../decision-models/decision-availability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../decision-models/decision-availability")>();
  const shared = await import("../../shared/decision-models");
  type Settings = import("../../shared/decision-models").DecisionSettings;
  return {
    ...actual,
    getDecisionSettings: () => (decisionDeps.settings as Settings | null) ?? shared.decisionSettingsSchema.parse({}),
    getDecisionAvailability: (settings: Settings) => ({ jev: false, luna: false,
      clef: decisionDeps.clef && settings.mode !== "jev" && settings.mode !== "luna" }),
    getClefConnection: (settings: Settings) => ({ accountId: "0123456789abcdef0123456789abcdef",
      token: "synthetic-cloudflare-token", model: settings.clefModel,
      audioConsent: shared.hasAudioRecipientConsent(settings, "clef") }),
  };
});
vi.mock("../jev/jev-decision-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../jev/jev-decision-log")>()),
  recordJevDecision: vi.fn(() => "id"),
  recordJevNoAnswer: vi.fn(() => "id"),
}));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("./stt-service", () => ({ transcribe: vi.fn() }));
vi.mock("./tts-service", () => ({
  speak: vi.fn(),
  stopSystemSpeech: vi.fn(),
}));
vi.mock("./echo-suppress", () => ({
  echoSuppressor: { isEcho: vi.fn(() => false), record: vi.fn() },
}));
vi.mock("./mic-tcc", () => ({
  appBundlePathFromExecPath: vi.fn(),
  readBundleId: vi.fn(),
  resetMicrophoneTcc: vi.fn(),
}));
vi.mock("./wake-lock", () => ({
  acquireWakeLock: vi.fn(() => true),
  releaseWakeLock: vi.fn(),
  wakeLockHolder: vi.fn(() => null),
}));
vi.mock("../jarvis/realtime/metrics", () => ({
  jarvisLatencyTracker: { markTranscript: vi.fn() },
}));
vi.mock("../jarvis/transcript-store", () => ({
  createScopedTranscriptStore: transcriptDeps.createScopedTranscriptStore,
}));
vi.mock("./voice-hotkey", () => ({
  registerVoiceHotkey: hotkeyDeps.registerVoiceHotkey,
  disposeVoiceHotkey: hotkeyDeps.disposeVoiceHotkey,
  isVoiceHotkeyArmed: hotkeyDeps.isVoiceHotkeyArmed,
}));
vi.mock("./jarvis-narrator", () => ({
  initJarvisNarrator: vi.fn(
    (
      emit: (
        scope: ProjectExecutionScope,
        channel: string,
        payload?: unknown,
      ) => void,
    ) => {
      narratorDeps.emit = emit;
    },
  ),
  shutdownJarvisNarrator: vi.fn(),
}));
vi.mock("./live-runtime-config", () => ({
  isLiveTransportCredential: vi.fn(() => false),
  liveRuntimeFingerprint: vi.fn(() => "stable"),
}));

import { dialog } from "electron";
import { closeVoiceIpc, registerVoiceIpc } from "./voice-ipc";
import { logVoice } from "./voice-log";
import { transcribe } from "./stt-service";
import { bumpDecisionCredentialRevision } from "../decision-models/decision-revision";
import { decisionSettingsSchema } from "../../shared/decision-models";
import { syntheticWav } from "../decision-models/decision-audio.fixture";
import type { ProjectRuntimeManager } from "../runtime/project-runtime-manager";

const runtimeManager = {} as ProjectRuntimeManager;

class TestRenderer extends EventEmitter {
  readonly send = vi.fn();
  private destroyed = false;
  private crashed = false;

  constructor(readonly id: number) {
    super();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isCrashed(): boolean {
    return this.crashed;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

function testBrowserWindow(
  webContents: TestRenderer,
  options: { minimized?: boolean; visible?: boolean } = {},
) {
  const window = {
    webContents,
    isMinimized: vi.fn(() => options.minimized ?? false),
    isVisible: vi.fn(() => options.visible ?? true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(() => {
      electronDeps.focusedWindow = window;
    }),
  };
  return window;
}

const scopeA: ProjectExecutionScope = Object.freeze({
  version: 1,
  installationId: "install-a",
  projectId: "project-a",
  checkoutId: "checkout-a",
  rootRealPath: "/workspace/a",
  identitySource: "manifest",
});

const scopeB: ProjectExecutionScope = Object.freeze({
  version: 1,
  installationId: "install-a",
  projectId: "project-b",
  checkoutId: "checkout-b",
  rootRealPath: "/workspace/b",
  identitySource: "manifest",
});

function invoke(channel: string, sender: TestRenderer, raw?: unknown): unknown {
  const handler = electronDeps.handlers.get(channel);
  if (!handler) throw new Error(`missing IPC handler: ${channel}`);
  return handler({ sender }, raw);
}

function send(channel: string, sender: TestRenderer, raw?: unknown): unknown {
  const listener = electronDeps.listeners.get(channel);
  if (!listener) throw new Error(`missing IPC listener: ${channel}`);
  return listener({ sender }, raw);
}

function classicRequest(transcript = "lembre deste projeto") {
  return {
    transcript,
    context: {
      workspace: "/workspace/a",
      squads: [],
      panes: [],
      focusedPane: null,
    },
    history: [],
  };
}

/** Payload so handlers reach ownership checks (smoke validates body first). */
function ownerRejectionPayload(channel: string): unknown {
  if (channel === VOICE_CHANNELS.liveSmokeTest) {
    return { text: "probe ownership" };
  }
  if (channel === VOICE_CHANNELS.liveSay) {
    return { text: "say ownership" };
  }
  if (channel === VOICE_CHANNELS.liveStatus) {
    return { status: "listening" };
  }
  if (channel === VOICE_CHANNELS.liveRescueIn) {
    return { text: "rescue" };
  }
  if (channel === VOICE_CHANNELS.liveInterrupt) {
    return "test";
  }
  if (channel === VOICE_CHANNELS.liveQuiesce) {
    return "test";
  }
  if (channel === VOICE_CHANNELS.jarvis) {
    return classicRequest();
  }
  return undefined;
}

async function expectOwnerRejection(
  channel: string,
  sender: TestRenderer,
): Promise<void> {
  // liveInterrupt is intentionally a soft no-op during the cold-wake race.
  // It still fails closed and must never reach the transport without an owner.
  if (channel === VOICE_CHANNELS.liveInterrupt) {
    await expect(
      Promise.resolve().then(() =>
        invoke(channel, sender, ownerRejectionPayload(channel)),
      ),
    ).resolves.toEqual({ ok: false, reason: 'no-owner' });
    expect(liveTransportDeps.interrupt).not.toHaveBeenCalled();
    return;
  }
  await expect(
    Promise.resolve().then(() =>
      invoke(channel, sender, ownerRejectionPayload(channel)),
    ),
  ).rejects.toThrow(/owned by another window/i);
}

const protectedInvokeChannels = [
  VOICE_CHANNELS.jarvis,
  VOICE_CHANNELS.liveStop,
  VOICE_CHANNELS.liveHardRebuild,
  VOICE_CHANNELS.liveHardTeardown,
  VOICE_CHANNELS.liveQuiesce,
  VOICE_CHANNELS.liveEndTurn,
  VOICE_CHANNELS.liveEndUserAudio,
  VOICE_CHANNELS.liveSmokeTest,
  VOICE_CHANNELS.liveSay,
  VOICE_CHANNELS.liveRescueIn,
  VOICE_CHANNELS.liveStatus,
  VOICE_CHANNELS.liveInterrupt,
] as const;

function pcmFrame(samples = 1280): Float32Array {
  return new Float32Array(samples).fill(0.1);
}

beforeEach(() => {
  closeVoiceIpc();
  vi.clearAllMocks();
  electronDeps.handlers.clear();
  electronDeps.listeners.clear();
  electronDeps.windows.length = 0;
  electronDeps.focusedWindow = null;
  scopeDeps.scopes.clear();
  narratorDeps.emit = null;
  hotkeyDeps.callbacks = null;
  wakeEngineDeps.reset();
  voiceConfig.wakeWord.enabled = false;
  registerVoiceIpc(runtimeManager);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Voice Live IPC ownership", () => {
  it.each([
    ["explicit dev kill-switch", "NEXUS_DISABLE_VOICE_CAPTURE"],
  ])("does not arm wake or Live during %s automation", async (_label, envName) => {
    closeVoiceIpc();
    vi.stubEnv(envName, "1");
    hotkeyDeps.registerVoiceHotkey.mockClear();
    registerVoiceIpc(runtimeManager);

    const owner = new TestRenderer(80);
    scopeDeps.scopes.set(owner.id, scopeA);
    electronDeps.focusedWindow = { webContents: owner };

    expect(invoke(VOICE_CHANNELS.getInfo, owner)).toMatchObject({
      captureAllowed: false,
      hotkeyArmed: false,
    });
    send(VOICE_CHANNELS.wakeAudio, owner, pcmFrame());
    expect(wakeEngineDeps.instances).toHaveLength(0);
    expect(hotkeyDeps.registerVoiceHotkey).not.toHaveBeenCalled();
    await expect(
      Promise.resolve().then(() =>
        invoke(VOICE_CHANNELS.liveStart, owner, { reason: "wake" }),
      ),
    ).rejects.toThrow(/voice capture disabled/i);
  });

  it("binds classic conversation and memory to the request scope", async () => {
    const owner = new TestRenderer(81);
    scopeDeps.scopes.set(owner.id, scopeA);
    brainDeps.jarvisThink.mockImplementationOnce(
      async (...args: unknown[]) => {
        const deps = args[3] as {
          memory: { remember(key: string, content: string): void };
        };
        deps.memory.remember("deploy", "sexta-feira");
        return {
          say: "Contexto do projeto A",
          action: { type: "none" },
        };
      },
    );

    await expect(
      invoke(VOICE_CHANNELS.jarvis, owner, classicRequest()),
    ).resolves.toEqual({
      say: "Contexto do projeto A",
      action: { type: "none" },
    });

    expect(projectMemoryDeps.createConversation).toHaveBeenCalledWith(
      runtimeManager,
      scopeA,
    );
    expect(projectMemoryDeps.createMemory).toHaveBeenCalledWith(
      runtimeManager,
      scopeA,
    );
    expect(brainDeps.jarvisThink).toHaveBeenCalledWith(
      "lembre deste projeto",
      expect.any(Object),
      [],
      expect.objectContaining({ memory: expect.any(Object) }),
    );
    expect(projectMemoryDeps.record).toHaveBeenCalledWith(
      "lembre deste projeto",
      "Contexto do projeto A",
    );
    expect(projectMemoryDeps.remember).toHaveBeenCalledWith(
      "deploy",
      "sexta-feira",
    );
  });

  it("runs the settings smoke test without a workspace and strips actions", async () => {
    brainDeps.jarvisThink.mockResolvedValueOnce({
      say: "Jarvis online",
      action: { type: "open_terminal" },
    });

    await expect(
      invoke(VOICE_CHANNELS.jarvisSmokeTest, new TestRenderer(83), {
        transcript: "diagnóstico rápido da jarvis",
      }),
    ).resolves.toEqual({
      say: "Jarvis online",
      action: { type: "none" },
    });
    expect(scopeDeps.requireRendererWorkspaceScope).not.toHaveBeenCalled();
    expect(projectMemoryDeps.createMemory).not.toHaveBeenCalled();
    expect(projectMemoryDeps.createConversation).not.toHaveBeenCalled();
  });

  it("discards a classic reply when the renderer changes project in flight", async () => {
    const owner = new TestRenderer(82);
    scopeDeps.scopes.set(owner.id, scopeA);
    let resolveThink!: (reply: {
      say: string;
      action: { type: "none" };
    }) => void;
    brainDeps.jarvisThink.mockImplementationOnce(
      (...args: unknown[]) => {
        const deps = args[3] as {
          memory: { remember(key: string, content: string): void };
        };
        deps.memory.remember("stale", "segredo do projeto A");
        return new Promise((resolve) => {
          resolveThink = resolve;
        });
      },
    );

    const pending = Promise.resolve(
      invoke(VOICE_CHANNELS.jarvis, owner, classicRequest("pedido lento A")),
    );
    await vi.waitFor(() => expect(brainDeps.jarvisThink).toHaveBeenCalledOnce());
    scopeDeps.scopes.set(owner.id, scopeB);
    resolveThink({ say: "segredo do projeto A", action: { type: "none" } });

    await expect(pending).rejects.toThrow(/project scope changed/i);
    expect(projectMemoryDeps.record).not.toHaveBeenCalled();
    expect(projectMemoryDeps.remember).not.toHaveBeenCalled();
  });

  it("binds persisted transcript rows to the captured owner scope", async () => {
    const owner = new TestRenderer(91);
    scopeDeps.scopes.set(owner.id, scopeA);
    transcriptDeps.append.mockImplementationOnce((sessionId, line) => ({
      id: "voice-transcript-1",
      sessionId,
      sequence: 1,
      projectId: scopeA.projectId,
      checkoutId: scopeA.checkoutId,
      ts: "2026-07-10T12:00:00.000Z",
      role: (line as { role: string }).role,
      text: (line as { text: string }).text,
      audio_url: null,
      final: true,
    }));

    const state = await invoke(VOICE_CHANNELS.liveStart, owner, {
      reason: "manual",
    });
    send(VOICE_CHANNELS.liveTranscriptIn, owner, {
      role: "user",
      text: "somente projeto A",
      final: true,
    });

    expect(transcriptDeps.createScopedTranscriptStore).toHaveBeenCalledWith(
      runtimeManager,
      scopeA,
    );
    expect(transcriptDeps.append).toHaveBeenCalledWith(
      (state as { sessionId: string }).sessionId,
      expect.objectContaining({ text: "somente projeto A", final: true }),
    );
    expect(owner.send).toHaveBeenCalledWith(
      VOICE_CHANNELS.jarvisTranscriptAppend,
      expect.objectContaining({
        sessionId: (state as { sessionId: string }).sessionId,
        projectId: scopeA.projectId,
        text: "somente projeto A",
      }),
    );

    transcriptDeps.createScopedTranscriptStore.mockClear();
    transcriptDeps.append.mockClear();
    scopeDeps.scopes.set(owner.id, scopeB);
    send(VOICE_CHANNELS.liveTranscriptIn, owner, {
      role: "user",
      text: "não pode migrar para B",
      final: true,
    });
    expect(transcriptDeps.createScopedTranscriptStore).not.toHaveBeenCalled();
    expect(transcriptDeps.append).not.toHaveBeenCalled();
  });

  it.each([
    ['manual', true],
    ['wake', true],
    ['click', true],
    ['ptt', true],
    ['reply', false],
  ] as const)(
    'derives fresh realtime socket ownership for %s turns',
    async (reason, freshTurn) => {
      const owner = new TestRenderer(92);
      scopeDeps.scopes.set(owner.id, scopeA);

      await invoke(VOICE_CHANNELS.liveStart, owner, { reason });

      expect(liveTransportDeps.onStart).toHaveBeenLastCalledWith({
        greeting: undefined,
        freshTurn,
      });
    },
  );

  it("keeps passive prewarm credential-free and leaves ownership unclaimed", async () => {
    const ownerA = new TestRenderer(93);
    const ownerB = new TestRenderer(94);
    scopeDeps.scopes.set(ownerA.id, scopeA);
    scopeDeps.scopes.set(ownerB.id, scopeB);

    await expect(
      invoke(VOICE_CHANNELS.livePrewarm, ownerA, { enabled: true }),
    ).resolves.toMatchObject({ status: "dormant" });
    expect(liveTransportDeps.onStart).not.toHaveBeenCalled();

    // A passive mount must not reserve Live authority. The first explicit turn
    // can still claim it for its current project.
    await expect(
      invoke(VOICE_CHANNELS.liveStart, ownerB, { reason: "wake" }),
    ).resolves.toMatchObject({ status: "listening" });
    expect(liveTransportDeps.onStart).toHaveBeenCalledWith({
      greeting: undefined,
      freshTurn: true,
    });
  });

  it("claims live ownership from smokeTest without a prior liveStart", async () => {
    const owner = new TestRenderer(99);
    const otherProject = new TestRenderer(199);
    scopeDeps.scopes.set(owner.id, scopeA);
    scopeDeps.scopes.set(otherProject.id, scopeB);
    electronDeps.windows.push(
      { webContents: owner },
      { webContents: otherProject },
    );

    await expect(
      invoke(VOICE_CHANNELS.liveSmokeTest, owner, {
        text: "responda que está online",
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(liveTransportDeps.smokeTest).toHaveBeenCalledWith(
      "responda que está online",
      owner.id,
    );

    // Ownership is now held — another project cannot steal via smokeTest.
    await expect(
      Promise.resolve().then(() =>
        invoke(VOICE_CHANNELS.liveSmokeTest, otherProject, {
          text: "não deveria roubar",
        }),
      ),
    ).rejects.toThrow(/owned by another window/i);
  });

  it("pins every live invoke/event and outbound event to one owner and scope", async () => {
    const owner = new TestRenderer(101);
    const sameProjectOtherWindow = new TestRenderer(102);
    const otherProject = new TestRenderer(201);
    scopeDeps.scopes.set(owner.id, scopeA);
    scopeDeps.scopes.set(sameProjectOtherWindow.id, scopeA);
    scopeDeps.scopes.set(otherProject.id, scopeB);
    electronDeps.windows.push(
      { webContents: owner },
      { webContents: sameProjectOtherWindow },
      { webContents: otherProject },
    );

    await invoke(VOICE_CHANNELS.liveStart, owner, { reason: "manual" });

    expect(owner.send).toHaveBeenCalledWith(
      VOICE_CHANNELS.liveState,
      expect.objectContaining({ status: "listening" }),
    );
    expect(sameProjectOtherWindow.send).not.toHaveBeenCalled();
    expect(otherProject.send).not.toHaveBeenCalled();

    await expect(
      Promise.resolve().then(() =>
        invoke(VOICE_CHANNELS.liveStart, sameProjectOtherWindow, {
          reason: "manual",
        }),
      ),
    ).rejects.toThrow(/owned by another window/i);
    await expect(
      Promise.resolve().then(() =>
        invoke(VOICE_CHANNELS.liveStart, otherProject, { reason: "manual" }),
      ),
    ).rejects.toThrow(/owned by another window/i);

    for (const channel of protectedInvokeChannels) {
      await expectOwnerRejection(channel, otherProject);
    }

    const ownerSendCount = owner.send.mock.calls.length;
    send(VOICE_CHANNELS.liveTurnBegin, otherProject, "turn-b");
    send(VOICE_CHANNELS.liveMicIn, otherProject, "AA==");
    send(VOICE_CHANNELS.liveContextIn, otherProject, "context B");
    send(VOICE_CHANNELS.liveAudioPlayback, otherProject, {
      id: "10000000-0000-4000-8000-000000000001",
      outcome: "started",
    });
    send(VOICE_CHANNELS.liveTranscriptIn, otherProject, {
      role: "user",
      text: "injeção B",
      final: true,
    });
    send(VOICE_CHANNELS.liveToolResultIn, otherProject, {
      tool: "none",
      summary: "resultado B",
      ok: true,
    });

    expect(liveTransportDeps.beginTurn).not.toHaveBeenCalled();
    expect(liveTransportDeps.micIn).not.toHaveBeenCalled();
    expect(liveTransportDeps.contextIn).not.toHaveBeenCalled();
    expect(liveTransportDeps.reportAudioPlayback).not.toHaveBeenCalled();
    expect(liveTransportDeps.toolResult).not.toHaveBeenCalled();
    expect(owner.send).toHaveBeenCalledTimes(ownerSendCount);

    send(VOICE_CHANNELS.liveMicIn, owner, "AA==");
    expect(liveTransportDeps.micIn).toHaveBeenCalledWith("AA==");

    liveTransportDeps.emit?.(VOICE_CHANNELS.liveAudioOut, {
      id: "audio-a",
      pcm16: "AA==",
    });
    expect(owner.send).toHaveBeenCalledWith(VOICE_CHANNELS.liveAudioOut, {
      id: "audio-a",
      pcm16: "AA==",
    });
    expect(sameProjectOtherWindow.send).not.toHaveBeenCalled();
    expect(otherProject.send).not.toHaveBeenCalled();
  });

  it("pins PendingQuestionSource to the captured project scope", async () => {
    const owner = new TestRenderer(301);
    scopeDeps.scopes.set(owner.id, scopeA);

    await invoke(VOICE_CHANNELS.liveStart, owner, { reason: "manual" });

    expect(liveTransportDeps.pendingQuestionSource?.poll()).toEqual([
      { paneId: "pane-a", questionHash: "Pergunta A" },
    ]);
    expect(domainDeps.getProjectDomainStores).toHaveBeenLastCalledWith(scopeA);

    scopeDeps.scopes.set(owner.id, scopeB);
    domainDeps.getProjectDomainStores.mockClear();

    expect(liveTransportDeps.pendingQuestionSource?.poll()).toEqual([]);
    expect(domainDeps.getProjectDomainStores).not.toHaveBeenCalled();
    await expect(
      Promise.resolve().then(() =>
        invoke(VOICE_CHANNELS.liveStatus, owner, { status: "listening" }),
      ),
    ).rejects.toThrow(/project scope changed/i);
  });

  it.each([
    ["stop", VOICE_CHANNELS.liveStop],
    ["hard teardown", VOICE_CHANNELS.liveHardTeardown],
    ["quiesce", VOICE_CHANNELS.liveQuiesce],
  ])("releases ownership after %s", async (_label, releaseChannel) => {
    const ownerA = new TestRenderer(401);
    const ownerB = new TestRenderer(402);
    scopeDeps.scopes.set(ownerA.id, scopeA);
    scopeDeps.scopes.set(ownerB.id, scopeB);

    await invoke(VOICE_CHANNELS.liveStart, ownerA, { reason: "manual" });
    await invoke(releaseChannel, ownerA);

    await expect(
      invoke(VOICE_CHANNELS.liveStart, ownerB, { reason: "manual" }),
    ).resolves.toMatchObject({ status: "listening" });
  });

  it("treats repeated Classic quiesce as idempotent after ownership was released", async () => {
    const owner = new TestRenderer(403);
    scopeDeps.scopes.set(owner.id, scopeA);

    await invoke(VOICE_CHANNELS.liveStart, owner, { reason: "manual" });
    await invoke(VOICE_CHANNELS.liveQuiesce, owner, { reason: "classic-action" });
    liveTransportDeps.hardStop.mockClear();

    expect(
      invoke(VOICE_CHANNELS.liveQuiesce, owner, { reason: "classic-tts" }),
    ).toMatchObject({ status: expect.any(String) });
    expect(liveTransportDeps.hardStop).toHaveBeenCalledOnce();
  });

  it.each([
    ["stop", VOICE_CHANNELS.liveStop],
    ["hard teardown", VOICE_CHANNELS.liveHardTeardown],
  ])("treats repeated %s without an owner as a privacy-safe success", async (_label, channel) => {
    const owner = new TestRenderer(405);
    scopeDeps.scopes.set(owner.id, scopeA);

    await invoke(VOICE_CHANNELS.liveStart, owner, { reason: "manual" });
    await invoke(VOICE_CHANNELS.liveQuiesce, owner, { reason: "classic-action" });

    expect(invoke(channel, owner)).toMatchObject({
      status: "dormant",
      sessionId: null,
      realtimeReady: false,
    });
    expect(invoke(channel, owner)).toMatchObject({
      status: "dormant",
      sessionId: null,
      realtimeReady: false,
    });
  });

  it.each([
    VOICE_CHANNELS.liveEndTurn,
    VOICE_CHANNELS.liveEndUserAudio,
  ])("treats a late %s after ownership release as an idempotent no-op", async (channel) => {
    const owner = new TestRenderer(404);
    scopeDeps.scopes.set(owner.id, scopeA);

    await invoke(VOICE_CHANNELS.liveStart, owner, { reason: "manual" });
    await invoke(VOICE_CHANNELS.liveQuiesce, owner, { reason: "classic-action" });
    liveTransportDeps.endTurn.mockClear();

    expect(invoke(channel, owner)).toMatchObject({ status: expect.any(String) });
    expect(liveTransportDeps.endTurn).not.toHaveBeenCalled();
  });

  it("releases ownership when the owner closes and on closeVoiceIpc", async () => {
    const ownerA = new TestRenderer(501);
    const ownerB = new TestRenderer(502);
    scopeDeps.scopes.set(ownerA.id, scopeA);
    scopeDeps.scopes.set(ownerB.id, scopeB);

    await invoke(VOICE_CHANNELS.liveStart, ownerA, { reason: "manual" });
    ownerA.destroy();
    await expect(
      invoke(VOICE_CHANNELS.liveStart, ownerB, { reason: "manual" }),
    ).resolves.toMatchObject({ status: "listening" });

    closeVoiceIpc();
    registerVoiceIpc(runtimeManager);
    const ownerC = new TestRenderer(503);
    scopeDeps.scopes.set(ownerC.id, scopeA);
    await expect(
      invoke(VOICE_CHANNELS.liveStart, ownerC, { reason: "manual" }),
    ).resolves.toMatchObject({ status: "listening" });
  });

  it("reuses grace only for the same owner/scope and rebuilds across projects", async () => {
    const ownerA = new TestRenderer(551);
    const ownerB = new TestRenderer(552);
    scopeDeps.scopes.set(ownerA.id, scopeA);
    scopeDeps.scopes.set(ownerB.id, scopeB);

    await invoke(VOICE_CHANNELS.liveStart, ownerA, { reason: "manual" });
    const afterFirstStart = liveTransportDeps.constructed;
    await invoke(VOICE_CHANNELS.liveStop, ownerA);
    await invoke(VOICE_CHANNELS.liveStart, ownerA, { reason: "manual" });

    expect(liveTransportDeps.constructed).toBe(afterFirstStart);

    await invoke(VOICE_CHANNELS.liveStop, ownerA);
    await invoke(VOICE_CHANNELS.liveStart, ownerB, { reason: "manual" });

    expect(liveTransportDeps.constructed).toBe(afterFirstStart + 1);
    expect(liveTransportDeps.hardStop).toHaveBeenCalled();
  });

  it("keeps proactive narration project-scoped instead of owner-only", () => {
    const ownerA = new TestRenderer(601);
    const peerA = new TestRenderer(602);
    const ownerB = new TestRenderer(603);
    scopeDeps.scopes.set(ownerA.id, scopeA);
    scopeDeps.scopes.set(peerA.id, scopeA);
    scopeDeps.scopes.set(ownerB.id, scopeB);
    electronDeps.windows.push(
      { webContents: ownerA },
      { webContents: peerA },
      { webContents: ownerB },
    );

    narratorDeps.emit?.(scopeA, VOICE_CHANNELS.narrate, { text: "Projeto A" });

    expect(ownerA.send).toHaveBeenCalledOnce();
    expect(peerA.send).toHaveBeenCalledOnce();
    expect(ownerB.send).not.toHaveBeenCalled();
  });
});

describe("Voice PTT and wake multi-window isolation", () => {
  it("sends PTT only to the valid Live owner across two project windows", async () => {
    const ownerA = new TestRenderer(701);
    const otherB = new TestRenderer(702);
    scopeDeps.scopes.set(ownerA.id, scopeA);
    scopeDeps.scopes.set(otherB.id, scopeB);
    electronDeps.windows.push(
      { webContents: ownerA },
      { webContents: otherB },
    );
    electronDeps.focusedWindow = { webContents: otherB };

    await invoke(VOICE_CHANNELS.liveStart, ownerA, { reason: "manual" });
    ownerA.send.mockClear();
    otherB.send.mockClear();

    hotkeyDeps.callbacks?.onStart();
    hotkeyDeps.callbacks?.onStop();
    hotkeyDeps.callbacks?.onToggle();

    expect(ownerA.send).toHaveBeenCalledWith(VOICE_CHANNELS.pttStart);
    expect(ownerA.send).toHaveBeenCalledWith(VOICE_CHANNELS.pttStop);
    expect(ownerA.send).toHaveBeenCalledWith(VOICE_CHANNELS.pttToggle);
    expect(otherB.send).not.toHaveBeenCalledWith(
      VOICE_CHANNELS.pttStart,
      expect.anything(),
    );
    expect(otherB.send).not.toHaveBeenCalledWith(VOICE_CHANNELS.pttStart);
    expect(otherB.send).not.toHaveBeenCalledWith(VOICE_CHANNELS.pttStop);
    expect(otherB.send).not.toHaveBeenCalledWith(VOICE_CHANNELS.pttToggle);
  });

  it("without Live, sends PTT only to the focused authorized window", () => {
    const windowA = new TestRenderer(711);
    const windowB = new TestRenderer(712);
    scopeDeps.scopes.set(windowA.id, scopeA);
    scopeDeps.scopes.set(windowB.id, scopeB);
    electronDeps.windows.push(
      { webContents: windowA },
      { webContents: windowB },
    );
    electronDeps.focusedWindow = { webContents: windowA };

    hotkeyDeps.callbacks?.onStart();
    hotkeyDeps.callbacks?.onToggle();

    expect(windowA.send).toHaveBeenCalledWith(VOICE_CHANNELS.pttStart);
    expect(windowA.send).toHaveBeenCalledWith(VOICE_CHANNELS.pttToggle);
    expect(windowB.send).not.toHaveBeenCalled();
  });

  it("does not send PTT without a trustworthy target", () => {
    const windowA = new TestRenderer(721);
    const windowB = new TestRenderer(722);
    // No authorized scope registered for either window.
    electronDeps.windows.push(
      { webContents: windowA },
      { webContents: windowB },
    );
    electronDeps.focusedWindow = { webContents: windowA };

    hotkeyDeps.callbacks?.onStart();
    hotkeyDeps.callbacks?.onStop();
    hotkeyDeps.callbacks?.onToggle();

    expect(windowA.send).not.toHaveBeenCalled();
    expect(windowB.send).not.toHaveBeenCalled();

    // Focused but destroyed.
    const dead = new TestRenderer(723);
    scopeDeps.scopes.set(dead.id, scopeA);
    electronDeps.focusedWindow = { webContents: dead };
    dead.destroy();
    hotkeyDeps.callbacks?.onStart();
    expect(dead.send).not.toHaveBeenCalled();

    // A single authorized window can be recovered when Nexus is unfocused.
    electronDeps.focusedWindow = null;
    const orphan = new TestRenderer(724);
    scopeDeps.scopes.set(orphan.id, scopeA);
    const recovered = testBrowserWindow(orphan);
    electronDeps.windows.push(recovered);
    hotkeyDeps.callbacks?.onStart();
    expect(orphan.send).toHaveBeenCalledWith(VOICE_CHANNELS.pttStart);
    expect(recovered.focus).toHaveBeenCalledOnce();
  });

  it("restores one authorized Nexus window for the global shortcut", () => {
    const windowA = new TestRenderer(725);
    scopeDeps.scopes.set(windowA.id, scopeA);
    const hidden = testBrowserWindow(windowA, { minimized: true, visible: false });
    electronDeps.windows.push(hidden);
    electronDeps.focusedWindow = null;

    hotkeyDeps.callbacks?.onToggle();

    expect(hidden.restore).toHaveBeenCalledOnce();
    expect(hidden.show).toHaveBeenCalledOnce();
    expect(hidden.focus).toHaveBeenCalledOnce();
    expect(windowA.send).toHaveBeenCalledWith(VOICE_CHANNELS.pttToggle);
  });

  it("keeps a global shortcut fail-closed when several project windows are available", () => {
    const windowA = new TestRenderer(726);
    const windowB = new TestRenderer(727);
    scopeDeps.scopes.set(windowA.id, scopeA);
    scopeDeps.scopes.set(windowB.id, scopeB);
    const candidateA = testBrowserWindow(windowA);
    const candidateB = testBrowserWindow(windowB);
    electronDeps.windows.push(candidateA, candidateB);
    electronDeps.focusedWindow = null;

    hotkeyDeps.callbacks?.onStart();

    expect(candidateA.focus).not.toHaveBeenCalled();
    expect(candidateB.focus).not.toHaveBeenCalled();
    expect(windowA.send).not.toHaveBeenCalled();
    expect(windowB.send).not.toHaveBeenCalled();
  });

  it("rejects project-B wake frames once project A owns the engine", () => {
    voiceConfig.wakeWord.enabled = true;
    const windowA = new TestRenderer(731);
    const windowB = new TestRenderer(732);
    scopeDeps.scopes.set(windowA.id, scopeA);
    scopeDeps.scopes.set(windowB.id, scopeB);
    electronDeps.windows.push(
      { webContents: windowA },
      { webContents: windowB },
    );
    electronDeps.focusedWindow = { webContents: windowA };

    send(VOICE_CHANNELS.wakeAudio, windowA, pcmFrame());
    expect(wakeEngineDeps.instances).toHaveLength(1);
    const engineA = wakeEngineDeps.instances[0]!;
    expect(engineA.feed).toHaveBeenCalledTimes(1);

    electronDeps.focusedWindow = { webContents: windowB };
    // B is focused now — intentional owner switch is allowed only from focused.
    // But first verify unfocused B cannot feed while A still holds focus-less steal:
    electronDeps.focusedWindow = { webContents: windowA };
    send(VOICE_CHANNELS.wakeAudio, windowB, pcmFrame());
    expect(engineA.feed).toHaveBeenCalledTimes(1);
    expect(wakeEngineDeps.instances).toHaveLength(1);
  });

  it("claims wake on cold start while Nexus is authorized but not OS-focused", () => {
    voiceConfig.wakeWord.enabled = true;
    const windowA = new TestRenderer(735);
    scopeDeps.scopes.set(windowA.id, scopeA);
    electronDeps.windows.push({ webContents: windowA });
    electronDeps.focusedWindow = null;

    send(VOICE_CHANNELS.wakeAudio, windowA, pcmFrame());

    expect(wakeEngineDeps.instances).toHaveLength(1);
    expect(wakeEngineDeps.instances[0]!.feed).toHaveBeenCalledTimes(1);
  });

  it("wakes Jarvis without mutating missions", () => {
    voiceConfig.wakeWord.enabled = true;
    domainDeps.missionList.mockReturnValue([]);
    domainDeps.missionCreate.mockClear();
    domainDeps.missionSetStatus.mockClear();

    const windowA = new TestRenderer(801);
    scopeDeps.scopes.set(windowA.id, scopeA);
    electronDeps.windows.push({ webContents: windowA });
    electronDeps.focusedWindow = { webContents: windowA };

    send(VOICE_CHANNELS.wakeAudio, windowA, pcmFrame());
    const onDetected = wakeEngineDeps.lastOnDetected;
    expect(onDetected).toBeTypeOf("function");

    onDetected?.();

    expect(windowA.send).toHaveBeenCalledWith(VOICE_CHANNELS.wakeDetected);
    expect(domainDeps.missionList).not.toHaveBeenCalled();
    expect(domainDeps.missionCreate).not.toHaveBeenCalled();
    expect(domainDeps.missionSetStatus).not.toHaveBeenCalled();
  });

  it("does not resume an existing mission until transcript intent is understood", () => {
    voiceConfig.wakeWord.enabled = true;
    domainDeps.missionList.mockReturnValue([
      {
        id: "mission-existing",
        status: "running",
        updatedAt: 100,
        title: "Already running",
      },
    ]);
    domainDeps.missionCreate.mockClear();
    domainDeps.missionSetStatus.mockClear();

    const windowA = new TestRenderer(802);
    scopeDeps.scopes.set(windowA.id, scopeA);
    electronDeps.windows.push({ webContents: windowA });
    electronDeps.focusedWindow = { webContents: windowA };

    send(VOICE_CHANNELS.wakeAudio, windowA, pcmFrame());
    wakeEngineDeps.lastOnDetected?.();

    expect(windowA.send).toHaveBeenCalledWith(VOICE_CHANNELS.wakeDetected);
    expect(domainDeps.missionList).not.toHaveBeenCalled();
    expect(domainDeps.missionCreate).not.toHaveBeenCalled();
    expect(domainDeps.missionSetStatus).not.toHaveBeenCalled();
  });

  it("does not deliver wakeDetected from A to project B", () => {
    voiceConfig.wakeWord.enabled = true;
    const windowA = new TestRenderer(741);
    const windowB = new TestRenderer(742);
    scopeDeps.scopes.set(windowA.id, scopeA);
    scopeDeps.scopes.set(windowB.id, scopeB);
    electronDeps.windows.push(
      { webContents: windowA },
      { webContents: windowB },
    );
    electronDeps.focusedWindow = { webContents: windowA };

    send(VOICE_CHANNELS.wakeAudio, windowA, pcmFrame());
    expect(wakeEngineDeps.lastOnDetected).toBeTypeOf("function");
    wakeEngineDeps.lastOnDetected?.();

    expect(windowA.send).toHaveBeenCalledWith(VOICE_CHANNELS.wakeDetected);
    expect(windowB.send).not.toHaveBeenCalledWith(VOICE_CHANNELS.wakeDetected);
  });

  it("discards late wake detection after A→B scope change", () => {
    voiceConfig.wakeWord.enabled = true;
    const windowA = new TestRenderer(751);
    scopeDeps.scopes.set(windowA.id, scopeA);
    electronDeps.windows.push({ webContents: windowA });
    electronDeps.focusedWindow = { webContents: windowA };

    send(VOICE_CHANNELS.wakeAudio, windowA, pcmFrame());
    const onDetected = wakeEngineDeps.lastOnDetected;
    expect(onDetected).toBeTypeOf("function");

    scopeDeps.scopes.set(windowA.id, scopeB);
    onDetected?.();

    expect(windowA.send).not.toHaveBeenCalledWith(VOICE_CHANNELS.wakeDetected);
  });

  it("discards late wake detection after owner renderer is destroyed", () => {
    voiceConfig.wakeWord.enabled = true;
    const windowA = new TestRenderer(761);
    const windowB = new TestRenderer(762);
    scopeDeps.scopes.set(windowA.id, scopeA);
    scopeDeps.scopes.set(windowB.id, scopeB);
    electronDeps.windows.push(
      { webContents: windowA },
      { webContents: windowB },
    );
    electronDeps.focusedWindow = { webContents: windowA };

    send(VOICE_CHANNELS.wakeAudio, windowA, pcmFrame());
    const onDetected = wakeEngineDeps.lastOnDetected;
    expect(onDetected).toBeTypeOf("function");

    windowA.destroy();
    onDetected?.();

    expect(windowA.send).not.toHaveBeenCalledWith(VOICE_CHANNELS.wakeDetected);
    expect(windowB.send).not.toHaveBeenCalledWith(VOICE_CHANNELS.wakeDetected);
  });

  it("releases wake ownership and rejects its late detector callback on stop", () => {
    voiceConfig.wakeWord.enabled = true;
    const owner = new TestRenderer(763);
    scopeDeps.scopes.set(owner.id, scopeA);
    electronDeps.focusedWindow = { webContents: owner };

    send(VOICE_CHANNELS.wakeAudio, owner, pcmFrame());
    const engine = wakeEngineDeps.instances[0]!;
    const staleDetected = wakeEngineDeps.lastOnDetected;

    send(VOICE_CHANNELS.wakeStop, owner);
    send(VOICE_CHANNELS.wakeStop, owner);

    expect(engine.dispose).toHaveBeenCalledOnce();
    staleDetected?.();
    expect(owner.send).not.toHaveBeenCalledWith(VOICE_CHANNELS.wakeDetected);

    // Explicit renderer reactivation resumes PCM and claims a fresh generation.
    send(VOICE_CHANNELS.wakeAudio, owner, pcmFrame());
    expect(wakeEngineDeps.instances).toHaveLength(2);
  });

  it("does not let another renderer stop the current wake owner", () => {
    voiceConfig.wakeWord.enabled = true;
    const owner = new TestRenderer(764);
    const unrelated = new TestRenderer(765);
    scopeDeps.scopes.set(owner.id, scopeA);
    scopeDeps.scopes.set(unrelated.id, scopeB);
    electronDeps.focusedWindow = { webContents: owner };

    send(VOICE_CHANNELS.wakeAudio, owner, pcmFrame());
    const engine = wakeEngineDeps.instances[0]!;
    send(VOICE_CHANNELS.wakeStop, unrelated);

    expect(engine.dispose).not.toHaveBeenCalled();
    wakeEngineDeps.lastOnDetected?.();
    expect(owner.send).toHaveBeenCalledWith(VOICE_CHANNELS.wakeDetected);
  });

  it("disposes the previous WakeEngine on a valid intentional owner switch", () => {
    voiceConfig.wakeWord.enabled = true;
    const windowA = new TestRenderer(771);
    const windowB = new TestRenderer(772);
    scopeDeps.scopes.set(windowA.id, scopeA);
    scopeDeps.scopes.set(windowB.id, scopeB);
    electronDeps.windows.push(
      { webContents: windowA },
      { webContents: windowB },
    );
    electronDeps.focusedWindow = { webContents: windowA };

    send(VOICE_CHANNELS.wakeAudio, windowA, pcmFrame());
    expect(wakeEngineDeps.instances).toHaveLength(1);
    const engineA = wakeEngineDeps.instances[0]!;
    const staleDetected = wakeEngineDeps.lastOnDetected;

    electronDeps.focusedWindow = { webContents: windowB };
    send(VOICE_CHANNELS.wakeAudio, windowB, pcmFrame());

    expect(engineA.dispose).toHaveBeenCalled();
    expect(wakeEngineDeps.instances).toHaveLength(2);
    const engineB = wakeEngineDeps.instances[1]!;
    expect(engineB.feed).toHaveBeenCalledTimes(1);

    // Stale callback from generation A must not fire after switch.
    staleDetected?.();
    expect(windowA.send).not.toHaveBeenCalledWith(VOICE_CHANNELS.wakeDetected);
    expect(windowB.send).not.toHaveBeenCalledWith(VOICE_CHANNELS.wakeDetected);

    wakeEngineDeps.lastOnDetected?.();
    expect(windowB.send).toHaveBeenCalledWith(VOICE_CHANNELS.wakeDetected);
    expect(windowA.send).not.toHaveBeenCalledWith(VOICE_CHANNELS.wakeDetected);
  });

  it("closeVoiceIpc clears wake owner, listeners and engine", () => {
    voiceConfig.wakeWord.enabled = true;
    const windowA = new TestRenderer(781);
    scopeDeps.scopes.set(windowA.id, scopeA);
    electronDeps.windows.push({ webContents: windowA });
    electronDeps.focusedWindow = { webContents: windowA };

    send(VOICE_CHANNELS.wakeAudio, windowA, pcmFrame());
    expect(wakeEngineDeps.instances).toHaveLength(1);
    const engineA = wakeEngineDeps.instances[0]!;
    const staleDetected = wakeEngineDeps.lastOnDetected;

    closeVoiceIpc();
    expect(engineA.dispose).toHaveBeenCalled();
    expect(hotkeyDeps.disposeVoiceHotkey).toHaveBeenCalled();

    staleDetected?.();
    expect(windowA.send).not.toHaveBeenCalledWith(VOICE_CHANNELS.wakeDetected);

    // After close + re-register, previous ownership must not resurrect without claim.
    registerVoiceIpc(runtimeManager);
    voiceConfig.wakeWord.enabled = true;
    const windowB = new TestRenderer(782);
    scopeDeps.scopes.set(windowB.id, scopeB);
    // B is a new authorized renderer and can claim cold-start wake without OS focus.
    electronDeps.focusedWindow = null;
    send(VOICE_CHANNELS.wakeAudio, windowB, pcmFrame());
    expect(
      wakeEngineDeps.instances.filter((i) => i !== engineA),
    ).toHaveLength(1);
  });

  it("preserves wake owner without focused window and blocks steal", () => {
    voiceConfig.wakeWord.enabled = true;
    const windowA = new TestRenderer(791);
    const windowB = new TestRenderer(792);
    scopeDeps.scopes.set(windowA.id, scopeA);
    scopeDeps.scopes.set(windowB.id, scopeB);
    electronDeps.windows.push(
      { webContents: windowA },
      { webContents: windowB },
    );
    electronDeps.focusedWindow = { webContents: windowA };

    send(VOICE_CHANNELS.wakeAudio, windowA, pcmFrame());
    const engineA = wakeEngineDeps.instances[0]!;
    engineA.feed.mockClear();

    electronDeps.focusedWindow = null;
    send(VOICE_CHANNELS.wakeAudio, windowA, pcmFrame());
    expect(engineA.feed).toHaveBeenCalledTimes(1);

    send(VOICE_CHANNELS.wakeAudio, windowB, pcmFrame());
    expect(engineA.feed).toHaveBeenCalledTimes(1);
    expect(wakeEngineDeps.instances).toHaveLength(1);
  });

  it("disposes a failed WakeEngine and permits a fresh authorized background claim", async () => {
    voiceConfig.wakeWord.enabled = true;
    const windowA = new TestRenderer(801);
    scopeDeps.scopes.set(windowA.id, scopeA);
    electronDeps.windows.push({ webContents: windowA });
    electronDeps.focusedWindow = { webContents: windowA };
    wakeEngineDeps.failNextInit(new Error("wake model unavailable"));

    send(VOICE_CHANNELS.wakeAudio, windowA, pcmFrame());
    const failedEngine = wakeEngineDeps.instances[0]!;
    await vi.waitFor(() => {
      expect(failedEngine.dispose).toHaveBeenCalledTimes(1);
    });

    electronDeps.focusedWindow = null;
    send(VOICE_CHANNELS.wakeAudio, windowA, pcmFrame());
    expect(wakeEngineDeps.instances).toHaveLength(2);

    electronDeps.focusedWindow = { webContents: windowA };
    send(VOICE_CHANNELS.wakeAudio, windowA, pcmFrame());
    expect(wakeEngineDeps.instances).toHaveLength(2);
    expect(wakeEngineDeps.instances[1]!.feed).toHaveBeenCalledTimes(2);
  });
});

describe("F-1161 Clef-omni wake confirmation wired into voice-ipc", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const optIn = (on: boolean) => {
    decisionDeps.settings = on
      ? decisionSettingsSchema.parse({ mode: "clef", clefModel: "clef-omni",
          cloudflareAccountId: "0123456789abcdef0123456789abcdef",
          audioConsent: { version: 1, recipients: ["clef"] } })
      : null;
    // O settings-store faz isto a cada mudança de preferências de decisão.
    bumpDecisionCredentialRevision();
  };
  const reply = (noul: number) => async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({ success: true, result: { model: body.model, usage: { input_tokens: 400, output_tokens: 0 },
      answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul }])) } });
  };
  const hang = async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  });
  const armedOwner = (id: number) => {
    voiceConfig.wakeWord.enabled = true;
    const owner = new TestRenderer(id);
    scopeDeps.scopes.set(owner.id, scopeA);
    electronDeps.windows.push({ webContents: owner });
    electronDeps.focusedWindow = { webContents: owner };
    return owner;
  };
  const speak = (owner: TestRenderer, seconds: number) => {
    for (let index = 0; index < seconds * 12.5; index++) send(VOICE_CHANNELS.wakeAudio, owner, pcmFrame(1280));
  };
  const delivered = (owner: TestRenderer) => owner.send.mock.calls.some(([channel]) => channel === VOICE_CHANNELS.wakeDetected);

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    decisionDeps.clef = true;
    optIn(false);
  });

  it("drops a detection Clef-omni hears as confidently ambient", async () => {
    optIn(true);
    fetchMock.mockImplementation(reply(0.93));
    const owner = armedOwner(901);
    speak(owner, 3);
    wakeEngineDeps.lastOnDetected?.();
    expect(delivered(owner)).toBe(false);
    await vi.waitFor(() => expect(logVoice).toHaveBeenCalledWith("warn", "wake.clefAmbient", expect.any(String),
      expect.objectContaining({ verdict: "ambient", probability: 0.93 })));
    expect(delivered(owner)).toBe(false);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.model).toBe("clef-omni");
    expect(body.audio[0]).toMatch(/^data:audio\/wav;base64,UklGR/);
  });

  it.each([
    ["speech", reply(0.2)],
    ["an HTTP error", async () => Response.json({ success: false }, { status: 401 })],
  ])("waits for Clef-omni and then delivers the detection on %s", async (_label, implementation) => {
    optIn(true);
    fetchMock.mockImplementation(implementation as typeof fetch);
    const owner = armedOwner(902);
    speak(owner, 3);
    wakeEngineDeps.lastOnDetected?.();
    expect(delivered(owner)).toBe(false);
    await vi.waitFor(() => expect(delivered(owner)).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("delivers the detection when Clef-omni does not answer in time", async () => {
    optIn(true);
    fetchMock.mockImplementation(hang);
    const owner = armedOwner(903);
    speak(owner, 3);
    const started = performance.now();
    wakeEngineDeps.lastOnDetected?.();
    await vi.waitFor(() => expect(delivered(owner)).toBe(true), { timeout: 3_000 });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("without the audio opt-in delivers at once and never calls Clef", () => {
    const owner = armedOwner(904);
    speak(owner, 3);
    wakeEngineDeps.lastOnDetected?.();
    expect(delivered(owner)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turning the consent off aborts the confirmation in flight and the wake goes through", async () => {
    optIn(true);
    fetchMock.mockImplementation(hang);
    const owner = armedOwner(905);
    speak(owner, 3);
    wakeEngineDeps.lastOnDetected?.();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const started = performance.now();
    optIn(false);
    await vi.waitFor(() => expect(delivered(owner)).toBe(true), { timeout: 3_000 });
    expect(performance.now() - started).toBeLessThan(500);
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it("stopping the wake mic forgets the buffered audio", () => {
    optIn(true);
    fetchMock.mockImplementation(reply(0.2));
    const owner = armedOwner(907);
    speak(owner, 3);
    send(VOICE_CHANNELS.wakeStop, owner);
    // Rearmado com um único frame: não há clipe suficiente, entrega na hora sem Clef.
    send(VOICE_CHANNELS.wakeAudio, owner, pcmFrame(1280));
    wakeEngineDeps.lastOnDetected?.();
    expect(delivered(owner)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [0.9, "ambient"],
    [0.2, undefined],
  ])("passive-wake STT with noul %s is discarded as %s", async (noul, discarded) => {
    optIn(true);
    fetchMock.mockImplementation(reply(noul));
    vi.mocked(transcribe).mockResolvedValueOnce({ ok: true, text: "Jarvis, abre o terminal", provider: "openai",
      attempts: [] } as unknown as Awaited<ReturnType<typeof transcribe>>);
    const owner = armedOwner(906);
    const result = await invoke(VOICE_CHANNELS.transcribe, owner, { audioBase64: syntheticWav(1).toString("base64"),
      mime: "audio/wav", purpose: "passive-wake", passiveWakeWord: "Jarvis" }) as { ok: boolean; discarded?: string };
    expect(result.ok).toBe(true);
    expect(result.discarded).toBe(discarded);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// F-1202: a JARVIS executa comandos por voz com o Nexus muitas vezes fora de
// foco. No macOS um showMessageBox sem janela-mãe é NSAlert runModal e prende
// a main thread até o clique.
describe("confirmação de comando de alto impacto da JARVIS (F-1202)", () => {
  const command = "git push --force origin main";
  const sheetHost = (visible: boolean) => ({
    webContents: null,
    isDestroyed: () => false,
    isVisible: () => visible,
    isFocusable: () => true,
  });

  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });
  });
  afterEach(() => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });
    vi.restoreAllMocks();
  });

  it("vira sheet na janela do Nexus mesmo sem janela focada", async () => {
    const win = sheetHost(true);
    electronDeps.windows.push(win);
    const owner = new TestRenderer(950);

    await expect(invoke(VOICE_CHANNELS.confirmCommand, owner, command)).resolves.toBe(true);

    expect(vi.mocked(dialog.showMessageBox).mock.calls[0]?.[0]).toBe(win);
  });

  it("sem nenhuma janela nega na hora em vez de prender a main thread", async () => {
    const owner = new TestRenderer(951);

    await expect(invoke(VOICE_CHANNELS.confirmCommand, owner, command)).resolves.toBe(false);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });
});
