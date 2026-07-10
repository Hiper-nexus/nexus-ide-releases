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
  version: '0.12.0',
  date: '2026-07-10',
  codename: 'Jarvis Realtime Proof',
  summary:
    'O diagnóstico Realtime da Jarvis agora só confirma sucesso quando o WebAudio do Nexus inicia a reprodução do chunk recebido, com roteamento de áudio explícito e fallback observável.',
  highlights: [
    {
      title: 'Prova real de áudio Realtime',
      detail:
        'Cada chunk PCM recebe um identificador do processo principal e o renderer só confirma o diagnóstico depois de agendá-lo no WebAudio.',
    },
    {
      title: 'Diagnóstico isolado',
      detail:
        'O teste reconecta a sessão Live antes de enviar a frase de prova, impedindo que áudio de uma resposta anterior dê falso positivo.',
    },
    {
      title: 'Saída de áudio honesta',
      detail:
        'Quando uma saída física escolhida não pode ser aplicada, o app mostra a falha em vez de tocar silenciosamente na saída padrão.',
    },
  ],
  fixes: [
    {
      title: 'Fim do falso “Realtime confirmado”',
      detail:
        'Receber PCM do provider não basta mais para deixar o diagnóstico verde: erro, cancelamento ou ausência de reprodução falham de forma explícita.',
    },
    {
      title: 'Eventos antigos isolados',
      detail:
        'Confirmações atrasadas, duplicadas ou de outra entrega não podem concluir um teste novo de voz.',
    },
    {
      title: 'Latência por turno',
      detail:
        'O log de métricas separa turnos de uma mesma sessão Live e descarta a amostra interrompida antes do barge-in.',
    },
    {
      title: 'Release multi-arquitetura preparado',
      detail:
        'O updater escolhe o ZIP compatível com Apple Silicon ou Intel, sem instalar payload de arquitetura errada.',
    },
  ],
};
