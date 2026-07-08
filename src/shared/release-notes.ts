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
  version: '0.10.31',
  date: '2026-07-08',
  codename: 'Jarvis Local STT',
  summary:
    'A Jarvis ganhou fallback local de transcrição mais confiável no macOS, preservando comandos em português quando os provedores de nuvem falham.',
  highlights: [
    {
      title: 'whisper.cpp encontrado pela GUI',
      detail:
        'O app agora procura o whisper.cpp nos caminhos comuns do Homebrew, mesmo quando aberto pelo Finder/Dock sem herdar o PATH do terminal.',
    },
    {
      title: 'Comandos locais em português',
      detail:
        'Quando o turno da Jarvis pede transcrição sem tradução, o fallback local respeita `language: pt` e não converte comandos para inglês.',
    },
    {
      title: 'Operação sem chave de STT',
      detail:
        'Com o binário e o modelo local instalados, a cadeia STT continua operacional mesmo se Groq/OpenAI estiverem sem chave, quota ou rede.',
    },
  ],
  fixes: [
    {
      title: 'Menos falha invisível no macOS',
      detail:
        'A busca explícita por `/opt/homebrew/bin/whisper-cli` e `/usr/local/bin/whisper-cli` evita fallback perdido em apps Electron iniciados fora do shell.',
    },
    {
      title: 'Prioridade do request corrigida',
      detail:
        'O `translate` vindo do turno agora tem precedência sobre a configuração do provider local, evitando tradução indevida em comandos da Jarvis.',
    },
    {
      title: 'Cobertura de STT reforçada',
      detail:
        'A suíte cobre os caminhos Homebrew do whisper.cpp e o contrato de idioma do fallback local.',
    },
  ],
};
