import { playAudioBase64 } from './voice-playback';
import type { VoiceRuntimeInfo } from '../../shared/voice-ipc';

const BASE_WAKE_ACKS = ['Pois não?', 'Sim?', 'Às ordens.', 'Diga.'];
export const THINK_FILLERS = ['Deixa comigo.', 'Um instante.', 'Certo.', 'Já vejo.'];
const SPEAK_DEADLINE_MS = 40_000;
const WAKE_ACK_TAIL_GUARD_MS = 180;

const ackCache = new Map<string, { audioBase64: string; format: string }>();
const warmedAckTexts = new Set<string>();
let lastPersonaKey = '';

function personaKey(info: VoiceRuntimeInfo | null | undefined): string {
  if (!info) return '';
  const p = info.persona;
  return `${p.assistantName}|${p.userName ?? ''}|${p.customInstructions ?? ''}`;
}

export function buildWakeAckTexts(userName: string): string[] {
  const user = userName.trim();
  if (!user) return BASE_WAKE_ACKS;
  return [`Pois não, ${user}?`, `Sim, ${user}?`, `Diga, ${user}.`, 'Estou ouvindo.'];
}

/** Saudação do wake SEMPRE com o nome — o contexto de tela vai pro cérebro, não pro TTS. */
export function wakeGreetingText(userName: string): string {
  return buildWakeAckTexts(userName)[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} demorou demais (${Math.round(ms / 1000)}s)`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function invalidateAckCacheIfPersonaChanged(info: VoiceRuntimeInfo): void {
  const key = personaKey(info);
  if (key === lastPersonaKey) return;
  lastPersonaKey = key;
  ackCache.clear();
  warmedAckTexts.clear();
}

export function warmAckCache(userName: string): void {
  for (const text of [...buildWakeAckTexts(userName), ...THINK_FILLERS]) {
    if (warmedAckTexts.has(text)) continue;
    warmedAckTexts.add(text);
    void window.nexus.voice
      .speak({ text, speakMode: 'full', echoRecord: false })
      .then((r) => {
        if (r.ok && r.mode === 'audio') {
          ackCache.set(text, { audioBase64: r.audioBase64, format: r.format });
        }
      })
      .catch(() => {
        warmedAckTexts.delete(text);
      });
  }
}

export async function playWakePrompt(text: string): Promise<void> {
  if (!text.trim()) return;
  const cached = ackCache.get(text);
  if (!cached) {
    const result = await withTimeout(
      window.nexus.voice.speak({ text, speakMode: 'full', echoRecord: false }),
      SPEAK_DEADLINE_MS,
      'TTS do ack',
    );
    if (result.ok && result.mode === 'audio') {
      ackCache.set(text, { audioBase64: result.audioBase64, format: result.format });
      await playAudioBase64(result.audioBase64, result.format);
    }
    await sleep(WAKE_ACK_TAIL_GUARD_MS);
    return;
  }
  await playAudioBase64(cached.audioBase64, cached.format);
  await sleep(WAKE_ACK_TAIL_GUARD_MS);
}

export async function playCachedWakeAck(userName: string): Promise<void> {
  const cached = ackCache.get(wakeGreetingText(userName));
  if (!cached) return;
  await playAudioBase64(cached.audioBase64, cached.format);
  await sleep(WAKE_ACK_TAIL_GUARD_MS);
}

export function getThinkFillerCache(): Map<string, { audioBase64: string; format: string }> {
  return ackCache;
}
