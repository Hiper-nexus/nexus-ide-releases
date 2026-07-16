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
  version: '0.17.0',
  date: '2026-07-16',
  codename: 'Oh My Pi',
  summary:
    'O motor de código open-source oh-my-pi (MIT) entra no cockpit: pane de agente tipado sem PTY-scraping, edição por hash, companion criptografado ponta a ponta, memória compartilhada entre CLIs e failover com cooldown por tier — código maduro vendorado, não reescrito.',
  highlights: [
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
      title: 'Release metadata alinhada',
      detail:
        'Package, server, lockfile, changelog e release notes ficam na mesma versão 0.17.0, corrigindo a inconsistência de versão deixada por um release anterior incompleto.',
    },
  ],
};
