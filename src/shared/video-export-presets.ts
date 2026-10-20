/**
 * Export presets per network (F-1595). Pure data + ffmpeg argument building,
 * shared by Main (export) and renderer (Estúdio, checklist). Study of
 * 19/10/2026, §1.1 (step 8) and §2.5 (labels per platform).
 */

export type VideoExportPresetId = 'vertical-9x16' | 'youtube-16x9' | 'linkedin-16x9' | 'square-1x1';

export interface SafeArea {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface VideoExportPreset {
  readonly id: VideoExportPresetId;
  readonly label: string;
  readonly networks: readonly PublishNetwork[];
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** Peak video bitrate cap for x264 (the platforms re-encode anyway). */
  readonly maxRateKbps: number;
  /** Where essential text may go: outside it the network UI covers the frame. */
  readonly safeArea: SafeArea;
}

export type PublishNetwork = 'instagram-reels' | 'youtube-shorts' | 'tiktok' | 'youtube' | 'linkedin' | 'facebook-feed';

/** Loudness target of the exports: -14 LUFS integrated, -1 dBTP peak. */
export const EXPORT_LOUDNESS = { integratedLufs: -14, truePeakDb: -1, lra: 11 } as const;

export const VIDEO_EXPORT_PRESETS: Readonly<Record<VideoExportPresetId, VideoExportPreset>> = {
  'vertical-9x16': {
    id: 'vertical-9x16',
    label: 'Reels, Shorts e TikTok (9:16)',
    networks: ['instagram-reels', 'youtube-shorts', 'tiktok'],
    width: 1080,
    height: 1920,
    fps: 30,
    maxRateKbps: 12_000,
    // The 25/09 Nexus reel kept text in x ∈ [64, 900], y ∈ [250, 1480].
    safeArea: { left: 64, top: 250, right: 900, bottom: 1480 },
  },
  'youtube-16x9': {
    id: 'youtube-16x9',
    label: 'YouTube (16:9)',
    networks: ['youtube'],
    width: 1920,
    height: 1080,
    fps: 30,
    maxRateKbps: 16_000,
    safeArea: { left: 96, top: 54, right: 1824, bottom: 1026 },
  },
  'linkedin-16x9': {
    id: 'linkedin-16x9',
    label: 'LinkedIn (16:9)',
    networks: ['linkedin'],
    width: 1920,
    height: 1080,
    fps: 30,
    maxRateKbps: 10_000,
    safeArea: { left: 96, top: 54, right: 1824, bottom: 1026 },
  },
  'square-1x1': {
    id: 'square-1x1',
    label: 'Feed quadrado (1:1)',
    networks: ['facebook-feed', 'linkedin'],
    width: 1080,
    height: 1080,
    fps: 30,
    maxRateKbps: 10_000,
    safeArea: { left: 64, top: 64, right: 1016, bottom: 1016 },
  },
};

export const VIDEO_EXPORT_PRESET_IDS = Object.keys(VIDEO_EXPORT_PRESETS) as VideoExportPresetId[];

export const AI_VOICE_LABEL = 'Narração com voz gerada por IA';

/** IPTC Digital Source Type codes (cv.iptc.org/newscodes/digitalsourcetype). */
export const DIGITAL_SOURCE_TYPE = {
  trained: 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia',
  composite: 'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia',
} as const;

export interface PublishChecklistItem {
  readonly network: PublishNetwork;
  readonly title: string;
  readonly steps: readonly string[];
}

const NETWORK_TITLE: Record<PublishNetwork, string> = {
  'instagram-reels': 'Instagram Reels',
  'youtube-shorts': 'YouTube Shorts',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  'facebook-feed': 'Facebook',
};

/**
 * What to declare when publishing (study §2.5, read 19/10/2026). It is a
 * reminder for the person who publishes: the Nexus never posts for them.
 */
export function publishChecklist(
  networks: readonly PublishNetwork[],
  synthetic: { readonly voice: boolean; readonly clonedVoice: boolean; readonly music: boolean },
): PublishChecklistItem[] {
  const unique = [...new Set(networks)];
  return unique.map((network) => {
    const steps: string[] = [];
    if (network === 'youtube' || network === 'youtube-shorts') {
      steps.push(
        synthetic.clonedVoice || synthetic.voice
          ? 'Narração na sua própria voz clonada ou voz de biblioteca não exige a marcação de "conteúdo alterado ou sintético"; marque se a voz imitar outra pessoa real.'
          : 'Sem voz sintética: nada a declarar sobre a narração.',
      );
      if (synthetic.music) steps.push('Se a música gerada por IA for o foco do vídeo, marque "conteúdo alterado ou sintético".');
    } else if (network === 'instagram-reels' || network === 'facebook-feed') {
      if (synthetic.voice) steps.push('Ative o rótulo "Informações de IA" ao publicar: a Meta exige declarar áudio realista criado por IA.');
    } else if (network === 'tiktok') {
      if (synthetic.voice) steps.push('Ative "Conteúdo gerado por IA" ao publicar: o TikTok exige rotular áudio realista gerado por IA.');
    } else if (network === 'linkedin') {
      if (synthetic.voice) steps.push('Diga no texto do post que a narração é gerada por IA.');
    }
    if (synthetic.voice) {
      steps.push('Na União Europeia (AI Act, art. 50), quem publica voz sintética realista avisa de forma visível: o rótulo do export cobre a primeira exibição.');
    }
    steps.push('Suba também o arquivo .srt de legenda que acompanha o export.');
    return { network, title: NETWORK_TITLE[network], steps };
  });
}

/** Escape a literal for an ffmpeg filter option value inside single quotes. */
export function ffmpegFilterText(text: string): string {
  return text.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'").replace(/:/gu, '\\:').replace(/%/gu, '\\%');
}

export interface ExportVideoFilterInput {
  readonly preset: VideoExportPreset;
  /** Burn the AI label: fontfile is a bare file name (ffmpeg runs in the font folder). */
  readonly label?: { readonly text: string; readonly fontFile: string; readonly seconds: number } | null;
}

/** Scale to fit, pad to the preset, square pixels, constant frame rate, optional label. */
export function exportVideoFilter(input: ExportVideoFilterInput): string {
  const { width, height, fps, safeArea } = input.preset;
  const parts = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    `fps=${fps}`,
  ];
  if (input.label) {
    const fontSize = Math.round(Math.min(width, height) / 30);
    const enable = input.label.seconds > 0 ? `:enable='lt(t,${input.label.seconds})'` : '';
    parts.push(
      `drawtext=fontfile=${input.label.fontFile}:text='${ffmpegFilterText(input.label.text)}'` +
        `:x=${safeArea.left}:y=${safeArea.top}:fontsize=${fontSize}:fontcolor=white` +
        `:box=1:boxcolor=black@0.55:boxborderw=${Math.round(fontSize / 2.5)}${enable}`,
    );
  }
  parts.push('format=yuv420p');
  return parts.join(',');
}

