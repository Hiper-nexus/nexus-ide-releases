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
  version: '0.19.37',
  date: '2026-07-29',
  codename: 'Autopiloto sem becos sem saída',
  summary:
    'O Nexus inicia e recupera missões com qualquer CLI compatível do operador, usa memória e contexto automaticamente e reserva os gates de qualidade para a promoção final.',
  highlights: [
    {
      title: 'Autopiloto multi-CLI de verdade',
      detail:
        'No modo Autopiloto, qualquer CLI instalada, autenticada e capaz de entregar handoff pode executar, revisar ou validar. Rede, ferramentas web e autoaprovação do próprio provider ficam disponíveis durante toda a missão.',
    },
    {
      title: 'Maestro multi-CLI sem depender de MCP',
      detail:
        'CLIs PTY compatíveis coordenam plano, operações e conclusão pelo dispatcher Main-owned. A autorização fica ligada à sessão, missão, papel e contrato aprovados; chamadas são deduplicadas e os resultados voltam ao mesmo terminal.',
    },
    {
      title: 'Falha técnica vira recuperação',
      detail:
        'Saída precoce, falha de bootstrap, indisponibilidade temporária e retomada após reinício voltam para uma fila durável com retry e backoff. Bloqueio fica reservado para autenticação, decisão humana, ambiguidade real ou ação sensível.',
    },
    {
      title: 'PREVC acompanha sem segurar a largada',
      detail:
        'Memória, orientação e contrato são preparados em paralelo ao trabalho. O PREVC valida a promoção e o merge, sem congelar a missão antes do primeiro worker nem transformar contexto incompleto em beco sem saída.',
    },
    {
      title: 'Memória operacional automática',
      detail:
        'SQLite FTS5 é a fonte canônica, Markdown continua legível no Obsidian e decisões confiáveis entram em recall automático limitado antes de planejar, executar e revisar. O mapa estrutural atualiza somente o que mudou.',
    },
    {
      title: 'Qualidade ligada ao código real',
      detail:
        'Receipts agora se ligam ao diff, contrato, sensores, Git físico e revisão independente. A análise do candidate procura código morto, duplicação, APIs parecidas, violações de fronteira, blast radius e lacunas de teste.',
    },
    {
      title: 'Núcleo simples e modo Hardened opcional',
      detail:
        'O padrão mantém worktrees separados, identidade por sessão e merge validado pelo Main sem sandbox de provider ou kernel. Confinamento e verificações rigorosas continuam disponíveis no modo Hardened.',
    },
  ],
  fixes: [
    {
      title: 'Fim do “caminho não pôde ser selado”',
      detail:
        'Objetivos em linguagem natural recebem ownership a partir de um inventário limitado do projeto. Arquivos explícitos continuam exatos, mas a falta de um path literal não impede mais o lançamento.',
    },
    {
      title: 'Pane antigo não sela a missão atual',
      detail:
        'Autoridade persisted bloqueada ou dispatched é reconciliada para o estado executável antes do spawn. Ao reabrir o app, panes de missão são retomados pelo Main sem depender da preferência de restauração de terminais avulsos.',
    },
    {
      title: 'Crash de worker não condena a missão',
      detail:
        'Quando o runtime físico desaparece, o dispatch volta para pending com backoff e o substituto só assume após rebind exato de missão, pane, sessão e encarnação. Falha de heartbeat ou persistência nunca duplica um worker ainda vivo.',
    },
    {
      title: 'Capacidade cheia significa aguardar',
      detail:
        'O scheduler respeita o limite real de workers e mantém a próxima task pendente. Falta temporária de vaga não marca mais a task como failed nem encerra a missão.',
    },
    {
      title: 'Transações físicas com rollback',
      detail:
        'Falhas depois do claim desfazem exatamente a transição do Main e preservam o worktree para retry. Reinícios durante candidate, integração, pós-validação ou finalização recuperam o estágio durável em vez de condenar o branch.',
    },
    {
      title: 'Autenticação compatível com cada provider',
      detail:
        'Claude nativo usa o HOME e Keychain reais no Autopiloto; providers compatíveis com Claude, mas baseados em token, continuam isolados. CLIs com auth none iniciam sem injeção ou supressão artificial de credenciais.',
    },
    {
      title: 'Remoção de missão sem perda de histórico',
      detail:
        'O Nexus só remove missão, tasks e receipts após provar o encerramento físico do runtime. Se o teardown falhar, os registros permanecem recuperáveis e o usuário recebe um erro acionável.',
    },
    {
      title: 'OMP e lease global removidos',
      detail:
        'O runtime, configurações e interface do OMP saíram do produto. O lease AGY que alterava configuração MCP real também foi removido, eliminando symlinks destruídos, bearer órfão e conflito entre instâncias.',
    },
    {
      title: 'Gates honestos e rápidos',
      detail:
        'Risco em português recebe a mesma severidade do equivalente em inglês, requisitos explícitos desconhecidos permanecem pendentes e worktrees antigos em .dev-user-data deixam de contaminar testes e indexadores.',
    },
  ],
};

export const PREVIOUS_RELEASE: AppRelease = {
  version: '0.19.26',
  date: '2026-07-22',
  codename: 'Piloto Automático sem Modal',
  summary:
    'Aprovar a missão autoriza a execução inteira: o agente não para em modal a cada comando, o PREVC garante sem bloquear e o wizard virou fluxo único sem jargão.',
  highlights: [
    {
      title: 'Execução sem interrupção',
      detail:
        'A aprovação da missão é a autorização — deploy, SSH, edição de código e browser fluem direto, tudo auditado; só comandos destrutivos pedem confirmação.',
    },
    {
      title: 'PREVC que garante sem limitar',
      detail:
        'Sem contrato congelado a missão executa normalmente; com contrato, stage, drift e receipts continuam valendo. Tarefas mistas de infra + código funcionam.',
    },
    {
      title: 'Wizard fluxo único',
      detail:
        'Objetivo + lançar. Tipos de entrega viraram Opções avançadas colapsadas, em linguagem simples, com Sem restrições como padrão.',
    },
  ],
  fixes: [
    {
      title: 'Fim do stall de confirmação',
      detail:
        'O agente não fica mais minutos parado esperando clique em modal a cada ação — a autorização vem da missão aprovada, com auditoria fail-closed.',
    },
    {
      title: 'Kickoff anti-travamento',
      detail:
        'O orquestrador executa direto e trata freeze/bootstrap PREVC como best-effort em segundo plano, nunca como pré-condição.',
    },
  ],
};
