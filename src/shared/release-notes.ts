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
  version: '0.12.0',
  date: '2026-07-10',
  codename: 'Verified Context',
  summary:
    'O Nexus agora entende e verifica o contexto de cada projeto antes de executar efeitos: runtime e dados ficam isolados por checkout, e conclusão exige evidência compatível com a revisão e o diff atuais.',
  highlights: [
    {
      title: 'Contexto verificável antes do código',
      detail:
        'Conhecimento do domínio, contratos, contextRevision, sensores, PREVC e Review Council formam um gate nativo antes de efeitos e conclusão.',
    },
    {
      title: 'Runtime seguro por projeto',
      detail:
        'SQLite, stores, identidade, worktrees, cron e sync são escopados por projeto e checkout, com modo somente leitura quando a persistência degrada.',
    },
    {
      title: 'Nexus Doctor e release verificável',
      detail:
        'Readiness estruturado, smoke do app empacotado, SBOM, checksums e validação de assinatura/notarização tornam os bloqueios reproduzíveis.',
    },
  ],
  fixes: [
    {
      title: 'Sem conclusão por caminhos paralelos',
      detail:
        'Missões, handoffs e efeitos passam pelos mesmos gates de workflow, contexto, evidência e identidade do diff.',
    },
    {
      title: 'Jarvis isolada por janela e projeto',
      detail:
        'Ownership Live, wake/PTT, transcript, memória e callbacks tardios não atravessam outro renderer, projeto ou checkout.',
    },
    {
      title: 'Visão e ferramentas com menos vazamento',
      detail:
        'AX, OCR e resultados MCP recebem limites e redação única de segredos; Git e filesystem falham fechados diante de drift e configuração perigosa.',
    },
    {
      title: 'Atualização restrita à plataforma correta',
      detail:
        'O updater escolhe o ZIP do Mac compatível e fica indisponível em Linux/Windows até existir um mecanismo próprio para essas plataformas.',
    },
  ],
};
