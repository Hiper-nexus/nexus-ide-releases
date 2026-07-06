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
  version: '0.8.1',
  date: '2026-07-06',
  codename: 'Ops Board & identidade pixel',
  summary:
    'Glow-up visual completo em cima da nova fundação de contas: um Ops Board para o pipeline de missões, um icon set pixel próprio (incluindo o novo ícone do app), escalas de token que deixam o espaçamento consistente e o orb do Jarvis reagindo à amplitude real do microfone. Por baixo, o backend de auth (OAuth Google/GitHub) e a gamificação de operador entraram no ciclo.',
  highlights: [
    {
      title: 'Ops Board — pipeline de missões',
      detail:
        'Um board espacial (a fazer → executando → review → pronto → cancelado) com trilho colorido por status. Arrastar um card é planejamento; "retomar" restaura os panes da missão com as CLIs continuando de onde pararam. Abre com ⌘B.',
    },
    {
      title: 'Icon set pixel + novo ícone do app',
      detail:
        'Emojis e glyphs Unicode viraram um conjunto único de ícones pixel na pegada do NexusMark. O app ganhou um ícone novo — diamante-nó com core aceso sobre o console navy, no lugar do gradiente genérico.',
    },
    {
      title: 'Escalas de token',
      detail:
        'Espaçamento, tipografia, raios e sombras agora saem de escalas únicas em vez de valores soltos, deixando o acabamento consistente em toda a UI.',
    },
    {
      title: 'Orb do Jarvis com amplitude real',
      detail:
        'O orb de voz reage ao nível real do microfone (não só à fase), virando um visualizador de amplitude de verdade — e respeita reduced-motion.',
    },
    {
      title: 'Settings agrupado + busca',
      detail:
        'A navegação de configurações foi reagrupada por intenção (Conta · Operação · Arsenal · Catálogo) com campo de busca, resolvendo a lista de 20 itens num nível só.',
    },
    {
      title: 'Contas por OAuth (fundação)',
      detail:
        'Backend de auth com login Google/GitHub (PKCE), exchange por código, tokens no Keychain e licença assinada — a base dos planos Free/Pro.',
    },
    {
      title: 'Gamificação de operador',
      detail:
        'XP por valor entregue (nunca por consumo), tiers, streak, conquistas e o mascote pixel no HUD — com modo sóbrio para quem prefere esconder tudo.',
    },
  ],
  fixes: [
    {
      title: 'Versão correta no About',
      detail:
        'O About mostrava 0.7.1 fixo mesmo em versões novas; agora acompanha a versão real do pacote.',
    },
    {
      title: 'Bugs de paleta',
      detail:
        'O textDim voltava para um cinza que falha contraste WCAG; cores Material cruas no toolbar e o vermelho de "erro" nos presets "Originals" foram trocados por tokens da paleta.',
    },
    {
      title: 'Botão de fechar único',
      detail:
        'As quatro variantes de "fechar" (incluindo um "x" minúsculo) viraram um X nítido só, em todo o app.',
    },
    {
      title: 'PT-BR consistente',
      detail:
        'O seletor de agente, as fases do HUD de voz e a frase de teste de voz estavam em inglês no meio da UI em português.',
    },
  ],
};
