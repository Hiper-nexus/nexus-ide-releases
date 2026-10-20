import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildVoiceTools } from '../tools-voice';
import { effectPolicyForTool } from '../mcp-effect-policy';
import { testProjectScope } from './scope-fixture';

const mocks = vi.hoisted(() => ({
  workspaceRoot: vi.fn(() => ''),
  generateVoiceover: vi.fn(),
  listVoices: vi.fn(),
  resolveKey: vi.fn(() => 'xi-key' as string | undefined),
  recordUsage: vi.fn(),
  generateMusic: vi.fn(),
  align: vi.fn(),
  listGemini: vi.fn(),
  generateGemini: vi.fn(),
}));

vi.mock('../workspace-path', () => ({ resolveCwdForScope: mocks.workspaceRoot }));
vi.mock('../../media/voiceover', () => ({
  generateVoiceover: mocks.generateVoiceover,
  VOICEOVER_MAX_CHARS: 20_000,
}));
vi.mock('../../media/music-generation', () => ({
  generateMusic: mocks.generateMusic,
  MUSIC_MIN_MS: 3_000,
  MUSIC_MAX_MS: 600_000,
  MUSIC_MODELS: ['music_v2_5', 'music_v2', 'music_v1'],
  musicCostUsd: (lengthMs: number) => Number(((lengthMs / 60_000) * 0.15).toFixed(4)),
}));
vi.mock('../../media/elevenlabs-voices', () => ({ listElevenLabsVoices: mocks.listVoices }));
vi.mock('../../media/voiceover-align', () => ({
  alignVoiceover: mocks.align,
  ALIGN_AUDIO_EXTENSIONS: ['.wav', '.mp3'],
  PARAKEET_DOWNLOAD_MB: 639,
}));
vi.mock('../../video/video-runtime-deps', () => ({ videoRenderDeps: () => ({ userData: '/ud', pathValue: '/bin' }) }));
vi.mock('../../media/media-keys', () => ({ resolveMediaKey: mocks.resolveKey }));
vi.mock('electron', () => ({ app: { getPath: () => '/ud' } }));
vi.mock('../../media/voiceover-gemini', () => ({ generateGeminiVoiceover: mocks.generateGemini }));
vi.mock('../../media/voice-providers/gemini-voice', () => ({
  GEMINI_PREBUILT_VOICES: ['Kore', 'Puck'],
  listGeminiReplicatedVoices: mocks.listGemini,
}));
vi.mock('../../usage/media-usage-recorder', () => ({ recordMediaUsage: mocks.recordUsage }));

let workspace: string;
const ctx = { scope: testProjectScope(), role: 'worker' } as never;