export function loudnormFilter(measured?: {
  readonly input_i: string;
  readonly input_tp: string;
  readonly input_lra: string;
  readonly input_thresh: string;
  readonly target_offset: string;
}): string {
  const base = `loudnorm=I=${EXPORT_LOUDNESS.integratedLufs}:TP=${EXPORT_LOUDNESS.truePeakDb}:LRA=${EXPORT_LOUDNESS.lra}`;
  if (!measured) return `${base}:print_format=json`;
  return (
    `${base}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}` +
    `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}` +
    `:offset=${measured.target_offset}:linear=true:print_format=summary`
  );
}

/** The JSON block loudnorm prints at the end of the first pass. */
export function parseLoudnormJson(stderr: string): {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
} | null {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(stderr.slice(start, end + 1)) as Record<string, unknown>;
    const keys = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'] as const;
    if (!keys.every((key) => typeof parsed[key] === 'string' && Number.isFinite(Number(parsed[key])))) return null;
    return Object.fromEntries(keys.map((key) => [key, parsed[key] as string])) as ReturnType<typeof parseLoudnormJson> & object;
  } catch {
    return null;
  }
}

/** `ebur128` summary of the output: integrated loudness and true peak. */
export function parseEbur128Summary(stderr: string): { integratedLufs: number; truePeakDb: number | null } | null {
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const integrated = /I:\s+(-?[\d.]+)\s+LUFS/u.exec(summary);
  if (!integrated) return null;
  const peak = /Peak:\s+(-?[\d.]+|-inf)\s+dBFS/u.exec(summary);
  return {
    integratedLufs: Number(integrated[1]),
    truePeakDb: peak && peak[1] !== '-inf' ? Number(peak[1]) : null,
  };
}
