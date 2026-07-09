import { ipcMain, BrowserWindow, dialog, app } from 'electron';
import { VOICE_CHANNELS } from '../../shared/voice-channels';
import {
  transcribeRequestSchema,
  speakRequestSchema,
  setConfigRequestSchema,
  setVoiceKeyRequestSchema,
  jarvisRequestSchema,
  jarvisLiveInterruptRequestSchema,
  jarvisLiveSayRequestSchema,
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
} from '../../shared/voice-ipc';
import {
  loadVoiceConfig,
  getVoiceConfig,
  applyConfigPatch,
  buildRuntimeInfo,
  currentProbes,
  setHotkeyMode,
  storeVoiceApiKey,
} from './voice-config-store';
import { jarvisThink } from './jarvis-brain';
import { jarvisConversation } from './jarvis-conversation';
import { WakeEngine } from './wake-engine';
import { logVoice } from './voice-log';
import { spawn } from 'node:child_process';
import { transcribe } from './stt-service';
import { speak, stopSystemSpeech } from './tts-service';
import { echoSuppressor } from './echo-suppress';
import {
  appBundlePathFromExecPath,
  readBundleId,
  resetMicrophoneTcc,
} from './mic-tcc';
import {
  acquireWakeLock,
  releaseWakeLock,
  wakeLockHolder,
} from './wake-lock';
import { JarvisLiveSession } from './jarvis-live';
import {
  LiveTransportController,
  type PendingQuestionSource,
} from './live-transport-controller';
import { listHandoffs } from '../orch/handoff-store';
import { jarvisLatencyTracker } from '../jarvis/realtime/metrics';
import { transcriptStore } from '../jarvis/transcript-store';
import {
  registerVoiceHotkey,
  disposeVoiceHotkey,
  isVoiceHotkeyArmed,
} from './voice-hotkey';
import { initJarvisNarrator, shutdownJarvisNarrator } from './jarvis-narrator';

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

const liveSession = new JarvisLiveSession(broadcast, Date.now, (sessionId, line) => {
  jarvisLatencyTracker.markTranscript(sessionId, line.final);
  const record = transcriptStore.append(sessionId, {
    role: line.role,
    text: line.text,
    final: line.final,
    audio_url: null,
  });
  if (!record) return;
  broadcast(VOICE_CHANNELS.jarvisTranscriptAppend, {
    sessionId,
    ...record,
  });
});
// C-085 r3 (upstream QUESTION_POLL): um handoff `blocked` = uma pane delegada
// travada precisando do usuário — i.e. uma pergunta narrada pendente. O poll do
// controller registra cada uma para que a PRÓXIMA fala final do usuário seja
// roteada de volta à pane (send_to_pane, modelo bypassado), sem re-wake.
const pendingQuestionSource: PendingQuestionSource = {
  poll: () =>
    listHandoffs({ includeDelivered: false })
      .filter((handoff) => handoff.status === 'blocked')
      .map((handoff) => ({
        paneId: handoff.sessionId ?? handoff.id,
        questionHash: handoff.summary,
      })),
};
const liveTransport = new LiveTransportController(
  broadcast,
  liveSession,
  Date.now,
  pendingQuestionSource,
);

// Módulo-level para o closeVoiceIpc() poder liberar as sessões ONNX no quit.
let wakeEngine: WakeEngine | null = null;

function wireHotkey(): void {
  const config = getVoiceConfig();
  const mainKeyCode = config.input.pushToTalkKey?.code ?? 'Space';
  const mode = registerVoiceHotkey(config.input.shortcut, mainKeyCode, {
    onStart: () => broadcast(VOICE_CHANNELS.pttStart),
    onStop: () => broadcast(VOICE_CHANNELS.pttStop),
    onToggle: () => broadcast(VOICE_CHANNELS.pttToggle),
  });
  setHotkeyMode(mode);
}

