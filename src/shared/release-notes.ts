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
  version: '0.19.4',
  date: '2026-07-16',
  codename: 'Paridade Viva',
  summary:
    'O modo Design ganha emulação mobile de verdade (o site serve o layout de celular, não só a largura), a camada forge liga GitLab MR e o "PR desta branch" no painel, e o instalador 1-clique passa a cobrir agy, kimi e grok com canais oficiais verificados — 8 das 9 CLIs instalam pelo app.',
  highlights: [
    {
      title: 'Modo mobile de verdade',
      detail:
        'O breakpoint 📱 emula um iPhone (user agent + métricas) com reload — menu hambúrguer e media queries reais. ⛶ restaura o navegador normal.',
    },
    {
      title: 'Forge multi-provider',
      detail:
        'GitHub e GitLab criam PR/MR pelo mesmo caminho autorizado e auditado; o painel mostra o PR aberto da branch atual, clicável. Token GitLab via glab CLI ou NEXUS_GITLAB_TOKEN.',
    },
    {
      title: 'Instalador cobre quase tudo',
      detail:
        'agy (instalador oficial do Google, baixado por HTTPS sem pipe), kimi (brew/npm oficiais) e grok (npm oficial xAI) entram no 1-clique com confirmação nativa.',
    },
  ],
  fixes: [
    {
      title: 'Painéis não abrem mais atrás das Configurações',
      detail:
        'Ativar OMP RPC/Memória/Configs com o drawer aberto fecha o drawer primeiro — o clique deixa de parecer morto.',
    },
    {
      title: 'OMP RPC explica a morte',
      detail:
        'Saída com código ≠0 mostra o motivo real (ex.: sem /login) e oferece abrir o omp no terminal para autenticar.',
    },
  ],
};

export const PREVIOUS_RELEASE: AppRelease = {
  version: '0.19.3',
  date: '2026-07-16',
  codename: 'Operacional para o Cliente',
  summary:
    'Cada fricção de operador do 0.19.2 virou fluxo funcional: conta por login dispara o auth do provider no navegador, CLIs ausentes se instalam com um clique pela fonte oficial, GitHub funciona sem setup via sessão do gh, o Kimi K3 (e todo modelo novo que a CLI conhecer) aparece sozinho, e o modo Design ganhou erros legíveis, desligamento que nunca falha e preview mobile sempre visível.',
  highlights: [
    {
      title: 'Entrar com nova conta — de verdade',
      detail:
        'Adicionar conta por assinatura abre um terminal já rodando o login da CLI (claude /login, codex login, grok, kimi, opencode, agy) — o navegador abre na página do provider e depois é só Salvar no vault.',
    },
    {
      title: 'Máquina fresca fica operacional pelo app',
      detail:
        'Provider ausente ganha "Instalar automaticamente" com confirmação nativa mostrando o comando exato, só de fontes oficiais (npm/brew). O painel OMP instala o omp e reinicia a sessão sozinho.',
    },
    {
      title: 'GitHub sem setup',
      detail:
        'Sem PAT, o Nexus usa a sessão do gh CLI já autenticada — PRs e issues listam e criam na hora; o token nunca é persistido pelo app.',
    },
    {
      title: 'Modelos novos aparecem sozinhos',
      detail:
        'Kimi K3 no catálogo e descoberta viva: Atualizar modelos pergunta à própria CLI o que ela conhece — sem esperar release do Nexus.',
    },
  ],
  fixes: [
    {
      title: 'Modo Design confiável',
      detail:
        'Desligar nunca mais falha em página ocupada, erros viram texto acionável com tooltip e o preview responsivo (📱 375 / ▯ 768 / 🖥 1440) fica sempre visível na barra do browser.',
    },
    {
      title: 'Metadata de release consistente',
      detail:
        'Notas internas e versão do servidor acompanham o pacote — o invariante furado no bump anterior agora é coberto pela suíte.',
    },
  ],
};
