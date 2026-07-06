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
  version: '0.9.0',
  date: '2026-07-06',
  codename: 'Auto-update & missões confiáveis',
  summary:
    'O NexusIDE agora se atualiza sozinho e avisa quando há versão nova — badge na barra + painel com notas e um clique para instalar. O histórico de missões foi consertado de ponta a ponta (a missão antiga nunca mais some ao abrir outra, e retomar volta para a conversa certa) e o spam de handoff fantasma no orquestrador acabou.',
  highlights: [
    {
      title: 'Auto-update com UI (fim do "às cegas")',
      detail:
        'O app checa releases novos no boot e a cada 6h. Havendo versão nova, um badge ⇪ aparece na barra; o painel mostra atual → nova com as notas e o ciclo Baixar e instalar → Reiniciar agora. Download validado e aplicado pelo Squirrel (assinatura conferida).',
    },
    {
      title: 'Missões que não somem',
      detail:
        'Abrir uma missão nova não apaga a anterior: ela fica no histórico como "travada", com Retomar visível no rail e no Ops Board. A missão nova aparece na hora — o registro nasce no lançamento, sem depender do orquestrador lembrar de criá-lo.',
    },
    {
      title: 'Retomar volta para a conversa CERTA',
      detail:
        'Reabrir uma missão restaura cada pane apontando para a própria conversa daquela missão (resume direcionado), em vez de continuar a conversa mais recente do projeto — que era da outra missão.',
    },
  ],
  fixes: [
    {
      title: 'Spam de handoff fantasma',
      detail:
        'O orquestrador recebia "[nexus handoff] … <resumo objetivo do que fez>" em loop, até depois de o terminal do worker fechar: o eco/repaint do próprio contrato de kickoff era lido como entrega real. Placeholders são ignorados e repaints deduplicados.',
    },
    {
      title: 'Clique morto na missão antiga',
      detail:
        'Panes mortos mantinham a missão deslocada marcada como "aberta" para sempre — o clique não fazia nada e o Retomar ficava escondido. Os vínculos agora morrem junto com os panes.',
    },
    {
      title: 'Retomar a missão aberta não a mata mais',
      detail:
        'A missão viva aparecia como "não aberta" e o Retomar dela matava e recriava a própria missão. O pane do orquestrador agora é vinculado corretamente e há guarda contra reabrir o que já está aberto.',
    },
  ],
};
