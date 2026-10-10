import { describe, expect, it, vi } from 'vitest';
import { decisionSettingsSchema, type DecisionSettings } from '../../shared/decision-models';
import { syntheticWav } from '../decision-models/decision-audio.fixture';
import type { ClefConnection } from '../decision-models/clef-client';
import { wavDurationSeconds } from '../decision-models/decision-audio';
import { AcousticWakeConfirmer, gateAcousticWake, shouldSuppressWake, startWakeClefConfirmation, WAKE_CLEF_ACOUSTIC_MAX_WAIT_MS,
  WAKE_CLEF_AMBIENT_THRESHOLD, WAKE_CLEF_CLIP_MS, wakeClefEligible, WakeClipRecorder, type WakeClefDeps } from './wake-clef-confirm';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const CLIP = syntheticWav(0.8).toString('base64');
const omniSettings = (change: Partial<DecisionSettings> = {}): DecisionSettings => decisionSettingsSchema.parse({
  mode: 'clef', clefModel: 'clef-omni', cloudflareAccountId: ACCOUNT, audioConsent: { version: 1, recipients: ['clef'] }, ...change,
});
const connection = (settings: DecisionSettings): ClefConnection => ({ accountId: ACCOUNT, token: 'synthetic-cloudflare-token',
  model: settings.clefModel, audioConsent: settings.audioConsent?.recipients.includes('clef') ?? false });

/** O cliente renomeia os ids (q0…); a resposta ecoa os ids enviados, como a API real. */
const answersFor = (body: any, noul: number) => Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul }]));

function harness(options: { settings?: DecisionSettings; clef?: boolean; reply?: (body: any, signal: AbortSignal) => Promise<Response>;
  connection?: (settings: DecisionSettings) => ClefConnection | undefined } = {}) {
  const bodies: any[] = [];
  const record = vi.fn(() => 'id');
  const recordNoAnswer = vi.fn(() => 'id');
  const deps: Partial<WakeClefDeps> = {
    getSettings: () => options.settings ?? omniSettings(),
    getAvailability: () => ({ jev: false, clef: options.clef ?? true }),
    getConnection: options.connection ?? connection,
    record: record as unknown as WakeClefDeps['record'],
    recordNoAnswer: recordNoAnswer as unknown as WakeClefDeps['recordNoAnswer'],
    timeoutMs: 80,
    fetch: (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      return options.reply ? options.reply(body, init!.signal!) : Response.json({ success: true, result: { model: 'clef-omni',
        answers: answersFor(body, 0.1), usage: { input_tokens: 400, output_tokens: 0 } } });
    }) as typeof fetch,
  };
  return { deps, bodies, record, recordNoAnswer };
}
const ambient = (noul: number) => async (body: any) => Response.json({ success: true, result: { model: body.model,
  answers: answersFor(body, noul), usage: { input_tokens: 400, output_tokens: 0 } } });

