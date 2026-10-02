/**
 * Motivos categóricos pelos quais uma captura visual nunca sai da máquina.
 * A mensagem vai ao agente (PT-BR, sem dado da página): ele precisa saber por
 * que não houve julgamento, não o conteúdo que foi recusado.
 */
export type BrowserVisualRefusalCode = 'personal_profile' | 'mostly_masked' | 'unverifiable_geometry';

const MESSAGES: Readonly<Record<BrowserVisualRefusalCode, string>> = {
  personal_profile:
    'Esta aba usa o perfil pessoal, com os logins reais do operador. O julgamento visual só roda em abas isoladas; nada foi capturado nem enviado.',
  mostly_masked:
    'Quase toda a página precisaria ser ocultada por conter campos, segredos ou mídia, então a captura não tem valor e nada foi enviado.',
  unverifiable_geometry:
    'Não foi possível confirmar onde ficam as áreas sensíveis na imagem, então nada foi enviado.',
};

export class BrowserVisualRefusal extends Error {
  readonly code: BrowserVisualRefusalCode;
  constructor(code: BrowserVisualRefusalCode) {
    super(MESSAGES[code]);
    this.name = 'BrowserVisualRefusal';
    this.code = code;
  }
}
