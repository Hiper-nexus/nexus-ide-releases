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
  version: '0.15.2',
  date: '2026-07-13',
  codename: 'Squad Continuity',
  summary:
    'Squads continuam operando com WIP local, a Jarvis entende a tela e confirma delegações sem perder o turno, e a supervisão reage a evidência real.',
  highlights: [
    {
      title: 'Delegação sem deadlock',
      detail:
        'O orquestrador mantém uma rota limitada para workers antes do freeze, preserva o checkout atual e serializa escritores quando a tarefa depende do WIP.',
    },
    {
      title: 'Jarvis orientada pela tela',
      detail:
        '“Abrir modo squad” mostra os squads salvos, nomes visíveis entram no contexto e comandos de wake validados seguem sem uma segunda captura vazia.',
    },
    {
      title: 'Confirmação confiável',
      detail:
        'A resposta “sim” resolve a delegação pendente exatamente uma vez, inclusive em sessão Live quente, sem ser descartada pelo filtro passivo.',
    },
  ],
  fixes: [
    {
      title: 'Doctor fala a verdade',
      detail:
        'Falha de commit ou binding Git retorna bloqueio explícito e ativa a rota same_checkout, sem pedir stash, reset ou troca de branch ao usuário.',
    },
    {
      title: 'Supervisão baseada em panes vivos',
      detail:
        'O supervisor ignora panes históricos, respeita o orquestrador ocupado e só anuncia bloqueio final; a primeira recuperação é silenciosa e não terminal.',
    },
    {
      title: 'Wake PT-BR preservado',
      detail:
        'O pacote mantém ei-jarvis-ptbr.onnx como padrão obrigatório, com manifesto e hash verificados no build de produção.',
    },
    {
      title: 'Home Deck alinhado',
      detail:
        'Colunas de squads, ações e chips de frota, cota e custo mantêm alinhamento e leitura em uma única linha.',
    },
    {
      title: 'Versões alinhadas',
      detail:
        'Aplicativo, servidor, lockfile, changelog e notas internas avançam juntos para impedir releases mistos.',
    },
  ],
};
