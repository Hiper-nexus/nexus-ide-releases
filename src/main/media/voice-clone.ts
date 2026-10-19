import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  VOICE_CONSENT_VERSION,
  VOICE_DECLARATION_MAX_SEC,
  VOICE_DECLARATION_MIN_SEC,
  VOICE_READING_TEXT,
  VOICE_SAMPLE_MAX_SEC,
  VOICE_SAMPLE_MIN_SEC,
  voiceDeclarationText,
  type VoiceCloneCreateResult,
  type VoiceCloneRemoveResult,
  type VoiceCloneSessionView,
  type VoiceDeclarationMissing,
  type VoiceDeclarationResult,
} from '../../shared/voice-clone-types';
import { findMediaProvider, type MediaProviderDef } from './media-providers';
import { ELEVENLABS_API } from './elevenlabs-voices';
import { readWavInfo } from './wav-info';
import {
  newReceiptId,
  receiptView,
  type VoiceConsentReceipt,
  type VoiceConsentStore,
} from './voice-consents';
import { purgeVoiceoverCacheForVoice } from './voiceover';

/**
 * "Minha voz" (F-1593): instant voice cloning of the operator's own voice.
 *
 * Reachable only from the trusted IPC (voice-clone-ipc.ts). The flow follows
 * the Microsoft AI Code of Conduct pattern the study adopted (§2.5): a fresh
 * live recording, a declaration with the person's name, adulthood, the
 * authorization and a random code generated now, checked by STT in Main
 * before anything is created; a local receipt; deletion at the provider and
 * on disk with one click. Transcripts, names and codes never reach a log.
 */

const SESSION_TTL_MS = 30 * 60_000;
const STT_MODEL = 'scribe_v2';
const MAX_SESSIONS = 4;

export interface VoiceCloneDeps {
  fetchFn: typeof fetch;
  getKey(def: MediaProviderDef): string | undefined;
  store: VoiceConsentStore;
  /** Main-owned narration cache: chunks of a deleted voice go with it. */
  voiceoverCacheDir: string | null;
  now(): number;
  appVersion: string;
  /** Six digits; injectable for tests. */
  randomCode?(): string;
}

interface Session {
  readonly id: string;
  readonly code: string;
  readonly expiresAt: number;
  declaration?: {
    readonly wav: Uint8Array;
    readonly sha256: string;
    readonly speakerName: string;
    readonly text: string;
    readonly heard: readonly VoiceDeclarationMissing[];
  };
}

const sessions = new Map<string, Session>();

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sweep(now: number): void {
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
}

/** Test seam: sessions live in Main memory only. */
export function resetVoiceCloneSessionsForTests(): void {
  sessions.clear();
}

// ── Declaration matching (pure) ─────────────────────────────────────────────

const NUMBER_WORDS: Record<string, string> = {
  zero: '0',
  um: '1',
  uma: '1',
  dois: '2',
  duas: '2',
  tres: '3',
  quatro: '4',
  cinco: '5',
  seis: '6',
  meia: '6',
  sete: '7',
  oito: '8',
  nove: '9',
  dezoito: '18',
};

export function normalizeSpeech(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
}

/** Damerau-free Levenshtein, enough for "Thiago"/"Tiago" and STT slips. */
function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function heardWord(tokens: readonly string[], expected: string): boolean {
  const tolerance = expected.length >= 6 ? 2 : expected.length >= 4 ? 1 : 0;
  return tokens.some((token) => editDistance(token, expected) <= tolerance);
}

/**
 * Which parts of the declaration the transcript is missing. The code is read
 * digit by digit; digits written as words or numerals both count, other
 * numbers around it ("18") do not break the match.
 */
export function missingFromDeclaration(
  transcript: string,
  speakerName: string,
  code: string,
): VoiceDeclarationMissing[] {
  const tokens = normalizeSpeech(transcript);
  const missing: VoiceDeclarationMissing[] = [];

  const nameTokens = normalizeSpeech(speakerName).filter((token) => token.length >= 2);
  const nameHits = nameTokens.filter((token) => heardWord(tokens, token)).length;
  if (nameTokens.length === 0 || !heardWord(tokens, nameTokens[0]) || nameHits * 2 < nameTokens.length) {
    missing.push('nome');
  }

  const joined = ` ${tokens.join(' ')} `;
  const adult =
    / maior (de )?(18|dezoito)/u.test(joined) || / (18|dezoito) anos /u.test(joined);
  if (!adult) missing.push('idade');

  if (!tokens.some((token) => token.startsWith('autoriz'))) missing.push('autorização');

  const digits = tokens
    .map((token) => (/^\d+$/u.test(token) ? token : NUMBER_WORDS[token] ?? ''))
    .join('');
  if (!digits.includes(code)) missing.push('código');
  return missing;
}

// ── Provider calls ──────────────────────────────────────────────────────────

function requireKey(deps: VoiceCloneDeps): string {
  const def = findMediaProvider('elevenlabs');
  const key = def ? deps.getKey(def) : undefined;
  if (!key) throw new Error('Conecte a ElevenLabs em Serviços de mídia antes de criar a sua voz.');
  return key;
}