function tool(name: string) {
  const found = buildVoiceTools().find((item) => item.name === name);
  if (!found) throw new Error(`tool ${name} ausente`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tools-voice-'));
  mocks.workspaceRoot.mockReturnValue(workspace);
  mocks.resolveKey.mockImplementation((def?: { id?: string }) => (def?.id === 'elevenlabs' ? 'xi-key' : undefined));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('ferramentas de voz', () => {
  it('listar vozes é leitura; narrar é efeito com confirmação', () => {
    expect(effectPolicyForTool('nexus_voice_list')).toBe('read-only');
    expect(effectPolicyForTool('nexus_voiceover_generate')).toBe('execution-effect');
    expect(tool('nexus_voiceover_generate').requiresConfirm).toBe(true);
  });

  it('nenhuma ferramenta de voz cria, clona ou apaga voz', () => {
    for (const { name, description } of buildVoiceTools()) {
      expect(name).not.toMatch(/clone|create|add|delete/u);
      expect(description).not.toMatch(/\/v1\/voices\/add/u);
    }
  });

  it('lista sem chave devolve o que fazer, sem rede', async () => {
    mocks.resolveKey.mockReturnValue(undefined);
    const result = await tool('nexus_voice_list').handler({}, ctx);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Serviços de mídia/u) });
    expect(mocks.listVoices).not.toHaveBeenCalled();
  });

  it('lista com chave devolve as vozes', async () => {
    mocks.listVoices.mockResolvedValue([{ voiceId: 'v1', origin: 'library' }]);
    const result = await tool('nexus_voice_list').handler({}, ctx);
    expect(result).toEqual({ ok: true, voices: [{ voiceId: 'v1', origin: 'library' }] });
    expect(mocks.listVoices.mock.calls[0][0]).toMatchObject({ key: 'xi-key' });
    expect(mocks.listGemini).not.toHaveBeenCalled();
  });

  it('com a chave do Google lista também as vozes do Gemini (F-1601)', async () => {
    mocks.resolveKey.mockImplementation((def?: { id?: string }) => (def?.id === 'google-image' ? 'gm-key' : undefined));
    mocks.listGemini.mockResolvedValue([{ id: 'voice_minha', displayName: 'Minha voz' }]);
    const result = await tool('nexus_voice_list').handler({}, ctx);
    expect(result).toEqual({
      ok: true,
      voices: [],
      gemini: {
        library: [
          { voiceId: 'Kore', name: 'Kore', origin: 'library' },
          { voiceId: 'Puck', name: 'Puck', origin: 'library' },
        ],
        replicated: [{ voiceId: 'voice_minha', name: 'Minha voz', origin: 'external-clone' }],
      },
    });
    expect(mocks.listVoices).not.toHaveBeenCalled();
    expect(mocks.listGemini.mock.calls[0][0]).toMatchObject({ key: 'gm-key' });
  });

  it('narração com provider gemini vai ao caminho do Gemini, com preço antes e o gasto registrado', async () => {
    mocks.resolveKey.mockImplementation((def?: { id?: string }) => (def?.id === 'google-image' ? 'gm-key' : undefined));
    mocks.generateGemini
      .mockResolvedValueOnce({ ok: true, dryRun: true, model: 'gemini-3.8-flash-tts', estimatedCostUsd: 0.01 })
      .mockResolvedValueOnce({
        ok: true,
        dryRun: false,
        model: 'gemini-3.8-flash-tts',
        estimatedCostUsd: 0.008,
        durationMs: 30_000,
        files: { audio: path.join(workspace, 'narration', 'narration.wav') },
      });
    const result = await tool('nexus_voiceover_generate').handler({ script: 'Olá.', voiceId: 'Kore', provider: 'gemini' }, ctx);
    expect(result).toMatchObject({ ok: true, estimatedCostUsd: 0.008 });
    expect(mocks.generateGemini.mock.calls.map((call) => call[0].dryRun)).toEqual([true, false]);
    expect(mocks.generateGemini.mock.calls[1][0]).toMatchObject({ script: 'Olá.', voice: 'Kore' });
    expect(mocks.generateVoiceover).not.toHaveBeenCalled();
    expect(mocks.recordUsage.mock.calls[0][0]).toMatchObject({ provider: 'google-image', kind: 'audio', estimatedCostUsd: 0.008 });
  });

  it('narra o roteiro inline no workspace do chamador e registra o gasto', async () => {
    mocks.generateVoiceover.mockResolvedValue({
      ok: true,
      dryRun: false,
      model: 'eleven_multilingual_v2',
      estimatedCostUsd: 0.05,
      durationMs: 1_000,
      files: { audio: path.join(workspace, 'narration', 'narration.mp3') },
    });
    await tool('nexus_voiceover_generate').handler(
      { script: 'Olá.', voiceId: 'v1', outDir: 'promo', voiceSettings: { speed: 1.1 } },
      ctx,
    );
    // F-1606: first the price (dryRun, no network), then the paid call.
    expect(mocks.generateVoiceover.mock.calls[0][0]).toMatchObject({ script: 'Olá.', dryRun: true });
    expect(mocks.generateVoiceover.mock.calls[1][0]).toMatchObject({
      script: 'Olá.',
      voiceId: 'v1',
      outDir: 'promo',
      baseDir: workspace,
      dryRun: false,
      voiceSettings: { speed: 1.1 },
    });
    expect(mocks.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'audio', provider: 'elevenlabs', estimatedCostUsd: 0.05 }),
      ctx,
      undefined,
    );
  });

  it('acerto total do cache não conta como geração nova', async () => {
    mocks.generateVoiceover.mockResolvedValue({
      ok: true,
      dryRun: false,
      model: 'm',
      estimatedCostUsd: 0,
      files: { audio: path.join(workspace, 'n.mp3') },
    });
    await tool('nexus_voiceover_generate').handler({ script: 'Olá.', voiceId: 'v1' }, ctx);
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it('lê o roteiro de um .txt do workspace e recusa outro tipo', async () => {
    fs.writeFileSync(path.join(workspace, 'roteiro.txt'), 'Texto do arquivo.');
    mocks.generateVoiceover.mockResolvedValue({ ok: true, dryRun: true, estimatedCostUsd: 0.01 });
    await tool('nexus_voiceover_generate').handler({ scriptPath: 'roteiro.txt', dryRun: true }, ctx);
    expect(mocks.generateVoiceover.mock.calls[0][0]).toMatchObject({ script: 'Texto do arquivo.', dryRun: true });
    await expect(
      tool('nexus_voiceover_generate').handler({ scriptPath: 'segredo.env' }, ctx),
    ).rejects.toThrow(/\.txt ou \.md/u);
    await expect(
      tool('nexus_voiceover_generate').handler({ script: 'a', scriptPath: 'roteiro.txt' }, ctx),
    ).rejects.toThrow(/não os dois/u);
  });

  it('roteiro fora do workspace é recusado', async () => {
    await expect(
      tool('nexus_voiceover_generate').handler({ scriptPath: '../fora.txt' }, ctx),
    ).rejects.toThrow(/escapa o workspace/u);
  });

  it('música é efeito com confirmação e repassa os argumentos', async () => {
    expect(effectPolicyForTool('nexus_music_generate')).toBe('execution-effect');
    expect(tool('nexus_music_generate').requiresConfirm).toBe(true);
    mocks.generateMusic.mockResolvedValue({
      ok: true,
      dryRun: false,
      model: 'music_v2_5',
      lengthMs: 45_000,
      estimatedCostUsd: 0.1125,
      path: path.join(workspace, 'music', 'a.mp3'),
    });
    await tool('nexus_music_generate').handler(
      { prompt: 'piano calmo', lengthMs: 45_000.4, instrumental: false, outPath: 'music/a.mp3' },
      ctx,
    );
    expect(mocks.generateMusic.mock.calls[0][0]).toMatchObject({
      prompt: 'piano calmo',
      lengthMs: 45_000,
      instrumental: false,
      outPath: 'music/a.mp3',
      baseDir: workspace,
    });
    expect(mocks.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'audio', estimatedCostUsd: 0.1125 }),
      ctx,
      undefined,
    );
  });

  it('música recusada pelo provedor volta como resultado, sem registro de gasto', async () => {
    mocks.generateMusic.mockResolvedValue({ ok: false, error: 'cita artista', promptSuggestion: 'synth pop' });
    const result = await tool('nexus_music_generate').handler({ prompt: 'x', lengthMs: 10_000 }, ctx);
    expect(result).toMatchObject({ ok: false, promptSuggestion: 'synth pop' });
    expect(mocks.recordUsage).not.toHaveBeenCalled();
    await expect(tool('nexus_music_generate').handler({ prompt: 'x' }, ctx)).rejects.toThrow(/lengthMs/u);
  });
});

