import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginVoiceClone,
  cancelVoiceClone,
  createVoiceClone,
  missingFromDeclaration,
  removeVoiceClone,
  resetVoiceCloneSessionsForTests,
  verifyVoiceDeclaration,
  type VoiceCloneDeps,
} from './voice-clone';
import { VoiceConsentStore } from './voice-consents';
import { readWavInfo } from './wav-info';

/** PCM16 mono WAV of `seconds` of silence at `rate` Hz. */
function wav(seconds: number, rate = 44_100): Uint8Array {
  const dataBytes = Math.round(seconds * rate) * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'latin1');
  buffer.write('fmt ', 12, 'latin1');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'latin1');
  buffer.writeUInt32LE(dataBytes, 40);
  return new Uint8Array(buffer);
}

let root: string;
let cacheDir: string;
let transcript: string;
const calls: Array<{ url: string; method: string; fields: Record<string, unknown> }> = [];

function fetchFn(): typeof fetch {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const fields: Record<string, unknown> = {};
    if (init?.body instanceof FormData) {
      for (const [key, value] of init.body.entries()) {
        fields[key] = typeof value === 'string' ? value : `<file ${(value as File).name}>`;
        if (key === 'files') fields.fileCount = ((fields.fileCount as number) ?? 0) + 1;
      }
    }
    calls.push({ url, method: init?.method ?? 'GET', fields });
    if (url.endsWith('/v1/speech-to-text')) {
      return new Response(JSON.stringify({ text: transcript, language_code: 'por' }));
    }
    if (url.endsWith('/v1/voices/add')) {
      return new Response(JSON.stringify({ voice_id: 'voz_nova', requires_verification: false }));
    }
    if (url.includes('/v1/voices/') && init?.method === 'DELETE') {
      return new Response('{}', { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

function deps(overrides: Partial<VoiceCloneDeps> = {}): VoiceCloneDeps {
  return {
    fetchFn: fetchFn(),
    getKey: () => 'xi-key',
    store: new VoiceConsentStore(root),
    voiceoverCacheDir: cacheDir,
    now: () => Date.parse('2026-10-19T12:00:00Z'),
    appVersion: '0.76.322',
    randomCode: () => '482913',
    ...overrides,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-voice-'));
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-voice-cache-'));
  transcript =
    'Eu, Ana Beatriz Souza, sou maior de 18 anos e autorizo a criação de uma voz sintética ' +
    'a partir da minha própria voz. Código quatro, oito, dois, nove, um, três.';
  calls.length = 0;
  resetVoiceCloneSessionsForTests();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe('readWavInfo', () => {
  it('lê formato e duração do PCM', () => {
    expect(readWavInfo(wav(2.5))).toMatchObject({ sampleRate: 44_100, channels: 1, bitsPerSample: 16 });
    expect(readWavInfo(wav(2.5)).durationSec).toBeCloseTo(2.5, 2);
  });

  it('recusa o que não é WAV PCM 16 bits', () => {
    expect(() => readWavInfo(new Uint8Array(Buffer.from('ID3 não é wav, é mp3 de verdade....................')))).toThrow(/não é WAV/u);
    const float = Buffer.from(wav(1));
    float.writeUInt16LE(3, 20);
    expect(() => readWavInfo(new Uint8Array(float))).toThrow(/PCM/u);
  });
});

describe('missingFromDeclaration', () => {
  it('aceita dígitos falados por extenso, com o 18 antes', () => {
    expect(missingFromDeclaration(transcript, 'Ana Beatriz Souza', '482913')).toEqual([]);
  });

  it('aceita dígitos numerais e nome com erro pequeno do reconhecimento', () => {
    const heard = 'eu tiago silva sou maior de dezoito anos e autorizo ... codigo 4 8 2 9 1 3';
    expect(missingFromDeclaration(heard, 'Thiago Silva', '482913')).toEqual([]);
  });

  it('diz o que faltou', () => {
    expect(missingFromDeclaration('eu ana autorizo codigo 4 8 2', 'Ana', '482913')).toEqual(['idade', 'código']);
    expect(missingFromDeclaration('eu sou maior de 18 anos codigo 482913', 'Ana', '482913')).toEqual([
      'nome',
      'autorização',
    ]);
  });

  it('outro nome não passa', () => {
    expect(missingFromDeclaration(transcript.replace('Ana Beatriz Souza', 'Carlos Pereira'), 'Ana Beatriz Souza', '482913')).toContain('nome');
  });
});

describe('fluxo Minha voz', () => {
  it('declaração conferida, voz criada, recibo e prova gravados localmente', async () => {
    const d = deps();
    const session = beginVoiceClone(d);
    expect(session.code).toBe('482913');
    const verified = await verifyVoiceDeclaration(
      { sessionId: session.sessionId, speakerName: 'Ana Beatriz Souza', wav: wav(9) },
      d,
    );
    expect(verified).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({
      url: 'https://api.elevenlabs.io/v1/speech-to-text',
      fields: { model_id: 'scribe_v2', language_code: 'pt' },
    });

    const created = await createVoiceClone(
      { sessionId: session.sessionId, voiceName: 'Minha voz', samples: [wav(50), wav(40)] },
      d,
    );
    expect(created).toMatchObject({ ok: true, receipt: { voiceId: 'voz_nova', voiceName: 'Minha voz' } });
    const add = calls.find((call) => call.url.endsWith('/v1/voices/add'));
    expect(add?.fields).toMatchObject({ name: 'Minha voz', remove_background_noise: 'false', fileCount: 2 });

    const file = JSON.parse(fs.readFileSync(path.join(root, 'voice-consents.json'), 'utf8'));
    expect(file.version).toBe(1);
    expect(file.receipts[0]).toMatchObject({
      provider: 'elevenlabs',
      voiceId: 'voz_nova',
      speakerName: 'Ana Beatriz Souza',
      consentVersion: expect.any(String),
      appVersion: '0.76.322',
      createdAt: '2026-10-19T12:00:00.000Z',
      verification: { method: 'stt', model: 'scribe_v2' },
    });
    expect(file.receipts[0].declarationText).toContain('Código 4 8 2 9 1 3');
    expect(file.receipts[0].samplesSha256).toHaveLength(2);
    const evidence = path.join(root, 'voice-consents', file.receipts[0].id, 'declaration.wav');
    expect(fs.existsSync(evidence)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(root, 'voice-consents.json')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(evidence).mode & 0o777).toBe(0o600);
    }
    expect(d.store.hasVoice('voz_nova')).toBe(true);
  });

  it('sem declaração conferida não cria voz nem chama o provedor', async () => {
    const d = deps();
    const session = beginVoiceClone(d);
    const created = await createVoiceClone(
      { sessionId: session.sessionId, voiceName: 'x', samples: [wav(90)] },
      d,
    );
    expect(created).toMatchObject({ ok: false, error: expect.stringMatching(/declaração/u) });
    expect(calls).toHaveLength(0);
  });

  it('declaração sem o código não libera a criação', async () => {
    transcript = 'Eu, Ana Beatriz Souza, sou maior de 18 anos e autorizo.';
    const d = deps();
    const session = beginVoiceClone(d);
    const verified = await verifyVoiceDeclaration(
      { sessionId: session.sessionId, speakerName: 'Ana Beatriz Souza', wav: wav(8) },
      d,
    );
    expect(verified).toMatchObject({ ok: false, missing: ['código'] });
    const created = await createVoiceClone({ sessionId: session.sessionId, voiceName: 'x', samples: [wav(90)] }, d);
    expect(created.ok).toBe(false);
    expect(calls.some((call) => call.url.endsWith('/v1/voices/add'))).toBe(false);
  });

  it('código de outra sessão não vale', async () => {
    const d = deps({ randomCode: () => '000111' });
    const session = beginVoiceClone(d);
    const verified = await verifyVoiceDeclaration(
      { sessionId: session.sessionId, speakerName: 'Ana Beatriz Souza', wav: wav(8) },
      d,
    );
    expect(verified).toMatchObject({ ok: false, missing: ['código'] });
  });

  it('leitura curta ou longa demais é recusada antes da rede', async () => {
    const d = deps();
    const session = beginVoiceClone(d);
    await verifyVoiceDeclaration({ sessionId: session.sessionId, speakerName: 'Ana Beatriz Souza', wav: wav(8) }, d);
    calls.length = 0;
    const short = await createVoiceClone({ sessionId: session.sessionId, voiceName: 'x1', samples: [wav(30)] }, d);
    expect(short).toMatchObject({ ok: false, error: expect.stringMatching(/entre 1 e 3 minutos/u) });
    const long = await createVoiceClone({ sessionId: session.sessionId, voiceName: 'x1', samples: [wav(100), wav(100)] }, d);
    expect(long.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('sessão cancelada ou expirada não aceita mais nada', async () => {
    let now = Date.parse('2026-10-19T12:00:00Z');
    const d = deps({ now: () => now });
    const session = beginVoiceClone(d);
    cancelVoiceClone(session.sessionId);
    expect(
      await verifyVoiceDeclaration({ sessionId: session.sessionId, speakerName: 'Ana', wav: wav(8) }, d),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/expirou/u) });
    const second = beginVoiceClone(d);
    now += 31 * 60_000;
    expect(
      await verifyVoiceDeclaration({ sessionId: second.sessionId, speakerName: 'Ana', wav: wav(8) }, d),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/expirou/u) });
  });

  it('se o recibo não grava, a voz é desfeita na ElevenLabs', async () => {
    const d = deps();
    const add = vi.spyOn(d.store, 'add').mockImplementation(() => {
      throw new Error('disco cheio');
    });
    const session = beginVoiceClone(d);
    await verifyVoiceDeclaration({ sessionId: session.sessionId, speakerName: 'Ana Beatriz Souza', wav: wav(8) }, d);
    const created = await createVoiceClone({ sessionId: session.sessionId, voiceName: 'Minha', samples: [wav(90)] }, d);
    expect(add).toHaveBeenCalled();
    expect(created).toMatchObject({ ok: false, error: expect.stringMatching(/desfeita/u) });
    expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/v1/voices/voz_nova'))).toBe(true);
  });

  it('apagar remove no provedor, o recibo, a prova e o cache de narração da voz', async () => {
    const d = deps();
    const session = beginVoiceClone(d);
    await verifyVoiceDeclaration({ sessionId: session.sessionId, speakerName: 'Ana Beatriz Souza', wav: wav(8) }, d);
    const created = await createVoiceClone({ sessionId: session.sessionId, voiceName: 'Minha', samples: [wav(90)] }, d);
    if (!created.ok) throw new Error(created.error);
    const cacheKey = 'a'.repeat(64);
    fs.writeFileSync(path.join(cacheDir, `${cacheKey}.json`), JSON.stringify({ schema: 1, voiceId: 'voz_nova', alignment: {} }));
    fs.writeFileSync(path.join(cacheDir, `${cacheKey}.mp3`), 'x');

    const removed = await removeVoiceClone({ id: created.receipt.id }, d);
    expect(removed).toEqual({ ok: true, removedAtProvider: true });
    expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/v1/voices/voz_nova'))).toBe(true);
    expect(d.store.list()).toEqual([]);
    expect(fs.existsSync(path.join(root, 'voice-consents', created.receipt.id))).toBe(false);
    expect(fs.readdirSync(cacheDir)).toEqual([]);
  });

  it('falha no provedor mantém o recibo e oferece apagar só daqui', async () => {
    const d = deps();
    const session = beginVoiceClone(d);
    await verifyVoiceDeclaration({ sessionId: session.sessionId, speakerName: 'Ana Beatriz Souza', wav: wav(8) }, d);
    const created = await createVoiceClone({ sessionId: session.sessionId, voiceName: 'Minha', samples: [wav(90)] }, d);
    if (!created.ok) throw new Error(created.error);
    const failing = deps({
      store: d.store,
      fetchFn: vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch,
    });
    const removed = await removeVoiceClone({ id: created.receipt.id }, failing);
    expect(removed).toMatchObject({ ok: false, canRemoveLocally: true });
    expect(d.store.list()).toHaveLength(1);
    expect(await removeVoiceClone({ id: created.receipt.id, localOnly: true }, failing)).toEqual({
      ok: true,
      removedAtProvider: false,
    });
    expect(d.store.list()).toEqual([]);
  });

  it('sem chave não grava nem transcreve', async () => {
    const d = deps({ getKey: () => undefined });
    const session = beginVoiceClone(d);
    expect(
      await verifyVoiceDeclaration({ sessionId: session.sessionId, speakerName: 'Ana', wav: wav(8) }, d),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/Serviços de mídia/u) });
    expect(calls).toHaveLength(0);
  });
});
