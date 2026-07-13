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
  version: '0.15.5',
  date: '2026-07-13',
  codename: 'Direct Operations',
  summary:
    'Jarvis agora distingue operações diretas de missões: sincronização Git segura não abre squad, pane, terminal ou Doctor.',
  highlights: [
    {
      title: 'Sincronização Git direta',
      detail:
        '“Atualizar repositório com GitHub” executa uma pré-checagem local e só avança a branch por fast-forward validado.',
    },
    {
      title: 'Intenção antes de orquestração',
      detail:
        'Pedidos de sincronização chegam à operação Git auditada em vez de receber contrato, Doctor, prompt gigante ou squad.',
    },
    {
      title: 'Recibos falados reais',
      detail:
        'A Jarvis informa atualizado, já atualizado ou bloqueado com o motivo sem afirmar progresso por suposição.',
    },
  ],
  fixes: [
    {
      title: 'Sem push implícito',
      detail:
        'A operação nunca faz stage, commit, rebase, push ou merge de histórico divergente.',
    },
    {
      title: 'Bloqueio preserva alterações',
      detail:
        'Arquivos rastreados alterados, ausência de upstream, divergência ou colisão local retornam bloqueio sem mudar o checkout.',
    },
    {
      title: 'Autoridade estreita',
      detail:
        'Somente a rota renderer do usuário pode disparar essa operação; agentes MCP não recebem esse atalho antes de uma missão.',
    },
    {
      title: 'Release consistente',
      detail:
        'Aplicativo, servidor, lockfile, changelog e notas internas avançam juntos para impedir releases mistos.',
    },
  ],
};
