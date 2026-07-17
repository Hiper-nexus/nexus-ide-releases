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

export const PREVIOUS_RELEASE: AppRelease = {
  version: '0.19.14',
  date: '2026-07-17',
  codename: 'Sem Freio de Mão',
  summary:
    'Missões não travam mais por "orçamento de tokens esgotado": aquele teto era um contador sintético (estimativas fictícias por tool, não a conta real do provider) e derrubava missões ainda no bootstrap. Agora o ledger só registra — quem protege contra desgoverno são os limites reais: driver da missão, PREVC e workers vivos.',
  highlights: [
    {
      title: 'Fim do bloqueio por tokens fictícios',
      detail:
        'O contrato de intenção continua auditando passos e gasto estimado, mas nenhuma tool é negada por isso. Missões já travadas por orçamento destravam sozinhas no próximo passo.',
    },
  ],
  fixes: [],
};
