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
  version: '0.8.2',
  date: '2026-07-06',
  codename: 'JARVIS operacional',
  summary:
    'A JARVIS foi refeita por dentro para nunca mais morrer em silêncio: deadline em toda chamada de rede, microfone do wake que se reconstrói sozinho, retomada de turno travado e barge-in que cala qualquer voz. O HUD dela agora é compacto, arrastável, ancora nos cantos, minimiza numa pill e tem modo só-áudio. E ela fecha panes e abre o Ops Board por voz.',
  highlights: [
    {
      title: 'JARVIS que não morre',
      detail:
        'Toda borda do pipeline de voz (STT, cérebro, TTS, whisper/piper locais) ganhou deadline duro com fallback falado. Um socket pendurado, um provider mudo ou um subprocesso travado não seguram mais a assistente — ela erra em voz alta e volta a ouvir.',
    },
    {
      title: 'Microfone do wake imortal',
      detail:
        'Trocar de AirPods ou acordar o Mac matava o stream do "Hey Jarvis" em silêncio. Agora há watchdog de frames, reconstrução automática com backoff e aviso visível se esgotar — nada de surdez muda.',
    },
    {
      title: 'HUD arrastável, mini e só-áudio',
      detail:
        'O painel da JARVIS encolheu (300px), é arrastável pelo cabeçalho com âncora no canto mais próximo, redimensiona pela alça lateral, minimiza numa pill e pode sumir de vez no modo só-áudio — a voz continua 100%. Posição e modo ficam salvos.',
    },
    {
      title: 'Novos comandos de voz',
      detail:
        '"Fecha esse terminal" (close_pane) e "abre o quadro" (open_board) viraram ações reais. E quando um comando de shell precisa de confirmação, ela avisa em voz que o diálogo está na tela.',
    },
    {
      title: 'Uma instância por vez no wake',
      detail:
        'Rodar o app instalado e o dev juntos fazia as duas JARVIS responderem ao mesmo chamado. Um lock por processo garante uma dona única do "Hey Jarvis".',
    },
    {
      title: 'Ícones pixel refinados',
      detail:
        'Legibilidade dos ícones do toolbar/deck/board revisada (grade 10px), botão visível do Ops Board e estados do quadro polidos.',
    },
  ],
  fixes: [
    {
      title: 'Respostas curtas não são mais engolidas',
      detail:
        'O filtro anti-alucinação do Whisper descartava "valeu", "oi" e "tchau" mesmo em conversa ativa — agora ele é consciente de contexto e só corta lixo de verdade.',
    },
    {
      title: 'Barge-in cala o fallback de voz',
      detail:
        'Quando a fala saía pelo `say` do sistema, chamar a JARVIS não interrompia o áudio — agora o chamado mata a fala na hora, sem vozes sobrepostas.',
    },
    {
      title: 'Acks não censuram você',
      detail:
        'Os "Sim?" e "Deixa comigo." dela entravam na janela anti-eco e podiam descartar sua resposta seguinte por parecer eco. Saíram da janela.',
    },
    {
      title: 'App não congela em transcrição local',
      detail:
        'whisper.cpp e piper rodavam de forma síncrona no processo principal, travando todo o app durante a síntese/transcrição. Viraram assíncronos com timeout.',
    },
  ],
};
