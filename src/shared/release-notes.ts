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
  version: '0.10.32',
  date: '2026-07-08',
  codename: 'Jarvis Click Wake',
  summary:
    'A Jarvis ficou mais confiável no wake por clique: ela confirma que acordou e só então abre uma janela real de escuta para o comando.',
  highlights: [
    {
      title: 'Clique acorda de verdade',
      detail:
        'Ao clicar na Jarvis, o ACK audível toca primeiro e a captura do comando começa depois, evitando que a janela expire enquanto o TTS ainda está falando.',
    },
    {
      title: 'Mais tempo para falar',
      detail:
        'A janela mínima de escuta por clique subiu para 8 segundos e o limite total para 22 segundos, sem afetar o wake por voz.',
    },
    {
      title: 'Sessão live mais limpa',
      detail:
        'O fim de turno realtime agora também limpa a sessão MCP da Jarvis, reduzindo risco de permissão ficar pendurada entre interações.',
    },
  ],
  fixes: [
    {
      title: 'Sem capturar o próprio ACK no clique',
      detail:
        'O click wake não injeta mais pre-roll da fala de confirmação na captura do comando.',
    },
    {
      title: 'Regressão travada por teste',
      detail:
        'Novos testes garantem ACK antes da escuta no clique e limpeza MCP no encerramento live.',
    },
    {
      title: 'Paridade de sessão reforçada',
      detail:
        'A ponte live mantém o executor auditável e limpa concessões mesmo quando o turno foi conversacional.',
    },
  ],
};
