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
  codename: 'Direct Operations & Voice Reliability',
  summary:
    'Jarvis separa operações diretas de missões e fecha falhas de voz do app empacotado e de handoff realtime.',
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
    {
      title: 'Microfone confiável no app instalado',
      detail:
        'Wake e captura carregam o worklet PCM por blob compatível com a CSP, sem fallback silencioso para o processador lento.',
    },
    {
      title: 'Realtime coerente entre provedores',
      detail:
        'A rota OpenAI recebe as mesmas ferramentas curtas de consultar e ler usadas pela rota Gemini.',
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
      title: 'Sem chamada de voz pendurada',
      detail:
        'Durante handoff ou encerramento, a chamada realtime recebe erro explícito em vez de deixar o modelo aguardando sem resposta.',
    },
    {
      title: 'Release consistente',
      detail:
        'Aplicativo, servidor, lockfile, changelog e notas internas avançam juntos para impedir releases mistos.',
    },
  ],
};
