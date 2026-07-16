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


export const PREVIOUS_RELEASE: AppRelease = {
  version: '0.19.2',
  date: '2026-07-16',
  codename: 'Orquestração Destravada',
  summary:
    'Auditoria senior sobre o runtime real corrigiu a cadeia inteira que fazia toda missão morrer no bootstrap de contexto, o falso "não logado" nos panes do Claude, o bloqueio permanente do workspace no seletor de pasta — e entregou o restyle visual que estava preso fora do main (onboarding centrado com presença, chips no rail, GitHub na barra).',
  highlights: [
    {
      title: 'Missões passam do bootstrap',
      detail:
        'O reviewer independente de contexto deixou de ser bloqueado pelo gate, o Nexus computa os hashes de fonte sozinho (agente não precisa de tool de hash) e review em andamento não é mais tratado como timeout. Drafts aprovam, contrato congela, workers trabalham.',
    },
    {
      title: 'Panes do Claude sem /login fantasma',
      detail:
        'A identidade OAuth nativa agora viaja para o HOME efêmero dos panes gated (e login fresco feito dentro do pane é resgatado no teardown). GLM/LongCat continuam isolados da conta nativa.',
    },
    {
      title: 'Workspace não trava mais no seletor',
      detail:
        'Pasta apagada e recriada no mesmo caminho não gera mais "checkout id collision" permanente — o registro se auto-cura para o mesmo path e segue fail-closed para paths diferentes.',
    },
    {
      title: 'Visual novo de verdade',
      detail:
        'Onboarding Bridge-inspired centrado com a presença endorfinada, chips de meta no rail de missões, GitHub inline na barra do workspace, notificações sem nome cortado e gpt-5.6 nos tiers altos do roteador.',
    },
  ],
  fixes: [
    {
      title: 'Review de contexto não morre mais em timeout',
      detail:
        'O pane revisor continua vivo após a janela de poll e a tool reporta "pendente" com instrução de acompanhamento em vez de falha.',
    },
    {
      title: 'Invariantes estruturadas com caminho sancionado',
      detail:
        'O doctor agora ensina exatamente como propor uma invariante observada de fontes reais (.context/nexus/invariants) com revisão independente — o bloqueio deixou de ser beco sem saída.',
    },
    {
      title: 'git_status em pasta que não é repositório',
      detail:
        'Raiz de workspace multi-projeto responde {isRepo:false} com orientação, em vez de "Git executable-config inspection failed".',
    },
  ],
};