describe('teto de gasto na narração e na música (F-1606)', () => {
  it('a narração é precificada (dryRun) e recusada pelo teto antes da chamada paga', async () => {
    const { MediaBudget, configureMediaBudget } = await import('../../media/media-budget');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-voice-budget-'));
    const budget = new MediaBudget(dir);
    budget.setLimits({ perDayUsd: 0.01, perMissionUsd: null });
    configureMediaBudget(budget);
    try {
      mocks.generateVoiceover.mockResolvedValue({ ok: true, dryRun: true, model: 'eleven_v4', estimatedCostUsd: 0.05 });
      const refused = await tool('nexus_voiceover_generate').handler({ script: 'Olá.', voiceId: 'v1' }, ctx);
      expect(refused).toMatchObject({ ok: false, budget: { limit: 'day', requestUsd: 0.05 } });
      expect(mocks.generateVoiceover).toHaveBeenCalledTimes(1);
      expect(mocks.generateVoiceover.mock.calls[0][0]).toMatchObject({ dryRun: true });
      const music = await tool('nexus_music_generate').handler({ prompt: 'lofi', lengthMs: 60_000 }, ctx);
      expect(music).toMatchObject({ ok: false, budget: { limit: 'day', requestUsd: 0.15 } });
      expect(mocks.generateMusic).not.toHaveBeenCalled();
    } finally {
      configureMediaBudget(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('alinhamento da narração gravada (F-1602)', () => {
  it('não cria voz, é efeito com confirmação, preço antes e o mesmo escopo do chamador', async () => {
    expect(effectPolicyForTool('nexus_voiceover_align')).toBe('execution-effect');
    expect(tool('nexus_voiceover_align').requiresConfirm).toBe(true);
    mocks.align
      .mockResolvedValueOnce({ ok: true, dryRun: true, engine: 'elevenlabs', durationSec: 30, estimatedCostUsd: 0.0018 })
      .mockResolvedValueOnce({ ok: true, dryRun: false, engine: 'elevenlabs', durationSec: 30, estimatedCostUsd: 0.0018, words: 80 });
    const result = await tool('nexus_voiceover_align').handler({ audioPath: 'promo/voz.wav', script: 'Olá.' }, ctx);
    expect(result).toMatchObject({ ok: true, words: 80 });
    expect(mocks.align.mock.calls[0][0]).toMatchObject({ audioPath: 'promo/voz.wav', script: 'Olá.', dryRun: true, baseDir: workspace });
    expect(mocks.align.mock.calls[1][0]).toMatchObject({ dryRun: false, allowModelDownload: false });
    await expect(tool('nexus_voiceover_align').handler({ script: 'Olá.' }, ctx)).rejects.toThrow(/audioPath/u);
    await expect(tool('nexus_voiceover_align').handler({ audioPath: 'a.wav', script: 'x', language: 'pt; rm' }, ctx)).rejects.toThrow(/language/u);
  });

  it('o pedido de baixar o modelo só segue com o OK explícito', async () => {
    mocks.align.mockResolvedValueOnce({ ok: false, needsModelDownload: true, error: 'baixa 639 MB' });
    expect(await tool('nexus_voiceover_align').handler({ audioPath: 'a.wav', script: 'x', engine: 'local' }, ctx)).toMatchObject({
      ok: false,
      needsModelDownload: true,
    });
    expect(mocks.align).toHaveBeenCalledTimes(1);
  });
});
