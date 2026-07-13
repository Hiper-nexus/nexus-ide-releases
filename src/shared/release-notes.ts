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
  version: '0.15.0',
  date: '2026-07-13',
  codename: 'Autopilot Fleet',
  summary:
    'Piloto automático confiável para squads e Pet Studio, terminais em tempo real, recuperação sem ações duplicadas e uma frota mais clara para operar.',
  highlights: [
    {
      title: 'Pet Studio direto ao resultado',
      detail:
        'Um squad dedicado cria o pet a partir da imagem, valida o pacote e o publica em Meus pets sem carregar o fluxo de desenvolvimento.',
    },
    {
      title: 'Piloto automático de verdade',
      detail:
        'Squads usam o modo autônomo nativo de cada CLI por padrão; confirmações manuais só voltam quando o usuário escolhe o modo seguro.',
    },
    {
      title: 'Frota em tempo real',
      detail:
        'Terminais acompanham a saída ao vivo, panes retomam sem duplicar comandos e cotas reais ajudam a decidir failover entre contas e providers.',
    },
  ],
  fixes: [
    {
      title: 'Avisos do companion',
      detail:
        'O pet atual avisa conclusão, falha e pedidos de intervenção, inclusive quando o evento acontece durante a inicialização da janela.',
    },
    {
      title: 'Doctor sem falso travamento',
      detail:
        'A supervisão usa atividade real do PTY, alerta uma vez e não fecha, reinicia nem reenvia comandos enquanto o agente continua trabalhando.',
    },
    {
      title: 'Inicialização e companion estáveis',
      detail:
        'O boot não bloqueia esperando o Keychain, e o pet preserva posição, visibilidade e click-through entre telas e reinicializações.',
    },
  ],
};
