import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE_CONFIG } from '../../../shared/voice-config';
import { JarvisLatencyTracker, JarvisMetricsLogger } from './metrics';
import { RealtimeProviderCache } from './factory';

// ---------------------------------------------------------------------------
// (a) Instrumentação de cold-start: markSessionBoot → markFirstAudioChunk
// ---------------------------------------------------------------------------

describe('JarvisLatencyTracker — cold-start instrumentation', () => {
  function makeLogger(): { logger: JarvisMetricsLogger; filePath: string } {
    const filePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cold-')),
      'metrics.log',
    );
    return { logger: new JarvisMetricsLogger({ filePath }), filePath };
  }

  it('registra cold_start_ms entre boot e primeiro chunk de áudio', () => {
    const { logger, filePath } = makeLogger();
    let wall = 0;
    const tracker = new JarvisLatencyTracker(logger, () => wall);

    tracker.markSessionBoot('s-cold');
    wall = 3_500;
    tracker.markFirstAudioChunk('s-cold');

    const metrics = fs
      .readFileSync(filePath, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    expect(metrics).toHaveLength(1);
    expect(metrics[0].metric).toBe('cold_start_ms');
    expect(metrics[0].value).toBe(3500);
    expect(metrics[0].session_id).toBe('s-cold');
  });

  it('não registra cold_start_ms quando markFirstAudioChunk é chamado sem boot anterior', () => {
    const { logger, filePath } = makeLogger();
    const tracker = new JarvisLatencyTracker(logger);

    tracker.markFirstAudioChunk('s-no-boot');

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('ignora chamadas duplicadas de markFirstAudioChunk na mesma sessão', () => {
    const { logger, filePath } = makeLogger();
    let wall = 1000;
    const tracker = new JarvisLatencyTracker(logger, () => wall);

    tracker.markSessionBoot('s-dup');
    wall = 2000;
    tracker.markFirstAudioChunk('s-dup');
    wall = 3000;
    tracker.markFirstAudioChunk('s-dup'); // segunda chamada: deve ser ignorada

    const metrics = fs
      .readFileSync(filePath, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    // Apenas um registro de cold_start_ms
    expect(metrics.filter((m) => m.metric === 'cold_start_ms')).toHaveLength(1);
    expect(metrics[0].value).toBe(1000);
  });

  it('markSessionBoot é idempotente: segundo boot não substitui o primeiro', () => {
    const { logger, filePath } = makeLogger();
    let wall = 0;
    const tracker = new JarvisLatencyTracker(logger, () => wall);

    tracker.markSessionBoot('s-idm');
    wall = 500;
    tracker.markSessionBoot('s-idm'); // deve ser ignorado
    wall = 2000;
    tracker.markFirstAudioChunk('s-idm');

    const metrics = fs
      .readFileSync(filePath, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    // cold_start_ms deve ser medido desde o PRIMEIRO boot (wall=0), não o segundo
    expect(metrics[0].value).toBe(2000);
  });

  it('discardSession limpa o estado sem logar', () => {
    const { logger, filePath } = makeLogger();
    const tracker = new JarvisLatencyTracker(logger);

    tracker.markSessionBoot('s-disc');
    tracker.discardSession('s-disc');
    tracker.markFirstAudioChunk('s-disc'); // sessão foi descartada: não deve logar

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('isolamento: sessões distintas têm medições independentes', () => {
    const { logger, filePath } = makeLogger();
    let wall = 0;
    const tracker = new JarvisLatencyTracker(logger, () => wall);

    tracker.markSessionBoot('sess-A');
    wall = 1000;
    tracker.markSessionBoot('sess-B');
    wall = 4000;
    tracker.markFirstAudioChunk('sess-A'); // 4000ms desde boot de A (wall=0)
    wall = 5000;
    tracker.markFirstAudioChunk('sess-B'); // 4000ms desde boot de B (wall=1000)

    const metrics = fs
      .readFileSync(filePath, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    const bySession = Object.fromEntries(
      metrics.map((m) => [m.session_id, m.value]),
    );
    expect(bySession['sess-A']).toBe(4000);
    expect(bySession['sess-B']).toBe(4000);
  });
});

// ---------------------------------------------------------------------------
// (b) Warm-path: RealtimeProviderCache reusa a sessão pré-aquecida
// ---------------------------------------------------------------------------

describe('RealtimeProviderCache — warm-path', () => {
  const warmConfig = {
    ...DEFAULT_VOICE_CONFIG,
    jarvisLive: {
      ...DEFAULT_VOICE_CONFIG.jarvisLive,
      transport: 'openai-realtime' as const,
    },
  };

  it('consume retorna null quando nenhum prime foi executado', () => {
    const cache = new RealtimeProviderCache();
    expect(cache.consume()).toBeNull();
    expect(cache.isWarm).toBe(false);
  });

  it('prime retorna false e o cache permanece frio quando nenhuma API key está disponível', async () => {
    vi.resetModules();
    vi.doMock('../../voice/voice-secrets', () => ({
      resolveVoiceApiKey: () => undefined,
    }));
    const { RealtimeProviderCache: ColdCache } = await import('./factory');
    const cache = new ColdCache();

    expect(cache.prime({ config: warmConfig })).toBe(false);
    expect(cache.isWarm).toBe(false);
    expect(cache.consume()).toBeNull();
    vi.doUnmock('../../voice/voice-secrets');
  });

  it('prime armazena o provider e consume o devolve uma única vez', async () => {
    vi.resetModules();
    vi.doMock('../../voice/voice-secrets', () => ({
      resolveVoiceApiKey: (envVar: string) =>
        envVar === 'OPENAI_API_KEY' ? 'openai-key' : undefined,
    }));
    const { RealtimeProviderCache: WarmCache } = await import('./factory');
    const cache = new WarmCache();

    expect(cache.prime({ config: warmConfig })).toBe(true);
    expect(cache.isWarm).toBe(true);

    const first = cache.consume();
    expect(first).not.toBeNull();
    expect(first!.id).toBe('openai');

    // Segundo consume deve ser null: cache já foi drenado
    expect(cache.consume()).toBeNull();
    expect(cache.isWarm).toBe(false);
    vi.doUnmock('../../voice/voice-secrets');
  });

  it('clear descarta o provider pré-aquecido sem consumir', async () => {
    vi.resetModules();
    vi.doMock('../../voice/voice-secrets', () => ({
      resolveVoiceApiKey: (envVar: string) =>
        envVar === 'OPENAI_API_KEY' ? 'openai-key' : undefined,
    }));
    const { RealtimeProviderCache: WarmCache2 } = await import('./factory');
    const cache = new WarmCache2();

    cache.prime({ config: warmConfig });
    expect(cache.isWarm).toBe(true);

    cache.clear();
    expect(cache.isWarm).toBe(false);
    expect(cache.consume()).toBeNull();
    vi.doUnmock('../../voice/voice-secrets');
  });

  it('prime sequencial substitui o provider anterior', async () => {
    vi.resetModules();
    vi.doMock('../../voice/voice-secrets', () => ({
      resolveVoiceApiKey: (envVar: string) =>
        envVar === 'OPENAI_API_KEY' ? 'openai-key' : undefined,
    }));
    const { RealtimeProviderCache: WarmCache3 } = await import('./factory');
    const cache = new WarmCache3();

    cache.prime({ config: warmConfig });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstCandidate = (cache as any).cached;

    cache.prime({ config: warmConfig });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const secondCandidate = (cache as any).cached;

    // Os dois candidates são objetos distintos: um novo foi criado no segundo prime
    expect(secondCandidate).not.toBe(firstCandidate);
    expect(cache.consume()!.id).toBe('openai');
    vi.doUnmock('../../voice/voice-secrets');
  });
});
