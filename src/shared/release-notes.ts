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

export const PREVIOUS_RELEASE: AppRelease = {
  version: '0.19.11',
  date: '2026-07-17',
  codename: 'Rota Livre',
  summary:
    'Fim dos becos sem saída de missão: pane que morre 3 vezes seguidas vira estado terminal com causa acionável em vez de churnar para sempre, e drift de contexto pós-freeze ganhou rota de recuperação com a tool de refreeze do contrato — preservando objetivo e critérios.',
  highlights: [
    {
      title: 'Fim do loop de respawn',
      detail:
        'Após 3 respawns consecutivos sem progresso a missão para com diagnóstico claro (verifique login/credencial do adapter e use Retomar no rail).',
    },
    {
      title: 'Refreeze de contrato após drift',
      detail:
        'Mudou o contexto depois do freeze? nexus_mission_refreeze_contract recongela na mesma missão, com piso de risco e ledger auditável.',
    },
  ],
  fixes: [],
};
