import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadStoreInTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-voice-config-'));
  vi.resetModules();
  vi.doMock('node:os', () => ({
    default: { homedir: () => home, tmpdir: os.tmpdir },
    homedir: () => home,
    tmpdir: os.tmpdir,
  }));
  const store = await import('./voice-config-store');
  return { home, store };
}

describe('voice-config-store', () => {
  afterEach(() => {
    vi.doUnmock('node:os');
    vi.resetModules();
  });

  it('persiste jarvisLiveEnabled quando setConfig aplica patch parcial', async () => {
    const { home, store } = await loadStoreInTempHome();
    store.loadVoiceConfig();

    store.applyConfigPatch({ jarvisLiveEnabled: true });

    const file = path.join(
      home,
      '.nexus',
      'plugins',
      'voice',
      'nexus-voice.json',
    );
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      jarvisLive: { enabled: boolean };
    };
    expect(saved.jarvisLive.enabled).toBe(true);

    store.applyConfigPatch({ jarvisLiveEnabled: false });

    const updated = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      jarvisLive: { enabled: boolean };
    };
    expect(updated.jarvisLive.enabled).toBe(false);
  });

  it('default é realtime (grok-realtime) — Grok Voice é a rota oficial', async () => {
    const { store } = await loadStoreInTempHome();
    const config = store.loadVoiceConfig();
    expect(config.jarvisLive.transport).toBe('grok-realtime');
    // Versão explícita, nunca o alias `grok-voice-latest`: o alias migra
    // sozinho no provedor e trocaria a voz do produto sem decisão de ninguém.
    expect(config.jarvisLive.grokModel).toBe('grok-voice-think-fast-2.0');
    expect(config.jarvisLive.grokVoice).toBe('rex');
    // As rotas de degradação continuam configuradas e prontas.
    expect(config.jarvisLive.liveModel).toBe('gemini-3.1-flash-live-preview');
    expect(config.jarvisLive.voiceName).toBe('Charon');
    expect(config.jarvisLive.openaiVoice).toBe('ash');
  });

  it('migra a antiga voz padrão Gacrux para Charon sem trocar vozes customizadas', async () => {
    const { home, store } = await loadStoreInTempHome();
    const { DEFAULT_VOICE_CONFIG } = await import('../../shared/voice-config');
    const file = path.join(home, '.nexus', 'plugins', 'voice', 'nexus-voice.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: { ...DEFAULT_VOICE_CONFIG.jarvisLive, voiceName: 'Gacrux' },
      }),
    );

    expect(store.loadVoiceConfig().jarvisLive.voiceName).toBe('Charon');

    vi.resetModules();
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: { ...DEFAULT_VOICE_CONFIG.jarvisLive, voiceName: 'Sulafat' },
      }),
    );
    const reloaded = await import('./voice-config-store');
    expect(reloaded.loadVoiceConfig().jarvisLive.voiceName).toBe('Sulafat');
  });

  it('migra somente o modelo Gemini Live 2.5 legado para o 3.1', async () => {
    const { home, store } = await loadStoreInTempHome();
    const { DEFAULT_VOICE_CONFIG } = await import('../../shared/voice-config');
    const file = path.join(home, '.nexus', 'plugins', 'voice', 'nexus-voice.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          transport: 'openai-realtime',
          liveModel: 'gemini-2.5-flash-native-audio-preview-12-2025',
        },
      }),
    );

    const loaded = store.loadVoiceConfig();
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      jarvisLive: { transport: string; liveModel: string };
    };
    expect(loaded.jarvisLive.liveModel).toBe('gemini-3.1-flash-live-preview');
    expect(saved.jarvisLive.liveModel).toBe('gemini-3.1-flash-live-preview');
    expect(saved.jarvisLive.transport).toBe('openai-realtime');
  });

  it('preserva um modelo Gemini Live customizado pelo usuário', async () => {
    const { home, store } = await loadStoreInTempHome();
    const { DEFAULT_VOICE_CONFIG } = await import('../../shared/voice-config');
    const file = path.join(home, '.nexus', 'plugins', 'voice', 'nexus-voice.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...DEFAULT_VOICE_CONFIG,
        jarvisLive: {
          ...DEFAULT_VOICE_CONFIG.jarvisLive,
          liveModel: 'gemini-live-custom',
        },
      }),
    );

    expect(store.loadVoiceConfig().jarvisLive.liveModel).toBe('gemini-live-custom');
  });

  it('preserva o transporte escolhido pelo usuário (validador, sem coerção)', async () => {
    const { store } = await loadStoreInTempHome();
    store.loadVoiceConfig();
    const openai = store.applyConfigPatch({ jarvisLiveTransport: 'openai-realtime' });
    expect(openai.jarvisLive.transport).toBe('openai-realtime');
    const classic = store.applyConfigPatch({ jarvisLiveTransport: 'classic' });
    expect(classic.jarvisLive.transport).toBe('classic');
    const gemini = store.applyConfigPatch({ jarvisLiveTransport: 'gemini-live' });
    expect(gemini.jarvisLive.transport).toBe('gemini-live');
    const grok = store.applyConfigPatch({ jarvisLiveTransport: 'grok-realtime' });
    expect(grok.jarvisLive.transport).toBe('grok-realtime');
  });

  it('ITEM 5: sempre expõe GEMINI/OPENAI (keys do realtime) mesmo sem estar no brain/stt/tts', async () => {
    const { home, store } = await loadStoreInTempHome();
    const { DEFAULT_VOICE_CONFIG } = await import('../../shared/voice-config');
    const file = path.join(home, '.nexus', 'plugins', 'voice', 'nexus-voice.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Brain reduzido a groq-only (o caso "pre-groq" do incidente): sem GEMINI no chain.
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          ...DEFAULT_VOICE_CONFIG,
          jarvisBrain: {
            provider: 'groq',
            endpoint: 'https://api.groq.com/openai/v1/chat/completions',
            auth: { type: 'api_key', envVar: 'GROQ_API_KEY' },
            model: 'llama-3.1-8b-instant',
            jsonMode: true,
          },
        },
        null,
        2,
      ),
    );
    store.loadVoiceConfig();

    const info = store.buildRuntimeInfo();
    const envVars = info.keys.map((k) => k.envVar);
    expect(envVars).toContain('GEMINI_API_KEY');
    expect(envVars).toContain('OPENAI_API_KEY');
    // E o store aceita gravar a GEMINI key (gate do realtime resolve depois).
    expect(store.knownVoiceEnvVars().has('GEMINI_API_KEY')).toBe(true);
  });

  it('migra TTS OpenAI nova para a voz realtime padrao', async () => {
    const { home, store } = await loadStoreInTempHome();
    const { DEFAULT_VOICE_CONFIG } = await import('../../shared/voice-config');
    const file = path.join(
      home,
      '.nexus',
      'plugins',
      'voice',
      'nexus-voice.json',
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          ...DEFAULT_VOICE_CONFIG,
          jarvisLive: {
            ...DEFAULT_VOICE_CONFIG.jarvisLive,
            enabled: true,
            transport: 'openai-realtime',
          },
          tts: {
            ...DEFAULT_VOICE_CONFIG.tts,
            voice: 'nova',
          },
        },
        null,
        2,
      ),
    );

    const loaded = store.loadVoiceConfig();
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      tts: { voice: string };
    };

    expect(loaded.tts.voice).toBe('ash');
    expect(saved.tts.voice).toBe('ash');
  });

  it('injeta o Gemini na cabeça do STT uma vez, preservando a cadeia do usuário', async () => {
    const { home, store } = await loadStoreInTempHome();
    const { DEFAULT_VOICE_CONFIG, DEFAULT_WHISPER_STT } = await import(
      '../../shared/voice-config'
    );
    const file = path.join(home, '.nexus', 'plugins', 'voice', 'nexus-voice.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Config no formato ANTERIOR à chegada do Gemini: head = groq.
    fs.writeFileSync(
      file,
      JSON.stringify(
        { ...DEFAULT_VOICE_CONFIG, stt: DEFAULT_WHISPER_STT },
        null,
        2,
      ),
    );

    const providers = (head: unknown): string[] => {
      const out: string[] = [];
      let node = head as { provider?: string; fallback?: unknown } | undefined;
      while (node?.provider) {
        out.push(node.provider);
        node = node.fallback as typeof node;
      }
      return out;
    };

    const loaded = store.loadVoiceConfig();
    // O Gemini lidera e a cadeia Whisper que o usuário já tinha segue abaixo.
    expect(providers(loaded.stt)).toEqual([
      'gemini',
      'groq',
      'openai',
      'local-whisper',
    ]);

    // Reler não duplica o link injetado.
    const again = store.loadVoiceConfig();
    expect(providers(again.stt)).toEqual([
      'gemini',
      'groq',
      'openai',
      'local-whisper',
    ]);
  });

  it('preserva o modo CHAT do usuário ao instalar o Gemini', async () => {
    const { home, store } = await loadStoreInTempHome();
    const { DEFAULT_VOICE_CONFIG, DEFAULT_WHISPER_STT } = await import(
      '../../shared/voice-config'
    );
    const file = path.join(home, '.nexus', 'plugins', 'voice', 'nexus-voice.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          ...DEFAULT_VOICE_CONFIG,
          // Cadeia de fábrica, mas com o ditado em CHAT (português literal).
          stt: { ...DEFAULT_WHISPER_STT, outputMode: 'portuguese', translate: false },
        },
        null,
        2,
      ),
    );

    const loaded = store.loadVoiceConfig();
    // `outputMode` é lido SÓ do head. Herdar o default do Gemini viraria o
    // ditado de volta para CODE — e como o arquivo é reescrito na migração, a
    // perda da preferência seria permanente.
    expect(loaded.stt.provider).toBe('gemini');
    expect(loaded.stt.outputMode).toBe('portuguese');
    expect(loaded.stt.translate).toBe(false);
  });

  it('não atropela um head escolhido de propósito (offline/privacidade)', async () => {
    const { home, store } = await loadStoreInTempHome();
    const { DEFAULT_VOICE_CONFIG } = await import('../../shared/voice-config');
    const file = path.join(home, '.nexus', 'plugins', 'voice', 'nexus-voice.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          ...DEFAULT_VOICE_CONFIG,
          stt: {
            type: 'stt',
            provider: 'local-whisper',
            localBin: 'whisper-cli',
            model: 'base',
            translate: true,
            language: 'pt',
            outputMode: 'english',
          },
        },
        null,
        2,
      ),
    );

    const loaded = store.loadVoiceConfig();
    // Quem fixou o head em local-whisper pediu para o áudio NÃO sair da
    // máquina. Promover o Gemini por cima mandaria a fala dessa pessoa para o
    // Google sem ela ter pedido — e a chave dele costuma existir, porque o
    // Gemini também é o brain padrão.
    expect(loaded.stt.provider).toBe('local-whisper');
  });
});