describe('Clef-omni wake confirmation', () => {
  it('sends the same clip to clef-omni and suppresses a confidently ambient activation', async () => {
    const { deps, bodies, record } = harness({ reply: ambient(0.93) });
    const pending = startWakeClefConfirmation({ wavBase64: CLIP, wakePhrase: '"Jarvis"' }, deps);
    expect(pending).not.toBeNull();
    const result = await shouldSuppressWake(pending, true);
    expect(result).toEqual({ suppress: true, verdict: { kind: 'ambient', probability: 0.93 } });
    expect(bodies[0].model).toBe('clef-omni');
    expect(bodies[0].audio).toEqual([`data:audio/wav;base64,${CLIP}`]);
    expect(Object.values(bodies[0].questions)[0]).toMatchObject({ type: 'noul' });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ surface: 'wakeConfirm', decision: 'suppress-ambient',
      provider: 'clef', inputTokens: 400, usd: expect.closeTo(400 * 0.15 / 1_000_000, 12) }));
  });

  it('suppresses exactly at the 0.8 threshold', async () => {
    const { deps } = harness({ reply: ambient(WAKE_CLEF_AMBIENT_THRESHOLD) });
    const result = await shouldSuppressWake(startWakeClefConfirmation({ wavBase64: CLIP }, deps), true);
    expect(result).toEqual({ suppress: true, verdict: { kind: 'ambient', probability: 0.8 } });
  });

  it('asks about the wake phrase the detector heard, never the persona name', async () => {
    const { deps, bodies } = harness({ reply: ambient(0.1) });
    await shouldSuppressWake(startWakeClefConfirmation({ wavBase64: CLIP }, deps), true);
    const question = Object.values(bodies[0].questions)[0] as { instructions: string };
    expect(question.instructions).toContain('"Hey Jarvis"');
    expect(JSON.stringify(bodies[0])).not.toContain('assistantName');
  });

  it('lets speech through, including an uncertain ambient score just below the threshold', async () => {
    for (const noul of [0.05, WAKE_CLEF_AMBIENT_THRESHOLD - 0.01]) {
      const { deps, record } = harness({ reply: ambient(noul) });
      const result = await shouldSuppressWake(startWakeClefConfirmation({ wavBase64: CLIP }, deps), true);
      expect(result.suppress).toBe(false);
      expect(result.verdict).toEqual({ kind: 'speech', probability: noul });
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ surface: 'wakeConfirm', decision: 'allow' }));
    }
  });

  it('falls back to the current behavior on an HTTP error and journals the no-answer', async () => {
    const { deps, recordNoAnswer } = harness({ reply: async () => Response.json({ success: false }, { status: 401 }) });
    const result = await shouldSuppressWake(startWakeClefConfirmation({ wavBase64: CLIP }, deps), true);
    expect(result).toEqual({ suppress: false, verdict: { kind: 'no-answer', reason: 'client-error' } });
    expect(recordNoAnswer).toHaveBeenCalledWith(expect.objectContaining({ surface: 'wakeConfirm', reason: 'client-error', provider: 'clef' }));
  });

  it('never holds the wake past its timeout', async () => {
    const hang = (_body: any, signal: AbortSignal) => new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const { deps } = harness({ reply: hang });
    const started = performance.now();
    const result = await shouldSuppressWake(startWakeClefConfirmation({ wavBase64: CLIP }, deps), true, 80);
    expect(result.suppress).toBe(false);
    expect(result.verdict).toEqual({ kind: 'no-answer', reason: 'timeout' });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('a pending promise that never settles still resolves to "do not suppress" at the safety deadline', async () => {
    const result = await shouldSuppressWake({ verdict: new Promise(() => {}), cancel: vi.fn() }, true, 10);
    expect(result).toEqual({ suppress: false, verdict: { kind: 'no-answer', reason: 'timeout' } });
  });

  it('cancels the Clef request when the transcript has no wake word', async () => {
    let aborted = false;
    const { deps } = harness({ reply: (_body, signal) => new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }) });
    const pending = startWakeClefConfirmation({ wavBase64: CLIP }, deps);
    await Promise.resolve();
    expect(await shouldSuppressWake(pending, false)).toEqual({ suppress: false, verdict: null });
    await expect(pending!.verdict).resolves.toEqual({ kind: 'no-answer', reason: 'aborted' });
    expect(aborted).toBe(true);
  });

  it.each([
    ['audio consent off', { settings: omniSettings({ audioConsent: { version: 1, recipients: [] } }) }],
    ['audio consent absent', { settings: decisionSettingsSchema.parse({ mode: 'clef', clefModel: 'clef-omni', cloudflareAccountId: ACCOUNT }) }],
    ['another Clef variant', { settings: omniSettings({ clefModel: 'clef' }) }],
    ['Somente Jev', { settings: omniSettings({ mode: 'jev' }) }],
    ['Somente Luna', { settings: omniSettings({ mode: 'luna' }) }],
    ['Cloudflare credentials missing', { clef: false }],
  ] as const)('sends nothing when %s', async (_label, options) => {
    const { deps, bodies } = harness(options);
    const pending = startWakeClefConfirmation({ wavBase64: CLIP }, deps);
    expect(pending).toBeNull();
    expect(await shouldSuppressWake(pending, true)).toEqual({ suppress: false, verdict: null });
    expect(bodies).toHaveLength(0);
  });

  it('checks the Clef-omni variant itself, not only through the schema reset of the consent', async () => {
    // Conexão de outra variante com a autorização ligada: preferências omni válidas não bastam.
    const wrongConnection = harness({ connection: settings => ({ ...connection(settings), model: 'clef', audioConsent: true }) });
    expect(startWakeClefConfirmation({ wavBase64: CLIP }, wrongConnection.deps)).toBeNull();
    expect(wrongConnection.bodies).toHaveLength(0);
    // Preferências de outra variante com a autorização ainda presente (sem passar pelo schema).
    const raw = { ...omniSettings(), clefModel: 'clef' } as DecisionSettings;
    const wrongSettings = harness({ settings: raw, connection: () => ({ accountId: ACCOUNT, token: 'synthetic-cloudflare-token',
      model: 'clef-omni', audioConsent: true }) });
    expect(startWakeClefConfirmation({ wavBase64: CLIP }, wrongSettings.deps)).toBeNull();
    expect(wrongSettings.bodies).toHaveLength(0);
  });

  it('sends nothing for a clip that is not a valid WAV', () => {
    const { deps, bodies } = harness();
    expect(startWakeClefConfirmation({ wavBase64: Buffer.from('raw pcm, no header').toString('base64') }, deps)).toBeNull();
    expect(bodies).toHaveLength(0);
  });

  it('is eligible in every mode that can reach Cloudflare once Clef-omni and the consent are on', () => {
    for (const mode of ['auto', 'clef', 'together'] as const) {
      expect(wakeClefEligible(omniSettings({ mode }), { jev: true, clef: true })).toBe(true);
    }
  });
});

