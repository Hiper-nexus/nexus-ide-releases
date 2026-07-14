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
  version: '0.15.16',
  date: '2026-07-14',
  codename: 'Orquestração Enxuta e Voz Reprodutível',
  summary:
    'Consultas somente leitura com gate real, encerramento PREVC-safe, recuperação durável, kickoff enxuto e os ativos de voz e pets necessários para uma instalação reproduzível.',
  highlights: [
    {
      title: 'Lane de consulta segura',
      detail:
        'O wizard permite escolher Código (PREVC) ou Consulta; a lane consult é propagada pelo IPC e bloqueia ferramentas mutáveis, mantendo aprendizado durável como critério de conclusão.',
    },
    {
      title: 'Kickoff e recuperação sem desperdício',
      detail:
        'O início de missão usa prompts proporcionais, e a recuperação confirma markSubmitted e sincronização com pane livre antes de liberar o fluxo.',
    },
    {
      title: 'Nico acompanha a instalação',
      detail:
        'O pet criado no Pet Studio foi adicionado ao catálogo embutido com spritesheet validado abaixo do limite de 2,5 MB.',
    },
    {
      title: 'Wake PT-BR reproduzível',
      detail:
        'O pipeline sintético de treino, testes e instruções PT-BR fica versionado sem sobrescrever o modelo ativo do cliente.',
    },
    {
      title: 'Revisão humana chega ao orquestrador',
      detail:
        'As anotações de diff são submetidas como um prompt único ao orquestrador da missão ativa, que delega o retrabalho — revisar deixa de depender de qual pane está focado.',
    },
    {
      title: 'Rail mostra quando a missão espera você',
      detail:
        'Pills "Aguarda você", "Sem objetivo" e "Pronta" substituem o genérico "Na fila"; a meta fala de agentes e de há quanto tempo a missão roda.',
    },
    {
      title: 'Missão auditável desde a issue',
      detail:
        'Issues do GitHub/Linear viram missões com source imported-issue no contrato; objetivos por voz registram source voice.',
    },
    {
      title: 'Source Control no contexto',
      detail:
        'O painel Git contextual executa operações reais no workspace, valida o estado do repositório e mantém o resultado auditável no mesmo cockpit.',
    },
    {
      title: 'Presença e onboarding mais claros',
      detail:
        'Boot, home e lançamento mostram pet, progresso e CTA com estado explícito (online, calibrando ou ação necessária), sem animação invasiva.',
    },
    {
      title: 'Notificações saltam para o pane certo',
      detail:
        'A inbox de agentes preserva avisos acionáveis e leva o operador diretamente ao pane que requer atenção, inclusive entre sessões.',
    },
    {
      title: 'Missão enxuta (0.15.14)',
      detail:
        'Kickoff sem duplicação, cartas de worker por papel/tarefa, começo em um clique para risco normal e wizard sem jargão.',
    },
  ],
  fixes: [
    {
      title: 'Done PREVC-safe e bloqueio acionável',
      detail:
        'O orquestrador não encerra missão sem PREVC; a UI oferece encerramento bloqueado com justificativa, e a lane consult tem regra testável.',
    },
    {
      title: 'Entrega e sync com confirmação',
      detail:
        'A sincronização escolhe apenas o CLI focado ou único; múltiplos CLIs ficam ambíguos em vez de receberem uma ação no destino errado.',
    },
    {
      title: 'Voz dual-audio e pane sync',
      detail:
        'A release inclui a sincronização via pane CLI, evita TTS Classic e Gemini simultâneos após tool e fecha os buracos de review do dual-audio.',
    },
    {
      title: 'Empacotamento multiplataforma confiável',
      detail:
        'O filtro do Forge normaliza caminhos Windows, e o smoke respeita os artefatos reais do node-pty em cada sistema operacional.',
    },
    {
      title: 'Autonomia pinada por teste',
      detail:
        'defaultDriveConfig nasce em shadow, congelado e com budgets finitos; trocar isso agora quebra um teste em vez de re-armar autonomia em silêncio.',
    },
    {
      title: 'Orçamento de workers sem corrida',
      detail:
        'A reserva de slot só cai depois que o worker está durável em missionPanes; sem a linha, a reserva fica retida (fail-safe) com aviso.',
    },
    {
      title: 'Soak antes de default-on',
      detail:
        'Política operacional codificada: capability autônoma nasce fail-safe, default pinado por teste, um ciclo de shadow antes do flip e inventário de todas as portas de efeito.',
    },
  ],
};
