import path from 'node:path';
import { app } from 'electron';
import { z } from 'zod';
import {
  VOICE_CLONE_CHANNELS,
  type VoiceCloneCreateResult,
  type VoiceCloneReceiptView,
  type VoiceCloneRemoveResult,
  type VoiceCloneSessionView,
  type VoiceDeclarationResult,
} from '../../shared/voice-clone-types';
import { handleTrusted } from '../security/trusted-ipc';
import { assertVideoStudioEnabled } from '../video/video-studio-flag';
import { resolveMediaKey } from './media-keys';
import {
  beginVoiceClone,
  cancelVoiceClone,
  createVoiceClone,
  removeVoiceClone,
  verifyVoiceDeclaration,
  type VoiceCloneDeps,
} from './voice-clone';
import { receiptView, VoiceConsentStore } from './voice-consents';
import { setNexusClonedVoiceLookup } from './voice-origin';

/**
 * Trusted IPC of "Minha voz" (F-1593). `handleTrusted` admits only the main
 * window's main frame: no browser tab, subframe, auxiliary window — and no
 * MCP tool — can create or delete a voice. Payloads are size-capped audio;
 * nothing of them is logged.
 */

const DECLARATION_MAX_BYTES = 8 * 1024 * 1024;
const SAMPLE_MAX_BYTES = 24 * 1024 * 1024;
const SAMPLES_MAX_TOTAL_BYTES = 48 * 1024 * 1024;

const bytes = (max: number) =>
  z.custom<Uint8Array>(
    (value) => value instanceof Uint8Array && value.byteLength > 44 && value.byteLength <= max,
    { message: 'áudio ausente ou grande demais' },
  );

const sessionId = z.string().regex(/^[a-f0-9]{32}$/u);

const verifySchema = z.object({
  sessionId,
  speakerName: z.string().min(1).max(120),
  wav: bytes(DECLARATION_MAX_BYTES),
});

const createSchema = z.object({
  sessionId,
  voiceName: z.string().min(1).max(120),
  samples: z
    .array(bytes(SAMPLE_MAX_BYTES))
    .min(1)
    .max(5)
    .refine((list) => list.reduce((total, item) => total + item.byteLength, 0) <= SAMPLES_MAX_TOTAL_BYTES),
  /** Gemini (F-1601): the official consent sentence, recorded now. */
  consentWav: bytes(DECLARATION_MAX_BYTES).optional(),
});

const beginSchema = z.object({ provider: z.enum(['elevenlabs', 'gemini']).optional() }).strict();

const removeSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/u),
  localOnly: z.boolean().optional(),
});

export function registerVoiceCloneIpc(): void {
  const mediaRoot = path.join(app.getPath('userData'), 'media');
  const store = new VoiceConsentStore(mediaRoot);
  setNexusClonedVoiceLookup((voiceId) => store.hasVoice(voiceId));
  const deps = (): VoiceCloneDeps => ({
    fetchFn: fetch,
    getKey: (def) => resolveMediaKey(def),
    store,
    voiceoverCacheDir: path.join(mediaRoot, 'voiceover-cache'),
    now: Date.now,
    appVersion: app.getVersion(),
  });

  handleTrusted(VOICE_CLONE_CHANNELS.list, (): VoiceCloneReceiptView[] =>
    store.list().map(receiptView),
  );

  // Criar voz só com o estúdio ligado; listar, cancelar e apagar ficam sempre
  // disponíveis: a pessoa apaga a própria voz mesmo com a chave desligada.
  handleTrusted(VOICE_CLONE_CHANNELS.begin, (_event, raw): VoiceCloneSessionView => {
    assertVideoStudioEnabled();
    const parsed = beginSchema.safeParse(raw ?? {});
    return beginVoiceClone(deps(), parsed.success ? (parsed.data.provider ?? 'elevenlabs') : 'elevenlabs');
  });

  handleTrusted(VOICE_CLONE_CHANNELS.verifyDeclaration, async (_event, raw): Promise<VoiceDeclarationResult> => {
    assertVideoStudioEnabled();
    const parsed = verifySchema.safeParse(raw);
    if (!parsed.success) return { ok: false, missing: [], error: 'Gravação inválida ou grande demais.' };
    return verifyVoiceDeclaration(parsed.data, deps());
  });

  handleTrusted(VOICE_CLONE_CHANNELS.create, async (_event, raw): Promise<VoiceCloneCreateResult> => {
    assertVideoStudioEnabled();
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'Gravações inválidas ou grandes demais.' };
    return createVoiceClone(parsed.data, deps());
  });

  handleTrusted(VOICE_CLONE_CHANNELS.cancel, (_event, raw): { ok: true } => {
    const parsed = z.object({ sessionId }).safeParse(raw);
    if (parsed.success) cancelVoiceClone(parsed.data.sessionId);
    return { ok: true };
  });

  handleTrusted(VOICE_CLONE_CHANNELS.remove, async (_event, raw): Promise<VoiceCloneRemoveResult> => {
    const parsed = removeSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'Pedido inválido.', canRemoveLocally: false };
    return removeVoiceClone(parsed.data, deps());
  });
}