describe('acoustic wake gate (the always-on path)', () => {
  const recorder = (seconds: number) => {
    const clip = new WakeClipRecorder();
    for (let index = 0; index < seconds * 10; index++) clip.push(new Float32Array(1_600).fill(0.25));
    return clip;
  };

  it('keeps only the last two seconds as a valid 16 kHz PCM16 WAV', () => {
    const clip = recorder(5);
    const wav = Buffer.from(clip.wavBase64()!, 'base64');
    expect(wavDurationSeconds(wav)).toBeCloseTo(2, 5);
    expect(wav.readInt16LE(44)).toBe(Math.round(0.25 * 0x7fff));
    expect(new WakeClipRecorder().wavBase64()).toBeNull();
    clip.clear();
    expect(clip.wavBase64()).toBeNull();
  });

  it('never retains more than ~2 s of audio, however long the mic runs', () => {
    const clip = recorder(5);
    const maxSamples = 16_000 * WAKE_CLEF_CLIP_MS / 1_000;
    expect(clip.retainedSamples).toBeGreaterThanOrEqual(maxSamples);
    expect(clip.retainedSamples).toBeLessThanOrEqual(maxSamples + 1_600);
  });

  it('caps the wait at ~1.45 s, within the "até cerca de 1,5 s" the consent promises', () => {
    expect(WAKE_CLEF_ACOUSTIC_MAX_WAIT_MS).toBe(1_450);
    expect(WAKE_CLEF_ACOUSTIC_MAX_WAIT_MS).toBeLessThanOrEqual(1_500);
  });

  it('drops a detection Clef-omni hears as confidently ambient', async () => {
    const { deps, bodies, record } = harness({ reply: ambient(0.9) });
    const deliver = vi.fn(); const log = vi.fn();
    const gate = gateAcousticWake({ clip: recorder(3), deliver, log }, deps);
    expect(deliver).not.toHaveBeenCalled();
    await expect(gate).resolves.toBe(true);
    expect(deliver).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(true, { kind: 'ambient', probability: 0.9 });
    expect(bodies[0].audio[0]).toMatch(/^data:audio\/wav;base64,UklGR/);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ surface: 'wakeConfirm', decision: 'suppress-ambient' }));
  });

  it('delivers the detection on speech, on error and on timeout', async () => {
    const hang = (_body: any, signal: AbortSignal) => new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    for (const reply of [ambient(0.3), async () => Response.json({ success: false }, { status: 503 }), hang]) {
      const { deps } = harness({ reply });
      const deliver = vi.fn();
      await expect(gateAcousticWake({ clip: recorder(3), deliver }, deps)).resolves.toBe(false);
      expect(deliver).toHaveBeenCalledTimes(1);
    }
  });

  it('delivers at once, without any request, when the operator did not turn audio on', () => {
    const { deps, bodies } = harness({ settings: omniSettings({ audioConsent: { version: 1, recipients: [] } }) });
    const deliver = vi.fn();
    expect(gateAcousticWake({ clip: recorder(3), deliver }, deps)).toBeNull();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(0);
  });
});

