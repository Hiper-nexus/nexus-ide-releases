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
  version: '0.15.13',
  date: '2026-07-14',
  codename: 'Dock-First Keychain-Safe Launch',
  summary:
    'Nexus cria e mostra explicitamente a janela nativa e não consulta o Keychain de forma síncrona durante o boot do macOS.',
  highlights: [
    {
      title: 'Intenção antes de orquestração',
      detail:
        'Selecionar um squad arma apenas a missão; objetivo, plano e aprovação vêm antes de panes, workers ou gasto de modelo.',
    },
    {
      title: 'Fila e orçamento de missão',
      detail:
        'Prompt queue, intentVersion, preempção de preparação obsoleta e limites de workers/passos evitam que a Jarvis fique monopolizada por ciclos antigos.',
    },
    {
      title: 'Operação direta e voz confiável',
      detail:
        'Sincronização Git usa fast-forward seguro; realtime mantém ferramentas curtas, socket e follow-up coerentes entre provedores.',
    },
    {
      title: 'Pets e wake PT-BR no pacote',
      detail:
        'Avisos dos pets aguardam clique, Nexo/Nico Code acompanham a biblioteca offline e o modelo ei-jarvis-ptbr.onnx é instalado como padrão.',
    },
  ],
  fixes: [
    {
      title: 'Dock e janela resilientes',
      detail:
        'A janela principal é criada antes de integrações opcionais e de todo o bootstrap síncrono; consultas Keychain bloqueantes ficam fora do caminho de inicialização.',
    },
    {
      title: 'Autoridade fail-closed',
      detail:
        'Descrição solta não autoriza execução; gates no processo principal bloqueiam bootstrap, delegação, handoff sem origem e orçamento excedido.',
    },
    {
      title: 'Supervisor silencioso na espera humana',
      detail:
        'Missões awaiting_goal/approval não são classificadas como stall; recovery exige despacho e heartbeat reais.',
    },
    {
      title: 'Sem regressão silenciosa',
      detail:
        'App, servidor, lockfile, changelog e notas internas avançam juntos; operação Git bloqueia divergência sem stage, commit ou push implícito.',
    },
  ],
};
