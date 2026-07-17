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
  version: '0.19.16',
  date: '2026-07-17',
  codename: 'Modelo que Você Escolhe',
  summary:
    'O modelo que você seleciona no squad é o modelo que roda. A seleção podia oferecer um id que o CLI não executa (ex.: gpt-5.6 depois de a OpenAI renomear para gpt-5.6-sol/-luna/-terra) e o CLI caía silenciosamente no default. Agora o roteador e o spawn resolvem o modelo contra a lista real do CLI e nunca emitem um fantasma. Também: colar print (⌘V) nas evidências e o Operador vivo (gamificação).',
  highlights: [
    {
      title: 'Modelo fantasma nunca mais',
      detail:
        'Roteador e spawn resolvem o id escolhido para a variante real da família (gpt-5.6 → gpt-5.6-sol); vale para roster do squad, route_task e squads salvos.',
    },
    {
      title: 'Colar print nas evidências (⌘V)',
      detail:
        'Cole um screenshot direto no compositor de objetivo e ele vira anexo — sem passar pelo Finder.',
    },
    {
      title: 'Operador vivo',
      detail:
        'XP por turnos de agente e feedback visual do progresso do operador.',
    },
  ],
  fixes: [],
};

export const PREVIOUS_RELEASE: AppRelease = {
  version: '0.19.15',
  date: '2026-07-17',
  codename: 'Login sem Terminal',
  summary:
    'O painel OMP·RPC ganhou a seção Contas: todos os provedores de assinatura que o omp suporta (Claude Pro/Max, ChatGPT, Gemini CLI, Copilot…) com status de conexão e login feito inteiro pelo app — a autorização abre no navegador e a credencial grava no cofre do omp. Antes, só zai/glm aparecia e logar exigia rodar `omp auth-broker login` num terminal.',
  highlights: [
    {
      title: 'Login OAuth sem sair do painel',
      detail:
        'Conectar → o navegador abre na página do provedor → autorizou, acabou. O fluxo roda no main com cancelamento e timeout, e o segredo da sonda de status nunca toca o heap do Nexus.',
    },
    {
      title: 'Dropdown de modelos atualiza na hora',
      detail:
        'Ao concluir o login, os modelos do provedor entram no seletor sem reiniciar a sessão — consumindo seu plano de assinatura, não API key.',
    },
    {
      title: 'Mais API keys do vault chegam ao omp',
      detail:
        'OPENAI, GEMINI, XAI, GROQ, CEREBRAS e MISTRAL agora também são injetadas no processo do omp a partir do providers.conf.',
    },
  ],
  fixes: [],
};

