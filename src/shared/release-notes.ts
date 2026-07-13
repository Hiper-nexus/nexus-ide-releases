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
  version: '0.15.1',
  date: '2026-07-13',
  codename: 'Supervision Handoff',
  summary:
    'Doctor sem falsos travamentos, handoff recuperável entre panes, Jarvis em tempo real e wake PT-BR garantido em todo pacote de produção.',
  highlights: [
    {
      title: 'Orquestração recuperável',
      detail:
        'Panes preservam sessões recuperáveis, revisores não duplicam e o Doctor limita cada passagem para devolver o controle sem encerrar trabalho saudável.',
    },
    {
      title: 'Jarvis acompanha a operação',
      detail:
        'A voz recebe a tela e os squads atuais continuamente, pergunta qual squad abrir quando falta o nome e mantém o follow-up ativo por um minuto.',
    },
    {
      title: 'Providers prontos para produção',
      detail:
        'O novo hub separa CLIs, modelos e remotos, atualiza o catálogo detectado e preserva navegação completa por teclado.',
    },
  ],
  fixes: [
    {
      title: 'Cancelamento não é falha',
      detail:
        'Interrupções normais do Jarvis deixam de gerar incidente, toast do Doctor ou anúncio incorreto de supervisão travada.',
    },
    {
      title: 'Wake PT-BR sempre presente',
      detail:
        'O modelo treinado ei-jarvis-ptbr.onnx é o padrão, tem hash versionado e o build falha se ele ou o manifesto estiverem ausentes ou divergentes.',
    },
    {
      title: 'Versões alinhadas',
      detail:
        'Aplicativo, servidor, lockfile, changelog e notas internas avançam juntos para impedir releases mistos.',
    },
    {
      title: 'Galeria de pets utilizável',
      detail:
        'Pets da comunidade exibem preview antes da aplicação, aceitam os contratos 8×9 e 8×11 e compactam arquivos grandes mantendo a grade.',
    },
    {
      title: 'Missões antigas continuam operando',
      detail:
        'O runtime converte critérios e rótulos legados, arquiva drafts substituídos sem perder auditoria e retoma o commit de contexto numa árvore Git limpa.',
    },
  ],
};
