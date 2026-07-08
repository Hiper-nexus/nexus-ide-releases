export interface ReleaseNote {
  title: string;
  detail: string;
}

export interface AppRelease {
  version: string;
  date: string;
  codename: string;
  summary: string;
  highlights: ReleaseNote[];
  fixes: ReleaseNote[];
}

export const CURRENT_RELEASE: AppRelease = {
  version: '0.10.30',
  date: '2026-07-08',
  codename: 'Jarvis Operational Fallback',
  summary:
    'A Jarvis ficou mais resiliente quando modelos falham: ela mantém conversa local útil, silencia ruído curto e preserva ações de foco vindas do cérebro.',
  highlights: [
    {
      title: 'Fallback local operacional',
      detail:
        'Quando nenhuma chave/modelo responde, a Jarvis não despeja erro técnico: ela responde em português, mantém o turno aberto e sugere ações possíveis na tela atual.',
    },
    {
      title: 'Menos auto-conversa por ruído',
      detail:
        'Transcrições curtas típicas de ruído, como “ai ai” e ghosts de agradecimento, ficam silenciosas no fallback local em vez de reabrirem conversa sem necessidade.',
    },
    {
      title: 'Foco de pane completo',
      detail:
        'O cérebro Classic agora preserva ações para focar pane específico e pane anterior, alinhando parser, prompt e executor.',
    },
  ],
  fixes: [
    {
      title: 'Sem erro de chave falado ao usuário',
      detail:
        'O modo sem provedor de brain não cita variáveis internas de API na fala e não chama rede quando já sabe que não há credencial disponível.',
    },
    {
      title: 'Falha de provider vira conversa recuperável',
      detail:
        'Se um provider retorna erro ou rate limit, a Jarvis informa de forma breve que continua operando e pergunta o próximo comando.',
    },
    {
      title: 'Tokens de confirmação travados por teste',
      detail:
        'O fluxo de confirmação MCP agora tem cobertura explícita para escopo exato, consumo único e expiração de 30 segundos.',
    },
  ],
};