async function failure(res: Response, what: string): Promise<string> {
  let message = '';
  try {
    const body = (await res.json()) as { detail?: unknown };
    const detail = body.detail;
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const raw = (detail as { message?: unknown }).message;
      if (typeof raw === 'string') message = raw.replace(/[\u0000-\u001f]+/gu, ' ').slice(0, 200);
    }
  } catch {
    // corpo ilegível
  }
  if (res.status === 401) return 'A ElevenLabs recusou a chave. Confira a chave em Serviços de mídia.';
  if (res.status === 402 || /subscription|plan|tier/iu.test(message)) {
    return `A ElevenLabs não deixou ${what}: clonar voz exige plano pago (Starter ou acima).`;
  }
  return `A ElevenLabs recusou ${what} (HTTP ${res.status})${message ? `: ${message}` : ''}.`;
}

function wavBlob(bytes: Uint8Array): Blob {
  // Copy into a plain ArrayBuffer: Blob rejects views over SharedArrayBuffer.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: 'audio/wav' });
}

async function transcribe(deps: VoiceCloneDeps, key: string, wav: Uint8Array): Promise<string> {
  const form = new FormData();
  form.set('model_id', STT_MODEL);
  form.set('language_code', 'pt');
  form.set('tag_audio_events', 'false');
  form.set('file', wavBlob(wav), 'declaracao.wav');
  const res = await deps.fetchFn(new URL('/v1/speech-to-text', ELEVENLABS_API), {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: form,
  });
  if (!res.ok) throw new Error(await failure(res, 'a transcrição da declaração'));
  const body = (await res.json()) as { text?: unknown };
  return typeof body.text === 'string' ? body.text : '';
}

// ── Flow ────────────────────────────────────────────────────────────────────

export function beginVoiceClone(deps: Pick<VoiceCloneDeps, 'now' | 'randomCode'>): VoiceCloneSessionView {
  const now = deps.now();
  sweep(now);
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((left, right) => left.expiresAt - right.expiresAt)[0];
    if (oldest) sessions.delete(oldest.id);
  }
  const code = deps.randomCode?.() ?? String(randomInt(0, 1_000_000)).padStart(6, '0');
  const session: Session = {
    id: randomBytes(16).toString('hex'),
    code,
    expiresAt: now + SESSION_TTL_MS,
  };
  sessions.set(session.id, session);
  return {
    sessionId: session.id,
    code,
    consentVersion: VOICE_CONSENT_VERSION,
    readingText: VOICE_READING_TEXT,
    expiresAt: session.expiresAt,
  };
}

export function cancelVoiceClone(sessionId: string): void {
  sessions.delete(sessionId);
}

function liveSession(sessionId: string, now: number): Session {
  sweep(now);
  const session = sessions.get(sessionId);
  if (!session) throw new Error('A sessão de gravação expirou. Comece de novo.');
  return session;
}

export async function verifyVoiceDeclaration(
  input: { sessionId: string; speakerName: string; wav: Uint8Array },
  deps: VoiceCloneDeps,
): Promise<VoiceDeclarationResult> {
  let session: Session;
  try {
    session = liveSession(input.sessionId, deps.now());
  } catch (error) {
    return { ok: false, missing: [], error: (error as Error).message };
  }
  const speakerName = input.speakerName.replace(/\s+/gu, ' ').trim();
  if (speakerName.length < 2 || speakerName.length > 80 || /[\u0000-\u001f<>]/u.test(speakerName)) {
    return { ok: false, missing: ['nome'], error: 'Escreva o seu nome como vai falar na declaração.' };
  }
  let durationSec: number;
  try {
    durationSec = readWavInfo(input.wav).durationSec;
  } catch (error) {
    return { ok: false, missing: [], error: `Gravação inválida: ${(error as Error).message}.` };
  }
  if (durationSec < VOICE_DECLARATION_MIN_SEC || durationSec > VOICE_DECLARATION_MAX_SEC) {
    return {
      ok: false,
      missing: [],
      error: `A declaração precisa ter entre ${VOICE_DECLARATION_MIN_SEC} e ${VOICE_DECLARATION_MAX_SEC} segundos.`,
    };
  }
  let transcript: string;
  try {
    transcript = await transcribe(deps, requireKey(deps), input.wav);
  } catch (error) {
    return { ok: false, missing: [], error: (error as Error).message };
  }
  const missing = missingFromDeclaration(transcript, speakerName, session.code);
  if (missing.length > 0) {
    session.declaration = undefined;
    return {
      ok: false,
      missing,
      error: `Não ouvi na declaração: ${missing.join(', ')}. Grave de novo lendo o texto inteiro, com calma.`,
    };
  }
  session.declaration = {
    wav: input.wav,
    sha256: sha256(input.wav),
    speakerName,
    text: voiceDeclarationText(speakerName, session.code),
    heard: ['nome', 'idade', 'autorização', 'código'],
  };
  return { ok: true };
}

