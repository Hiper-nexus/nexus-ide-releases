import { ipcMain, BrowserWindow, dialog } from 'electron';
import { VOICE_CHANNELS } from '../../shared/voice-channels';
import {
  transcribeRequestSchema,
  speakRequestSchema,
  setConfigRequestSchema,
  setVoiceKeyRequestSchema,
  jarvisRequestSchema,
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
import { WakeEngine } from './wake-engine';
import { transcribe } from './stt-service';
import { speak } from './tts-service';
import { echoSuppressor } from './echo-suppress';
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
  return { ...buildRuntimeInfo(), hotkeyArmed: isVoiceHotkeyArmed() };
}

export function registerVoiceIpc(): void {
  loadVoiceConfig();
  wireHotkey();
  // Narração proativa: handoff novo (entrega/travamento/falha) vira aviso de
  // voz — o renderer fala quando não houver turno ativo.
  initJarvisNarrator(broadcast);

  ipcMain.handle(VOICE_CHANNELS.getInfo, (): VoiceRuntimeInfo => fullInfo());

  ipcMain.handle(VOICE_CHANNELS.setConfig, (_event, raw): VoiceRuntimeInfo => {
    const parsed = setConfigRequestSchema.safeParse(raw);
    if (!parsed.success) return fullInfo();
    const before = getVoiceConfig().input.shortcut;
    const beforeKey = getVoiceConfig().input.pushToTalkKey?.code;
    applyConfigPatch(parsed.data);
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
        // Terceira camada anti-eco (após o AEC do mic e antes do filtro de
        // fantasmas do renderer): transcrição que é o próprio TTS recente
        // vazando do alto-falante volta marcada para descarte silencioso.
        if (res.ok && echoSuppressor.isEcho(res.text)) {
          console.log(`[voice] eco do TTS descartado: "${res.text.slice(0, 80)}"`);
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
  let wakeEngine: WakeEngine | null = null;
  let wakeFramesSeen = false;
  ipcMain.on(VOICE_CHANNELS.wakeAudio, (_event, raw: unknown) => {
    if (!getVoiceConfig().wakeWord.enabled) return;
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
      console.log(`[wake] recebendo áudio do renderer (${frame.length} amostras/frame)`);
    }
    if (!wakeEngine) {
      wakeEngine = new WakeEngine(() => broadcast(VOICE_CHANNELS.wakeDetected));
      void wakeEngine
        .init()
        .then(() => console.log('[wake] engine openWakeWord pronto ("Hey Jarvis")'))
        .catch((err) => {
          console.warn('[wake] engine init failed:', err);
          wakeEngine = null;
        });
      return; // primeiro lote só inicializa; frames seguintes alimentam
    }
    wakeEngine.feed(frame);
  });

  ipcMain.handle(VOICE_CHANNELS.jarvis, async (_event, raw): Promise<JarvisReply> => {
    const parsed = jarvisRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { say: 'Não entendi o pedido.', action: { type: 'none' } };
    }
    try {
      const reply = await jarvisThink(
        parsed.data.transcript,
        parsed.data.context,
        parsed.data.history,
      );
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
}

export function closeVoiceIpc(): void {
  disposeVoiceHotkey();
  shutdownJarvisNarrator();
}
