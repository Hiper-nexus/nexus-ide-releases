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

export const PREVIOUS_RELEASE: AppRelease = {
  version: '0.19.1',
  date: '2026-07-16',
  codename: 'Oh My Pi — na tela',
  summary:
    'Endurece a 0.19 após review senior adversarial: o inbox de agentes deixa de mentir "concluído" em todo respawn e volta a abrir (não era mais recortado pela barra), o Labs em Configurações, e desligar a flag do companion agora derruba de fato o relay ativo. A segunda leva do crossover Oh My Pi — memória, inventário de configs, preço no seletor de modelo, companion criptografado — segue operacional na tela.',
  highlights: [
    {
      title: 'Inbox de agentes correto e visível',
      detail:
        'O sininho de notificações não dispara mais "CONCLUÍDO" falso ao reabrir um workspace (boot/respawn deixou de contar como turno) e o painel voltou a aparecer — antes era 100% recortado pela barra de status. Foco devolvido ao sino ao fechar, anúncio para leitor de tela e ícone de sino próprio.',
    },
    {
      title: 'Labs endurecido',
      detail:
        'Desligar a flag do companion com uma sessão ativa agora encerra o relay na hora; overrides sobrevivem a falha de disco (rollback) e a downgrades; só a janela do app altera flags; e o modo de força de dogfood nunca mais vaza para o arquivo de overrides.',
    },
    {
      title: 'Painel de Memória do workspace',
      detail:
        'Um drawer mostra os fatos, decisões e preferências que os agentes registram no projeto: estatísticas por tipo, busca instantânea (recall FTS5) com navegação por teclado, e estados vazio/desligado claros. A memória agentic compartilhada entre CLIs deixou de ser só uma tool sem tela.',
    },
    {
      title: 'Inventário de configs por workspace',
      detail:
        'Um painel mostra o que cada CLI enxerga neste workspace — MCP servers, regras, skills e comandos de .claude, .cursor, .codex, AGENTS.md e GEMINI.md — agrupado por ecossistema de origem, com conflitos de nome destacados e segredos nunca materializados.',
    },
    {
      title: 'Preço e janela no seletor de modelo',
      detail:
        'Ao compor uma missão, cada modelo mostra um selo discreto com janela de contexto e preço por milhão de tokens — a base de centenas de modelos do crossover finalmente visível onde a decisão acontece.',
    },
    {
      title: 'Companion mobile com tela e QR',
      detail:
        'Configurações → Sistema → Companion mobile inicia/para o relay criptografado ponta a ponta, exibe o QR de pareamento e os links de controle e somente-leitura, com aviso de segurança — e o output dos panes já flui para o dispositivo. O transporte E2E que existia sem interface agora se opera pela tela.',
    },
    {
      title: 'Drawers direitos que não se atropelam',
      detail:
        'Orquestração, pane omp e memória passam a ser mutuamente exclusivos no slot direito — abrir um fecha o outro — acabando com painéis empilhados que escondiam o de baixo sem sinal.',
    },
    {
      title: 'Perfil de design no motor automático',
      detail:
        'A Carta de Design ganha direção estética (Auto/Minimalista/Brutalista/Soft) e dials 1–10 de ousadia, motion e densidade em Configurações → Squads. Neutro não injeta nada; extremos viram instrução explícita para os workers de UI.',
    },
    {
      title: 'Anotações no Design Mode',
      detail:
        'Com um elemento selecionado, "＋ anotar" fixa uma nota com intenção (corrigir/mudar/pergunta/aprovado) e badge numerado na própria página; o tray copia o feedback consolidado ou envia tudo de uma vez ao agente, com as notas do usuário nunca cortadas por orçamento de prompt.',
    },
    {
      title: 'Pane omp de primeira classe (sem PTY-scraping)',
      detail:
        'O oh-my-pi roda via protocolo RPC tipado sobre pipes: estado busy/idle determinístico, streaming, custo e contexto ao vivo, e troca de modelo cross-provider no meio da conversa. Aprovações sempre passam pelo host, com trilha de auditoria fail-closed.',
    },
    {
      title: 'Edição por hash de conteúdo (hashline)',
      detail:
        'O editor ganha um patch bus que ancora cada mudança no hash do arquivo: patch multi-arquivo é all-or-nothing, âncora obsoleta é rejeitada antes de corromper, e a recuperação falha fechada. Disponível a qualquer agente pela tool nexus_editor_apply_patch.',
    },
    {
      title: 'Companion mobile criptografado ponta a ponta',
      detail:
        'O transporte novo do companion usa relay cego com AES-256-GCM: a chave viaja só no fragmento do QR e o servidor nunca vê o conteúdo. View-only vê o estado, comandos que mutam a máquina ficam no desktop — a política de segurança do companion continua sendo a autoridade.',
    },
    {
      title: 'Memória agentic compartilhada entre CLIs',
      detail:
        'retain/recall/stats sobre SQLite FTS5, com banco por workspace e um global do usuário. Todas as CLIs hospedadas passam a lembrar fatos do projeto entre sessões, com redação de segredo e deduplicação.',
    },
    {
      title: 'Failover com cooldown por tier',
      detail:
        'Um limite semanal do Fable não tira mais a conta do Sonnet: os blocos de cooldown ganham escopo por família de modelo, o failover espera a conta-irmã que libera em segundos em vez da janela de horas, e a conta volta ao pool sozinha.',
    },
    {
      title: 'Catálogo de modelos com preço e janela',
      detail:
        'Uma base vendorada de centenas de modelos dá preço por milhão de tokens, janela de contexto e capacidades para tudo que o Nexus roteia — incluindo GLM/z.ai, DeepSeek, Sakana Fugu e OpenRouter.',
    },
    {
      title: 'Descoberta universal de configs de agente',
      detail:
        'O Nexus inventaria MCP servers, regras, skills e comandos de .claude, .cursor, .codex, AGENTS.md e GEMINI.md com prioridades e deduplicação, sem materializar segredos do ambiente.',
    },
    {
      title: 'Squad de review com prioridades P0–P3',
      detail:
        'Um squad builtin distribui revisores read-only por localidade e entrega achados tipados com prioridade P0–P3, confiança e âncoras de linha — verdito claro sobre o que bloqueia release.',
    },
    {
      title: 'Detecção de rate-limit mais fina',
      detail:
        'O detector distingue quota esgotada de um pico transitório: um "too many requests" passageiro entra em cooldown curto e não queima a conta-irmã, com padrões multilíngues do ecossistema oh-my-pi somados aos existentes.',
    },
    {
      title: 'omp como CLI hospedada no grid',
      detail:
        'O oh-my-pi aparece no picker de agentes como qualquer outra CLI, com o servidor MCP do Nexus injetado por HOME-overlay privado — login e sessões do usuário preservados, o bearer isolado por sessão.',
    },
  ],
  fixes: [
    {
      title: 'Companion resiste a frame malicioso',
      detail:
        'Um guest view-only não derruba mais a sessão do host com um frame indecifrável: o host descarta o quadro em vez de encerrar, e só o próprio guest com chave errada trata a falha como definitiva.',
    },
    {
      title: 'Texto em pt-BR e emoji sem corrupção no pane omp',
      detail:
        'A leitura do protocolo RPC preserva caracteres multibyte que caem no limite de um chunk do pipe, então acentos e emoji não viram caractere de substituição nem corrompem argumentos de ferramenta.',
    },
    {
      title: 'Autoridade de contexto read-only respeitada por patch',
      detail:
        'O gate de missão passa a extrair os caminhos de dentro de um patch hashline, então o invariante de .context/ somente-leitura para executores não pode ser furado por uma edição via patch.',
    },
    {
      title: 'Inventário de configs não materializa segredo',
      detail:
        'A descoberta de configs não expande mais variáveis de ambiente ao montar o inventário read-only, mantendo o template literal e nunca resolvendo um segredo do processo para a interface.',
    },
    {
      title: 'Memória livre em pane sem missão',
      detail:
        'A tool de memória agentic ganhou uma exceção estreita para funcionar em panes livres, sem abrir escrita não-ligada a missão para nenhuma outra ferramenta.',
    },
    {
      title: 'Design Mode sem estado fantasma',
      detail:
        'Anotações e design bar resetam juntos por um caminho único de invalidação — navegação real, rota SPA, crash do renderer da página e troca de workspace — acabando com a barra "ON" fantasma após reload; o sync de badges enfileirado não congela mais as ações do tray.',
    },
    {
      title: 'Release metadata alinhada',
      detail:
        'Package, server, lockfile, changelog e release notes ficam na mesma versão 0.19.0, com a segunda leva de UI do crossover reconciliada sobre a 0.18.0.',
    },
  ],
};