export async function createVoiceClone(
  input: { sessionId: string; voiceName: string; samples: Uint8Array[] },
  deps: VoiceCloneDeps,
): Promise<VoiceCloneCreateResult> {
  let session: Session;
  try {
    session = liveSession(input.sessionId, deps.now());
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const declaration = session.declaration;
  if (!declaration) {
    return { ok: false, error: 'Grave e confirme a declaração antes de criar a voz.' };
  }
  const voiceName = input.voiceName.replace(/\s+/gu, ' ').trim();
  if (voiceName.length < 2 || voiceName.length > 60 || /[\u0000-\u001f<>]/u.test(voiceName)) {
    return { ok: false, error: 'Dê à voz um nome de 2 a 60 caracteres.' };
  }
  if (input.samples.length === 0 || input.samples.length > 5) {
    return { ok: false, error: 'Envie de 1 a 5 gravações da leitura.' };
  }
  let seconds = 0;
  try {
    for (const sample of input.samples) seconds += readWavInfo(sample).durationSec;
  } catch (error) {
    return { ok: false, error: `Gravação inválida: ${(error as Error).message}.` };
  }
  if (seconds < VOICE_SAMPLE_MIN_SEC || seconds > VOICE_SAMPLE_MAX_SEC) {
    return {
      ok: false,
      error: `A leitura precisa somar entre ${VOICE_SAMPLE_MIN_SEC / 60} e ${VOICE_SAMPLE_MAX_SEC / 60} minutos (agora: ${Math.round(seconds)} s).`,
    };
  }
  let key: string;
  try {
    key = requireKey(deps);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const form = new FormData();
  form.set('name', voiceName);
  form.set('remove_background_noise', 'false');
  form.set('description', 'Voz clonada no NexusIDE com consentimento gravado (recibo neste computador).');
  form.set('labels', JSON.stringify({ language: 'pt' }));
  input.samples.forEach((sample, index) => form.append('files', wavBlob(sample), `leitura-${index + 1}.wav`));
  const res = await deps.fetchFn(new URL('/v1/voices/add', ELEVENLABS_API), {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: form,
  });
  if (!res.ok) return { ok: false, error: await failure(res, 'criar a voz') };
  const body = (await res.json()) as { voice_id?: unknown; requires_verification?: unknown };
  const voiceId = typeof body.voice_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(body.voice_id)
    ? body.voice_id
    : null;
  if (!voiceId) return { ok: false, error: 'A ElevenLabs não devolveu o id da voz criada.' };

  const receipt: VoiceConsentReceipt = {
    id: newReceiptId(),
    provider: 'elevenlabs',
    voiceId,
    voiceName,
    speakerName: declaration.speakerName,
    declarationText: declaration.text,
    declarationSha256: declaration.sha256,
    samplesSha256: input.samples.map(sha256),
    samplesSeconds: Math.round(seconds * 10) / 10,
    consentVersion: VOICE_CONSENT_VERSION,
    readingTextSha256: createHash('sha256').update(VOICE_READING_TEXT).digest('hex'),
    createdAt: new Date(deps.now()).toISOString(),
    appVersion: deps.appVersion,
    verification: { method: 'stt', provider: 'elevenlabs', model: STT_MODEL, heard: declaration.heard },
    requiresVerification: body.requires_verification === true,
  };
  try {
    deps.store.add(receipt, declaration.wav);
  } catch {
    // Never leave a clone without its consent receipt: undo at the provider.
    await deleteAtProvider(deps, key, voiceId).catch(() => undefined);
    return { ok: false, error: 'Não consegui guardar o recibo neste computador; a voz foi desfeita na ElevenLabs.' };
  }
  sessions.delete(session.id);
  return { ok: true, receipt: receiptView(receipt) };
}

async function deleteAtProvider(deps: VoiceCloneDeps, key: string, voiceId: string): Promise<void> {
  const res = await deps.fetchFn(new URL(`/v1/voices/${encodeURIComponent(voiceId)}`, ELEVENLABS_API), {
    method: 'DELETE',
    headers: { 'xi-api-key': key },
  });
  // 404/400: the voice is already gone (deleted on the site) — nothing left to remove there.
  if (!res.ok && res.status !== 404 && res.status !== 400) {
    throw new Error(await failure(res, 'apagar a voz'));
  }
}

export async function removeVoiceClone(
  input: { id: string; localOnly?: boolean },
  deps: VoiceCloneDeps,
): Promise<VoiceCloneRemoveResult> {
  const receipt = deps.store.get(input.id);
  if (!receipt) return { ok: false, error: 'Recibo não encontrado.', canRemoveLocally: false };
  let removedAtProvider = false;
  if (!input.localOnly) {
    try {
      await deleteAtProvider(deps, requireKey(deps), receipt.voiceId);
      removedAtProvider = true;
    } catch (error) {
      return {
        ok: false,
        error: `${(error as Error).message} A voz continua na ElevenLabs; tente de novo ou apague lá.`,
        canRemoveLocally: true,
      };
    }
  }
  deps.store.remove(receipt.id);
  if (deps.voiceoverCacheDir) purgeVoiceoverCacheForVoice(deps.voiceoverCacheDir, receipt.voiceId);
  return { ok: true, removedAtProvider };
}
