import { describe, expect, it } from 'vitest';
import {
  exportVideoFilter,
  ffmpegFilterText,
  loudnormFilter,
  parseEbur128Summary,
  parseLoudnormJson,
  publishChecklist,
  VIDEO_EXPORT_PRESETS,
} from './video-export-presets';

describe('presets por rede', () => {
  it('vertical 1080x1920 30 fps com a área segura do reel de 25/09', () => {
    expect(VIDEO_EXPORT_PRESETS['vertical-9x16']).toMatchObject({
      width: 1080,
      height: 1920,
      fps: 30,
      networks: ['instagram-reels', 'youtube-shorts', 'tiktok'],
      safeArea: { left: 64, top: 250, right: 900, bottom: 1480 },
    });
    for (const preset of Object.values(VIDEO_EXPORT_PRESETS)) {
      expect(preset.safeArea.right).toBeLessThanOrEqual(preset.width);
      expect(preset.safeArea.bottom).toBeLessThanOrEqual(preset.height);
    }
  });
});

describe('filtros do ffmpeg', () => {
  it('encaixa, preenche, fixa fps e yuv420p; rótulo só na área segura pelo tempo pedido', () => {
    const filter = exportVideoFilter({
      preset: VIDEO_EXPORT_PRESETS['vertical-9x16'],
      label: { text: 'Narração com voz gerada por IA', fontFile: 'segoeui.ttf', seconds: 6 },
    });
    expect(filter).toContain('scale=1080:1920:force_original_aspect_ratio=decrease');
    expect(filter).toContain('pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black');
    expect(filter).toContain('fps=30');
    expect(filter).toContain("drawtext=fontfile=segoeui.ttf:text='Narração com voz gerada por IA':x=64:y=250");
    expect(filter).toContain("enable='lt(t,6)'");
    expect(filter.endsWith('format=yuv420p')).toBe(true);
    expect(exportVideoFilter({ preset: VIDEO_EXPORT_PRESETS['youtube-16x9'] })).not.toContain('drawtext');
    expect(
      exportVideoFilter({
        preset: VIDEO_EXPORT_PRESETS['square-1x1'],
        label: { text: 'x', fontFile: 'a.ttf', seconds: 0 },
      }),
    ).not.toContain('enable=');
  });

  it('escapa o que o ffmpeg leria como sintaxe', () => {
    expect(ffmpegFilterText("a:b 'c' 50% \\")).toBe("a\\:b \\'c\\' 50\\% \\\\");
  });

  it('loudnorm: 1ª passada mede, 2ª aplica a medição em modo linear', () => {
    expect(loudnormFilter()).toBe('loudnorm=I=-14:TP=-1:LRA=11:print_format=json');
    const second = loudnormFilter({ input_i: '-23.1', input_tp: '-4.2', input_lra: '6.0', input_thresh: '-33.5', target_offset: '0.3' });
    expect(second).toContain('measured_I=-23.1:measured_TP=-4.2');
    expect(second).toContain('offset=0.3:linear=true');
  });

  it('lê o JSON do loudnorm no fim do stderr', () => {
    const stderr = `[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-23.10",\n\t"input_tp" : "-4.20",\n\t"input_lra" : "6.00",\n\t"input_thresh" : "-33.50",\n\t"output_i" : "-14.0",\n\t"target_offset" : "0.30"\n}`;
    expect(parseLoudnormJson(stderr)).toEqual({
      input_i: '-23.10',
      input_tp: '-4.20',
      input_lra: '6.00',
      input_thresh: '-33.50',
      target_offset: '0.30',
    });
    expect(parseLoudnormJson('sem json')).toBeNull();
  });

  it('lê o resumo do ebur128', () => {
    const stderr = 'Summary:\n\n  Integrated loudness:\n    I:         -14.0 LUFS\n    Threshold: -24.1 LUFS\n\n  True peak:\n    Peak:       -1.0 dBFS';
    expect(parseEbur128Summary(stderr)).toEqual({ integratedLufs: -14, truePeakDb: -1 });
    expect(parseEbur128Summary('nada')).toBeNull();
  });
});

describe('checklist de publicação', () => {
  it('Meta e TikTok pedem declarar voz sintética; YouTube dispensa a própria voz clonada', () => {
    const items = publishChecklist(['instagram-reels', 'tiktok', 'youtube-shorts'], { voice: true, clonedVoice: true, music: false });
    const byNetwork = Object.fromEntries(items.map((item) => [item.network, item.steps.join(' ')]));
    expect(byNetwork['instagram-reels']).toMatch(/Informações de IA/u);
    expect(byNetwork.tiktok).toMatch(/Conteúdo gerado por IA/u);
    expect(byNetwork['youtube-shorts']).toMatch(/não exige/u);
    expect(byNetwork['youtube-shorts']).not.toMatch(/música gerada por IA/u);
    expect(items.every((item) => item.steps.some((step) => step.includes('.srt')))).toBe(true);
  });

  it('sem voz sintética, nada de rótulo de IA', () => {
    const [meta] = publishChecklist(['instagram-reels'], { voice: false, clonedVoice: false, music: false });
    expect(meta.steps.join(' ')).not.toMatch(/IA/u);
  });
});