/** Runtime snapshot + whether the OS actually accepted the accelerator. */
function fullInfo(): VoiceRuntimeInfo {
  return {
    ...buildRuntimeInfo(),
    hotkeyArmed: isVoiceHotkeyArmed(),
    wakeLockHolderPid: wakeLockHolder(),
  };
}

export function registerVoiceIpc(): void {
  // Atribuição de "duas vozes": identifica ESTA instância no voice.log para
  // distinguir colisão interna de colisão cross-app (sidecar do Overclock).
  logVoice('info', 'voice.instanceBoot', 'instância de voz iniciada', {
    pid: process.pid,
    execPath: process.execPath,
    version: app.getVersion(),
  });
  loadVoiceConfig();
  wireHotkey();
  const restartMarker = process.env.NEXUS_VOICE_RESTART_MARKER?.trim() || 'APP_RESTART';
  logVoice('info', 'voice.restart', `=== ${restartMarker} ${new Date().toISOString()} ===`);
  // Narração proativa: handoff novo (entrega/travamento/falha) vira aviso de
  // voz — o renderer fala quando não houver turno ativo.
  initJarvisNarrator(broadcast);
  liveSession.setEnabled(getVoiceConfig().jarvisLive.enabled);

  ipcMain.handle(VOICE_CHANNELS.getInfo, (): VoiceRuntimeInfo => fullInfo());

  ipcMain.handle(VOICE_CHANNELS.setConfig, (_event, raw): VoiceRuntimeInfo => {
    const parsed = setConfigRequestSchema.safeParse(raw);
    if (!parsed.success) return fullInfo();
    const before = getVoiceConfig().input.shortcut;
    const beforeKey = getVoiceConfig().input.pushToTalkKey?.code;
    applyConfigPatch(parsed.data);
    liveSession.setEnabled(getVoiceConfig().jarvisLive.enabled);
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

  ipcMain.handle(VOICE_CHANNELS.setKey, (_event, raw): { ok: boolean; error?: string } => {
    const parsed = setVoiceKeyRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid key request' };
    const result = storeVoiceApiKey(parsed.data.envVar, parsed.data.key);
    const info = fullInfo();
    broadcast(VOICE_CHANNELS.infoChanged, info);
    return result;
  });

  ipcMain.handle(
    VOICE_CHANNELS.transcribe,
    async (_event, raw): Promise<TranscribeResult> => {
      const parsed = transcribeRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, needsKey: false, error: 'invalid transcribe request', attempts: [] };
      }
      try {
        const res = await transcribe(parsed.data, getVoiceConfig(), currentProbes());
        // ITEM 7: a wake-path STT stall (cloud skipped to local por orçamento)
        // nunca é silenciosa — o motivo/attempts entram no voice.log.
        if (res.stalled) {
          logVoice('warn', 'stt.stall', 'wake STT estourou o orçamento; pulou p/ local', {
            budgetMs: parsed.data.budgetMs,
            ok: res.ok,
            provider: res.ok ? res.provider : null,
            attempts: res.attempts.map((a) => `${a.provider}: ${a.reason}`),
          });
        }
        // Terceira camada anti-eco (após o AEC do mic e antes do filtro de
        // fantasmas do renderer): transcrição que é o próprio TTS recente
        // vazando do alto-falante volta marcada para descarte silencioso.
        if (res.ok && echoSuppressor.isEcho(res.text)) {
          logVoice('info', 'stt.echoDiscarded', 'eco do TTS descartado', {
            text: res.text.slice(0, 120),
          });
          return { ...res, discarded: 'echo' };
        }
        return res;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, needsKey: false, error: message, attempts: [] };
      }
    },
  );

  // Wake word "Hey Jarvis" (openWakeWord/onnx, sem conta): o renderer faz
  // stream dos frames PCM; a detecção volta como broadcast.
  let wakeFramesSeen = false;
  let wakeLockWarned = false;
  ipcMain.on(VOICE_CHANNELS.wakeAudio, (_event, raw: unknown) => {
    if (!getVoiceConfig().wakeWord.enabled) return;
    // Mutex entre instâncias (dev + empacotado abertos juntos): só a dona do
    // lock processa wake — senão as DUAS respondem ao mesmo "Hey Jarvis".
    if (!acquireWakeLock()) {
      if (!wakeLockWarned) {
        wakeLockWarned = true;
        logVoice(
          'warn',
          'wake.lockContention',
          'outra instância do NexusIDE detém o wake — frames ignorados aqui',
          { holderPid: wakeLockHolder() },
        );
        broadcast(VOICE_CHANNELS.infoChanged, fullInfo());
      }
      return;
    }
    if (wakeLockWarned) {
      wakeLockWarned = false;
      broadcast(VOICE_CHANNELS.infoChanged, fullInfo());
    }
    // Electron entrega o ArrayBuffer do renderer como Buffer/TypedArray —
    // normalize os três formatos (respeitando byteOffset/length!).
    let frame: Float32Array | null = null;
    if (raw instanceof ArrayBuffer) {
      frame = new Float32Array(raw);
    } else if (ArrayBuffer.isView(raw)) {
      const v = raw as ArrayBufferView;
      frame = new Float32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    }
    if (!frame || frame.length === 0 || frame.length > 16_384) return;
    if (!wakeFramesSeen) {
      wakeFramesSeen = true;
      logVoice('info', 'wake.framesStart', 'recebendo áudio do renderer', {
        frameSamples: frame.length,
      });
    }
    if (!wakeEngine) {
      wakeEngine = new WakeEngine(() => {
        logVoice('info', 'wake.detected', '"Hey Jarvis"');
        broadcast(VOICE_CHANNELS.wakeDetected);
      });
      void wakeEngine
        .init()
        .then(() => logVoice('info', 'wake.engineReady', 'openWakeWord pronto'))
        .catch((err) => {
          const m = err instanceof Error ? err.message : String(err);
          logVoice('error', 'wake.engineInitFail', m);
          wakeEngine = null;
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
      logVoice(parsed.data.level, parsed.data.event, parsed.data.msg, parsed.data.data);
    }
  });

  // Deep-links pra Ajustes do macOS: o renderer pede quando a JARVIS detecta
  // que tá sem permissão de mic (Privacy → Microfone) ou com input mudo (Som).
  ipcMain.on(VOICE_CHANNELS.openMicSettings, () => {
    spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone']);
    logVoice('info', 'mic.openMicSettings', 'abriu Ajustes → Microfone');
  });
  ipcMain.on(VOICE_CHANNELS.openSoundSettings, () => {
    spawn('open', ['x-apple.systempreferences:com.apple.preference.sound']);
    logVoice('info', 'mic.openSoundSettings', 'abriu Ajustes → Som');
  });

  // Grant TCC fantasma (WAKE-BROKEN-001 Rank 1): macOS diz 'granted' mas
  // entrega PCM zerado. Reset guiado com confirmação nativa + relaunch.
  ipcMain.handle(
    VOICE_CHANNELS.micResetTcc,
    async (): Promise<{ ok: boolean; error?: string }> => {
      if (process.platform !== 'darwin') return { ok: false, error: 'só macOS' };
      const appPath = appBundlePathFromExecPath(process.execPath);
      const bundleId = appPath ? await readBundleId(appPath) : null;
      if (!bundleId) {
        return {
          ok: false,
          error: 'bundle id não resolvido — rode: tccutil reset Microphone <seu-bundle-id>',
        };
      }
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Resetar e reiniciar', 'Cancelar'],
        defaultId: 0,
        cancelId: 1,
        message: 'Resetar a permissão de microfone?',
        detail: `Vou rodar "tccutil reset Microphone ${bundleId}" e reiniciar o app. Na volta, clique Permitir quando o macOS pedir o microfone.`,
      });
      if (response !== 0) return { ok: false, error: 'cancelado' };
      try {
        await resetMicrophoneTcc(bundleId);
      } catch (err) {
        logVoice('warn', 'mic.tccResetFailed', 'tccutil falhou', { error: String(err) });
        return { ok: false, error: `tccutil falhou: ${String(err)}` };
      }
      logVoice('warn', 'mic.tccReset', 'TCC Microphone resetado — relançando', { bundleId });
      app.relaunch();
      app.exit(0);
      return { ok: true };
    },
  );

  ipcMain.handle(VOICE_CHANNELS.jarvis, async (_event, raw): Promise<JarvisReply> => {
    const parsed = jarvisRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { say: 'Não entendi o pedido.', action: { type: 'none' } };
    }
    try {
      // Gap 9: se o renderer perdeu o histórico (morte/reinício da sessão),
      // reinjeta a conversa persistida em disco dentro da janela de resume, para
      // a JARVIS retomar o fio em vez de recomeçar e re-perguntar o que já sabia.
      const history =
        parsed.data.history.length > 0
          ? parsed.data.history
          : jarvisConversation.resume();
      const reply = await jarvisThink(
        parsed.data.transcript,
        parsed.data.context,
        history,
      );
      jarvisConversation.record(parsed.data.transcript, reply.say);
      liveSession.onJarvisReply(parsed.data.transcript, reply);
      console.log(
        `[voice] jarvis: "${parsed.data.transcript}" → ${reply.action.type}` +
          ` | say="${reply.say.slice(0, 80)}"`,
      );
      return reply;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { say: `Deu erro ao pensar: ${message}`, action: { type: 'none' } };
    }
  });

  ipcMain.handle(VOICE_CHANNELS.speak, async (_event, raw): Promise<SpeakResult> => {
    const parsed = speakRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid speak request' };
    try {
      return await speak(parsed.data, getVoiceConfig(), currentProbes());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle(VOICE_CHANNELS.recordEcho, (_event, raw: unknown) => {
    const text = typeof (raw as { text?: unknown })?.text === 'string' ? (raw as { text: string }).text : '';
    if (text.trim()) echoSuppressor.record(text);
    return { ok: true as const };
  });

  // Barge-in do fallback `say` (mode 'played' toca no main — o renderer não
  // tem como calar sem isto).
  ipcMain.handle(VOICE_CHANNELS.speakStop, () => {
    stopSystemSpeech();
  });

  // SEC#6: a shell command produced by the (LLM) Jarvis brain must never run
  // without an explicit, un-spoofable human OK. A poisoned transcript /
  // prompt-injection can emit run_command; this native dialog — which the
  // renderer cannot fake — shows the exact command and defaults to Cancel.
  ipcMain.handle(
    VOICE_CHANNELS.confirmCommand,
    async (_event, raw): Promise<boolean> => {
      if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 4096) {
        return false;
      }
      const opts = {
        type: 'warning' as const,
        buttons: ['Cancelar', 'Executar'],
        defaultId: 0,
        cancelId: 0,
        title: 'Rodar comando por voz?',
        message: 'A JARVIS quer executar este comando no terminal:',
        detail: `${raw}\n\nExecute apenas se você reconhece este comando.`,
        noLink: true,
      };
      const win = BrowserWindow.getFocusedWindow();
      const result = win
        ? await dialog.showMessageBox(win, opts)
        : await dialog.showMessageBox(opts);
      return result.response === 1;
    },
  );

  ipcMain.handle(VOICE_CHANNELS.liveStart, async (_event, raw) => {
    const parsed = jarvisLiveStartRequestSchema.safeParse(raw ?? {});
    const req = parsed.success ? parsed.data : {};
    let state = liveSession.start(req);
    // Se a config pede transporte realtime, conecta o socket antes do mic;
    // senão isto é no-op e o Classic segue (fallback keyless).
    if (liveSession.getState().sessionId) {
      await liveTransport.onStart({ forceFresh: req.forceFresh });
      state = liveSession.getState();
    }
    return state;
  });

  ipcMain.handle(VOICE_CHANNELS.liveStop, () => {
    liveTransport.onStop();
    return liveSession.stop();
  });
  ipcMain.handle(VOICE_CHANNELS.liveHardRebuild, async () => {
    logVoice('warn', 'live.hardRebuild', 'destruindo socket zumbi + nova conexão');
    liveTransport.hardStop();
    liveSession.start({ reason: 'manual' });
    await liveTransport.onStart();
    return liveSession.getState();
  });
  ipcMain.handle(VOICE_CHANNELS.liveHardTeardown, () => {
    logVoice('warn', 'live.hardTeardown', 'destruindo socket — sem reconexão');
    liveTransport.hardStop();
    liveSession.stop();
    return liveSession.getState();
  });
  ipcMain.handle(VOICE_CHANNELS.liveEndTurn, () => {
    liveTransport.endTurn();
    return liveSession.endTurn();
  });
  ipcMain.handle(VOICE_CHANNELS.liveSmokeTest, async (_event, raw) => {
    const parsed = jarvisLiveSmokeTestRequestSchema.safeParse(raw);
    if (!parsed.success) return liveSession.getState();
    return liveTransport.smokeTest(parsed.data.text);
  });
  ipcMain.handle(VOICE_CHANNELS.liveSay, async (_event, raw) => {
    const parsed = jarvisLiveSayRequestSchema.safeParse(raw);
    if (!parsed.success) return liveSession.getState();
    return liveTransport.say(parsed.data.text);
  });

  // Mic PCM 16 kHz base64 do renderer → transporte realtime (no-op no Classic).
  ipcMain.on(VOICE_CHANNELS.liveMicIn, (_event, raw: unknown) => {
    if (typeof raw === 'string' && raw.length > 0 && raw.length <= 256 * 1024) {
      liveTransport.micIn(raw);
    }
  });
  ipcMain.on(VOICE_CHANNELS.liveContextIn, (_event, raw: unknown) => {
    if (typeof raw === 'string' && raw.trim()) liveTransport.contextIn(raw);
  });

  ipcMain.handle(VOICE_CHANNELS.liveStatus, (_event, raw) => {
    const parsed = jarvisLiveStatusPatchSchema.safeParse(raw);
    if (!parsed.success) return liveSession.getState();
    return liveSession.patchStatus(parsed.data);
  });

  ipcMain.on(VOICE_CHANNELS.liveTranscriptIn, (_event, raw) => {
    const parsed = jarvisLiveTranscriptInputSchema.safeParse(raw);
    if (!parsed.success) return;
    liveSession.transcript(parsed.data);
  });

  ipcMain.on(VOICE_CHANNELS.liveToolResultIn, (_event, raw) => {
    const parsed = jarvisLiveToolResultInputSchema.safeParse(raw);
    if (!parsed.success) return;
    const event = liveSession.toolResult(parsed.data);
    if (event) {
      jarvisLatencyTracker.markAction(event.sessionId);
      liveTransport.toolResult(event);
    }
  });

  ipcMain.handle(VOICE_CHANNELS.liveInterrupt, (_event, raw) => {
    const parsed = jarvisLiveInterruptRequestSchema.safeParse(raw ?? {});
    return liveTransport.interrupt(
      parsed.success ? parsed.data.reason : 'interrupted',
    );
  });
}

export function closeVoiceIpc(): void {
  disposeVoiceHotkey();
  shutdownJarvisNarrator();
  stopSystemSpeech();
  // P4: hard teardown on quit — never leave a grace socket dangling.
  liveTransport.hardStop();
  liveSession.stop();
  // Sessões ONNX do wake são memória nativa — sem release explícito vazam
  // em quit/restart.
  void wakeEngine?.dispose();
  wakeEngine = null;
  releaseWakeLock();
}
