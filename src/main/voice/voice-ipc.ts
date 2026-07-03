import { ipcMain, BrowserWindow } from 'electron';
import { VOICE_CHANNELS } from '../../shared/voice-channels';
import {
  transcribeRequestSchema,
  speakRequestSchema,
  setConfigRequestSchema,
  type VoiceRuntimeInfo,
  type TranscribeResult,
  type SpeakResult,
} from '../../shared/voice-ipc';
import {
  loadVoiceConfig,
  getVoiceConfig,
  applyConfigPatch,
  buildRuntimeInfo,
  currentProbes,
  setHotkeyMode,
} from './voice-config-store';
import { transcribe } from './stt-service';
import { speak } from './tts-service';
import { registerVoiceHotkey, disposeVoiceHotkey } from './voice-hotkey';

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
  });
  setHotkeyMode(mode);
}

export function registerVoiceIpc(): void {
  loadVoiceConfig();
  wireHotkey();

  ipcMain.handle(VOICE_CHANNELS.getInfo, (): VoiceRuntimeInfo => buildRuntimeInfo());

  ipcMain.handle(VOICE_CHANNELS.setConfig, (_event, raw): VoiceRuntimeInfo => {
    const parsed = setConfigRequestSchema.safeParse(raw);
    if (!parsed.success) return buildRuntimeInfo();
    const before = getVoiceConfig().input.shortcut;
    applyConfigPatch(parsed.data);
    // Re-register the accelerator only if it actually changed.
    if (getVoiceConfig().input.shortcut !== before) wireHotkey();
    const info = buildRuntimeInfo();
    broadcast(VOICE_CHANNELS.infoChanged, info);
    return info;
  });

  ipcMain.handle(
    VOICE_CHANNELS.transcribe,
    async (_event, raw): Promise<TranscribeResult> => {
      const parsed = transcribeRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, needsKey: false, error: 'invalid transcribe request', attempts: [] };
      }
      try {
        return await transcribe(parsed.data, getVoiceConfig(), currentProbes());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, needsKey: false, error: message, attempts: [] };
      }
    },
  );

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
}

export function closeVoiceIpc(): void {
  disposeVoiceHotkey();
}