describe('AcousticWakeConfirmer (the voice-ipc wiring)', () => {
  const frames = (confirmer: AcousticWakeConfirmer, seconds: number) => {
    for (let index = 0; index < seconds * 10; index++) confirmer.push(new Float32Array(1_600).fill(0.25));
  };
  function wired(options: Parameters<typeof harness>[0] & { settings?: DecisionSettings } = {}) {
    let current = options.settings ?? omniSettings();
    const h = harness({ ...options });
    h.deps.getSettings = () => current;
    const listeners: Array<() => void> = [];
    const confirmer = new AcousticWakeConfirmer(h.deps, listener => { listeners.push(listener); return () => {}; });
    return { ...h, confirmer, change: (next: DecisionSettings) => { current = next; for (const listener of listeners) listener(); } };
  }
  const hang = (_body: any, signal: AbortSignal) => new Promise<Response>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

  it('retains no audio at all without the full opt-in', () => {
    for (const settings of [omniSettings({ audioConsent: { version: 1, recipients: [] } }), omniSettings({ clefModel: 'clef' }),
      omniSettings({ mode: 'jev' })]) {
      const { confirmer, bodies } = wired({ settings });
      frames(confirmer, 3);
      expect(confirmer.retainedSamples).toBe(0);
      const deliver = vi.fn();
      expect(confirmer.detect({ deliver })).toBeNull();
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(bodies).toHaveLength(0);
    }
    const noCredential = wired({ clef: false });
    frames(noCredential.confirmer, 3);
    expect(noCredential.confirmer.retainedSamples).toBe(0);
  });

  it('suppresses a confidently ambient detection, delivers otherwise, and clears the clip after use', async () => {
    const quiet = wired({ reply: ambient(0.95) });
    frames(quiet.confirmer, 3);
    expect(quiet.confirmer.retainedSamples).toBeGreaterThan(0);
    const dropped = vi.fn();
    await expect(quiet.confirmer.detect({ deliver: dropped })).resolves.toBe(true);
    expect(dropped).not.toHaveBeenCalled();
    expect(quiet.confirmer.retainedSamples).toBe(0);
    expect(quiet.bodies[0].audio[0]).toMatch(/^data:audio\/wav;base64,UklGR/);
    for (const reply of [ambient(0.2), async () => Response.json({ success: false }, { status: 500 }), hang]) {
      const { confirmer } = wired({ reply });
      frames(confirmer, 3);
      const deliver = vi.fn();
      await expect(confirmer.detect({ deliver })).resolves.toBe(false);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(confirmer.retainedSamples).toBe(0);
    }
  });

  it('keeps one confirmation in flight: a repeated detection neither calls Clef again nor delivers twice', async () => {
    const { confirmer, bodies } = wired({ reply: hang });
    frames(confirmer, 3);
    const first = vi.fn(); const second = vi.fn();
    const gate = confirmer.detect({ deliver: first });
    frames(confirmer, 1);
    expect(confirmer.detect({ deliver: second })).toBeNull();
    await gate;
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(bodies).toHaveLength(1);
  });

  it('revoking the consent aborts the confirmation in flight, delivers the wake and forgets the audio', async () => {
    let aborted = false;
    const { confirmer, change } = wired({ reply: (_body, signal) => new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }) });
    frames(confirmer, 3);
    const deliver = vi.fn();
    const gate = confirmer.detect({ deliver });
    frames(confirmer, 1);
    expect(confirmer.retainedSamples).toBeGreaterThan(0);
    const started = performance.now();
    change(omniSettings({ audioConsent: { version: 1, recipients: [] } }));
    expect(confirmer.retainedSamples).toBe(0);
    await expect(gate).resolves.toBe(false);
    expect(performance.now() - started).toBeLessThan(60);
    expect(aborted).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
    frames(confirmer, 2);
    expect(confirmer.retainedSamples).toBe(0);
  });
});
