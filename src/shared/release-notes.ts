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
  version: '0.10.6',
  date: '2026-07-07',
  codename: 'Jarvis te ouve',
  summary:
    'A causa raiz da "Jarvis surda" foi corrigida: o controle automático de ganho do Chromium achataba o sinal do microfone USB perto de zero — o sistema ouvia, o app recebia silêncio. Agora o stream do wake word capta o áudio cru e a Jarvis finalmente acorda ao seu chamado.',
  highlights: [],
  fixes: [
    {
      title: 'Jarvis finalmente ouve o microfone',
      detail:
        'O autoGainControl (ligado por padrão no Chromium) esmagava o sinal de microfones USB sensíveis, e os frames chegavam mudos mesmo com permissão concedida. As três opções de processamento de áudio foram desligadas no stream do wake word (que quer PCM limpo), e o eco é controlado pela pausa que já existe enquanto a Jarvis fala.',
    },
    {
      title: 'Diagnóstico de microfone no log',
      detail:
        'O wake agora registra qual dispositivo de áudio o app realmente capturou e o nível (RMS) do primeiro frame — prova definitiva de que o sinal chegou, em vez de ficar só "não funciona".',
    },
  ],
};
