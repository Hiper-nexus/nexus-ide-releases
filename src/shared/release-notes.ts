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
  version: '0.19.13',
  date: '2026-07-17',
  codename: 'Missão com Nome Próprio',
  summary:
    'Missão agêntica com squad reusado deixa de vestir a identidade da missão antiga: o título vem do SEU objetivo, o modelo escolhido na revisão do roster persiste até o spawn (adeus Fable virando opus sozinho) e as instruções do squad são reapontadas para o objetivo vigente antes do kickoff.',
  highlights: [
    {
      title: 'Título da missão é o seu objetivo',
      detail:
        'Reusar o roster salvo não renomeia mais a missão com o nome do squad antigo — a missão de dashboards chama-se dashboards, não "Clone Overclock".',
    },
    {
      title: 'Roster revisado é o roster que sobe',
      detail:
        'Eventos de quota/instalação não resetam mais suas edições na tela de revisão; o modelo do orquestrador que você escolheu é o que o pane usa.',
    },
  ],
  fixes: [],
};

export const PREVIOUS_RELEASE: AppRelease = {
  version: '0.19.12',
  date: '2026-07-17',
  codename: 'Instala de Verdade',
  summary:
    'Máquina nova fica operacional de verdade: o instalador 1-clique de CLIs cai automaticamente para canais oficiais alternativos quando falta Node ou Homebrew (omp ganhou o instalador oficial omp.sh), e acha o brew/npm mesmo quando o app foi aberto pelo Finder com PATH incompleto. Sem canal utilizável, o resumo diz exatamente o que instalar em vez de falhar em silêncio.',
  highlights: [
    {
      title: 'Instalador de CLIs com cascata de canais',
      detail:
        'Claude cai para o instalador nativo da Anthropic, Codex para o brew, omp para o instalador oficial do projeto — cada CLI tenta os canais oficiais na ordem até um funcionar nesta máquina.',
    },
    {
      title: 'Brew e npm encontrados fora do PATH do app',
      detail:
        'App GUI nem sempre herda o PATH do terminal; a instalação agora procura nos diretórios padrão (/opt/homebrew/bin, /usr/local/bin, ~/.local/bin) e executa pelo caminho absoluto.',
    },
  ],
  fixes: [],
};

