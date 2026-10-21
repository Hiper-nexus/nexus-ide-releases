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

/** O que cada anexo é para o vídeo; o agente trata cada papel de um jeito. */
export type BriefAttachmentRole = 'logo' | 'mascot' | 'example-video' | 'screenshot' | 'other';

export const BRIEF_ATTACHMENT_ROLES: readonly BriefAttachmentRole[] = [
  'logo',
  'mascot',
  'example-video',
  'screenshot',
  'other',
];

export const BRIEF_ATTACHMENT_ROLE_LABEL: Readonly<Record<BriefAttachmentRole, string>> = {
  logo: 'Logo',
  mascot: 'Mascote',
  'example-video': 'Vídeo de exemplo',
  screenshot: 'Print do sistema',
  other: 'Outra imagem',
};

const ROLE_INSTRUCTION: Readonly<Record<BriefAttachmentRole, string>> = {
  logo: 'use na abertura e no fecho; copie para assets/ e não redesenhe nem recolora',
  mascot: 'personagem fixo do vídeo; mantenha o desenho e as cores, sem inventar outra versão',
  'example-video':
    'referência de ritmo, cortes, transições e estilo; estude com ffprobe e quadros extraídos e NÃO copie o conteúdo, o texto nem a música dele',
  screenshot: 'tela real do produto; use nas cenas de demonstração, sem alterar',
  other: 'imagem de apoio; use onde fizer sentido',
};

export interface BriefAttachment {
  readonly role: BriefAttachmentRole;
  /** Caminho relativo ao projeto, dentro de `media/referencias/`. */
  readonly storageKey: string;
  readonly name: string;
}

/** Papel provável pelo nome e pelo tipo; a pessoa troca na lista. */
export function guessAttachmentRole(name: string, isVideo: boolean): BriefAttachmentRole {
  if (isVideo) return 'example-video';
  const lower = name.toLowerCase();
  if (/logo|marca|brand/u.test(lower)) return 'logo';
  if (/mascote|mascot|personagem|character/u.test(lower)) return 'mascot';
  if (/print|screen|tela|captura|screenshot/u.test(lower)) return 'screenshot';
  return 'other';
}

/**
 * Teto de cada campo do brief, num lugar só: o formulário do Estúdio e este
 * construtor leem a MESMA tabela. Antes havia dois números soltos (o
 * `maxLength` do campo e o `clean()` daqui) e o texto era cortado calado nos
 * dois — um roteiro de 1.800 caracteres virava 1.500 sem aviso nenhum, e o
 * render saía errado pagando API. Quem mexer num teto aqui mexe nos dois
 * lados de uma vez; `pending-brief` prova que o brief montado ainda cabe.
 *
 * O produto cabe um roteiro de verdade: narração de 90 s com direção de cena
 * passa de 2.000 caracteres com folga.
 */
export const BRIEF_FIELD_LIMITS = {
  product: 6_000,
  siteUrl: 500,
  audience: 600,
  style: 1_200,
} as const;

export type BriefFieldName = keyof typeof BRIEF_FIELD_LIMITS;

/** Quantos anexos entram no brief; o resto fica de fora (e a UI avisa). */
export const BRIEF_MAX_ATTACHMENTS = 20;

/** Teto do caminho de cada anexo dentro da linha do brief. */
export const BRIEF_ATTACHMENT_KEY_MAX = 240;

/**
 * Quanto passou do teto, para o campo dizer o número exato. 0 = cabe.
 * Conta os caracteres crus que a pessoa vê no campo, não os do brief
 * montado: é esse número que ela precisa apagar.
 */
export function briefFieldOverflow(value: string, field: BriefFieldName): number {
  return Math.max(0, value.length - BRIEF_FIELD_LIMITS[field]);
}

export interface PresentationBriefInput {
  readonly product: string;
  readonly siteUrl?: string;
  readonly audience?: string;
  readonly style?: string;
  readonly durationSec: number;
  readonly preset: VideoExportPresetId;
  readonly voice: BriefVoice;
  readonly music: boolean;
  readonly attachments?: readonly BriefAttachment[];
}

const clean = (value: string | undefined, max: number): string =>
  (value ?? '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max);

export function normalizeSiteUrl(raw: string | undefined): string | null {
  const text = clean(raw, BRIEF_FIELD_LIMITS.siteUrl);
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
    `Produto: ${clean(input.product, BRIEF_FIELD_LIMITS.product)}`,
    site
      ? `Site para capturar (cores, fontes, telas): ${site}`
      : 'Sem site: use a descrição acima e me peça prints se precisar.',
  ];
  const audience = clean(input.audience, BRIEF_FIELD_LIMITS.audience);
  if (audience) lines.push(`Público: ${audience}`);
  const style = clean(input.style, BRIEF_FIELD_LIMITS.style);
  if (style) lines.push(`Estilo: ${style}`);
  const attachments = (input.attachments ?? []).slice(0, BRIEF_MAX_ATTACHMENTS);
  if (attachments.length > 0) {
    lines.push(
      '',
      'Anexos que eu trouxe (arquivos do projeto; copie os que forem entrar no vídeo para a pasta assets/ do projeto de vídeo):',
      ...attachments.map(
        (item) =>
          `- ${BRIEF_ATTACHMENT_ROLE_LABEL[item.role]}: ${clean(item.storageKey, BRIEF_ATTACHMENT_KEY_MAX)} (${ROLE_INSTRUCTION[item.role]})`,
      ),
      '',
    );
  }
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
