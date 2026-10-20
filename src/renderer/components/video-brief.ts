import {
  VIDEO_EXPORT_PRESETS,
  type VideoExportPresetId,
} from '../../shared/video-export-presets';

/**
 * Brief of "Novo vídeo de apresentação" (F-1596): what the person fills in
 * the Estúdio becomes the first prompt of the agent opened by the "+ Pane".
 * Pure, so the wording is tested. The agent does the work with the
 * `nexus-video` skill; the brief only states the job and the cost rule.
 */

export type BriefVoice =
  | { readonly kind: 'mine'; readonly voiceId: string; readonly name: string }
  | { readonly kind: 'library' }
  | { readonly kind: 'none' };

export interface PresentationBriefInput {
  readonly product: string;
  readonly siteUrl?: string;
  readonly audience?: string;
  readonly style?: string;
  readonly durationSec: number;
  readonly preset: VideoExportPresetId;
  readonly voice: BriefVoice;
  readonly music: boolean;
}

const clean = (value: string | undefined, max: number): string =>
  (value ?? '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max);

export function normalizeSiteUrl(raw: string | undefined): string | null {
  const text = clean(raw, 500);
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(text) ? text : `https://${text}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function voiceLine(voice: BriefVoice): string {
  if (voice.kind === 'mine') {
    return `Voz: a minha voz "${clean(voice.name, 60)}" (voice_id ${voice.voiceId}, criada em Minha voz com consentimento). Use só ela.`;
  }
  if (voice.kind === 'library') {
    return 'Voz: uma voz de biblioteca da ElevenLabs. Liste com nexus_voice_list e me pergunte qual usar antes de narrar.';
  }
  return 'Voz: sem narração. O texto vai na tela, com o tempo de leitura de cada cena.';
}

export function buildPresentationBrief(input: PresentationBriefInput): string {
  const preset = VIDEO_EXPORT_PRESETS[input.preset];
  const site = normalizeSiteUrl(input.siteUrl);
  const lines = [
    'Crie um vídeo motion de apresentação do produto abaixo com o estúdio de vídeo do Nexus. ' +
      'Carregue a skill nexus-video e siga o fluxo dela.',
    '',
    `Produto: ${clean(input.product, 1_500)}`,
    site
      ? `Site para capturar (cores, fontes, telas): ${site}`
      : 'Sem site: use a descrição acima e me peça prints se precisar.',
  ];
  const audience = clean(input.audience, 300);
  if (audience) lines.push(`Público: ${audience}`);
  const style = clean(input.style, 300);
  if (style) lines.push(`Estilo: ${style}`);
  lines.push(
    `Duração: cerca de ${Math.round(input.durationSec)} s · Formato: ${preset.label} (${preset.width}×${preset.height}, preset ${preset.id})`,
    voiceLine(input.voice),
    input.music
      ? 'Música: instrumental de fundo com nexus_music_generate, na duração da narração.'
      : 'Música: sem música.',
    '',
    'Antes de gastar: me mostre o roteiro e o custo (narração com dryRun, música e qualquer clipe ou imagem gerado por IA) e espere o meu ok.',
    `Entrega: o MP4 de nexus_video_render exportado por nexus_video_export no preset ${preset.id}, ` +
      'com a lista do que declarar ao publicar.',
  );
  return lines.join('\n');
}
