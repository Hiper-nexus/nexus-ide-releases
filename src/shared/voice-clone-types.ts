/**
 * "Minha voz" (F-1593): cloning the operator's OWN voice, by the human only.
 *
 * Shared between Main (which verifies and creates) and the renderer (which
 * shows the texts and records). There is no MCP path to any of this: the
 * channels below are registered with `handleTrusted` and the agent tools can
 * only list and use voices (study 2026-10-19 §5.2.4).
 */

/** Bump when the consent wording changes: receipts record which one was read. */
export const VOICE_CONSENT_VERSION = '2026-10-19.1';

export const VOICE_CLONE_CHANNELS = {
  list: 'voiceClone:list',
  begin: 'voiceClone:begin',
  verifyDeclaration: 'voiceClone:verifyDeclaration',
  create: 'voiceClone:create',
  cancel: 'voiceClone:cancel',
  remove: 'voiceClone:remove',
} as const;

/** Recording limits (seconds). The IVC guide asks for 1 to 2 minutes, never above 3. */
export const VOICE_DECLARATION_MIN_SEC = 4;
export const VOICE_DECLARATION_MAX_SEC = 40;
export const VOICE_SAMPLE_MIN_SEC = 60;
export const VOICE_SAMPLE_MAX_SEC = 180;

/**
 * What the person consents to, shown before anything is recorded. LGPD art.
 * 11, I: specific and highlighted consent for sensitive (biometric) data.
 */
export const VOICE_CONSENT_POINTS: readonly string[] = [
  'A sua voz é dado biométrico (dado pessoal sensível na LGPD). Ela só será usada para criar uma voz sintética sua, na SUA conta da ElevenLabs, para narrar os seus vídeos.',
  'As gravações vão para a ElevenLabs, que cria a voz. O Nexus guarda neste computador só o recibo e a gravação da declaração, como prova do seu consentimento.',
  'Só clone a sua própria voz. A ElevenLabs proíbe clonar outra pessoa sem consentimento e voz de menor de 18 anos.',
  'Você pode apagar a voz a qualquer momento: o Nexus remove a voz na ElevenLabs e apaga o recibo e a gravação deste computador.',
  'Vídeos publicados com a voz sintética devem dizer que a narração é gerada por IA; o Nexus põe esse rótulo no export.',
];

/** The sentence the person reads aloud; STT must hear the name, age, authorization and code. */
export function voiceDeclarationText(speakerName: string, code: string): string {
  const spaced = code.split('').join(' ');
  return (
    `Eu, ${speakerName.trim()}, sou maior de 18 anos e autorizo a criação de uma voz sintética ` +
    `a partir da minha própria voz, para narrar os meus vídeos. Código ${spaced}.`
  );
}

/**
 * Reading for the voice sample (~1 min 30 s at a calm pace). Varied phonetics
 * of Brazilian Portuguese: nasal vowels, "lh", "nh", "rr", "ç", stress shifts.
 */
export const VOICE_READING_TEXT =
  'Toda boa apresentação começa com um problema que a pessoa reconhece na hora. ' +
  'Depois vem a solução, mostrada sem pressa, com exemplos simples e números honestos. ' +
  'Neste vídeo, eu explico como o nosso produto organiza o trabalho da equipe, ' +
  'reduz retrabalho e deixa cada etapa visível, do primeiro rascunho até a entrega. ' +
  'Imagine uma manhã de segunda-feira: a caixa de entrada cheia, três reuniões seguidas ' +
  'e um prazo que não espera ninguém. É justamente aí que a ferramenta certa faz diferença. ' +
  'Ela junta as conversas, os arquivos e as decisões num lugar só, e avisa quando algo precisa da sua atenção. ' +
  'Nada de planilhas espalhadas nem de mensagens perdidas no meio do caminho. ' +
  'Os resultados aparecem rápido: menos horas gastas procurando informação, ' +
  'mais tempo para o que realmente importa, que é cuidar dos clientes e melhorar o produto. ' +
  'Se você quer ver isso funcionando, acesse o nosso site, faça um teste gratuito ' +
  'e conte para a gente o que achou. Obrigado por assistir, e até o próximo vídeo.';

export interface VoiceCloneSessionView {
  readonly sessionId: string;
  /** Six random digits; read one by one in the declaration. */
  readonly code: string;
  readonly consentVersion: string;
  readonly readingText: string;
  readonly expiresAt: number;
}

export type VoiceDeclarationMissing = 'nome' | 'idade' | 'autorização' | 'código';

export type VoiceDeclarationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** What STT did not hear; empty when the failure is not about content. */
      readonly missing: readonly VoiceDeclarationMissing[];
      readonly error: string;
    };

export interface VoiceCloneReceiptView {
  readonly id: string;
  readonly provider: 'elevenlabs';
  readonly voiceId: string;
  readonly voiceName: string;
  readonly createdAt: string;
  /** ElevenLabs asked for an extra verification on its site before using the voice. */
  readonly requiresVerification: boolean;
}

export type VoiceCloneCreateResult =
  | { readonly ok: true; readonly receipt: VoiceCloneReceiptView }
  | { readonly ok: false; readonly error: string };

export type VoiceCloneRemoveResult =
  | { readonly ok: true; readonly removedAtProvider: boolean }
  | { readonly ok: false; readonly error: string; readonly canRemoveLocally: boolean };

export interface VoiceCloneApi {
  list(): Promise<VoiceCloneReceiptView[]>;
  begin(): Promise<VoiceCloneSessionView | { ok: false; error: string }>;
  verifyDeclaration(input: {
    sessionId: string;
    speakerName: string;
    wav: Uint8Array;
  }): Promise<VoiceDeclarationResult>;
  create(input: {
    sessionId: string;
    voiceName: string;
    samples: Uint8Array[];
  }): Promise<VoiceCloneCreateResult>;
  cancel(sessionId: string): Promise<{ ok: true }>;
  remove(input: { id: string; localOnly?: boolean }): Promise<VoiceCloneRemoveResult>;
}
