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
  version: '0.13.0',
  date: '2026-07-10',
  codename: 'Always Awake',
  summary:
    'O Nexus ganha runtime de agentes, forges e fundação remota, enquanto a Jarvis opera em Gemini Live com wake resiliente, voz natural e turnos protegidos contra eco, replay e ambiguidade.',
  highlights: [
    {
      title: 'Jarvis Live mais confiável',
      detail:
        'Wake acústico e textual trabalham juntos, STT travado perde a geração em quatro segundos, a conversa permanece quente e a voz Gemini Live padrão passa a ser Gacrux.',
    },
    {
      title: 'Runtime de agentes e diagnóstico',
      detail:
        'Hooks consentidos de Claude/Codex, keep-awake multiagente, breadcrumbs e recuperação de crash ligam atividade real do PTY ao runtime sem transformar status em evidência.',
    },
    {
      title: 'Forges e trabalho remoto com limites explícitos',
      detail:
        'GitHub/GitLab, terminal remoto, SSH e política de cliente móvel entram com escopo local, replay protegido e pareamento sobre TLS; criptografia E2E continua declaradamente pendente.',
    },
  ],
  fixes: [
    {
      title: 'Jarvis não conversa mais com a própria voz',
      detail:
        'Frames de microfone ficam retidos durante áudio local ou Live, o wake verificado ainda pode interromper a fala e o próximo turno só abre depois do drain real.',
    },
    {
      title: 'Comandos de voz menos ambíguos',
      detail:
        'A sessão Gemini recebe uma superfície curta de ferramentas de alto nível em vez de dezenas de schemas concorrentes; ações detalhadas continuam na fachada auditada.',
    },
    {
      title: 'Hooks privados e realmente conectados',
      detail:
        'Configs e backups preservam permissões privadas, e cada PTY recebe endpoint e chave de sessão próprios para publicar atividade no processo principal.',
    },
    {
      title: 'Remote sem replay nem injeção de shell',
      detail:
        'Frames repetidos deixam de executar comandos duas vezes e argumentos Git remotos são cotados individualmente sob uma allowlist de subcomandos.',
    },
    {
      title: 'Keep-awake preserva todos os agentes',
      detail:
        'Concluir um pane não apaga o estado de outros agentes trabalhando, e cancelar o diálogo de saída não desmonta mais a proteção contra suspensão.',
    },
    {
      title: 'Fechamento e runtime macOS endurecidos',
      detail:
        'O app não recria janela durante shutdown, tolera WebContents destruído e mantém o cofre do macOS disponível para Gemini/OpenAI sem aplicar uma regra exclusiva do Linux.',
    },
  ],
};
