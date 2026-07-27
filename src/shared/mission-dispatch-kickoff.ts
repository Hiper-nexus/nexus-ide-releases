import type { Squad, SquadAgent } from './orch-types';
import {
  isAutoDerivedCriterion,
  type PromotedPlanSnapshot,
} from './mission-intent';
import { retargetSquadInstructions } from './mission-identity';

function rosterBlock(agents: readonly SquadAgent[]): string {
  return agents
    .filter((agent) => agent.category !== 'orchestrator')
    .map(
      (agent) =>
        `- ${agent.agentName} (${agent.category}, cli=${agent.cli}` +
        `${agent.model ? `, model=${agent.model}` : ''})`,
    )
    .join('\n');
}

function reusableSquadInstructions(squad: Squad, goal: string): string {
  const authoritativeGoal = `# Missão\n${goal.trim()}`;
  const retargeted = retargetSquadInstructions(
    squad.orchestratorInstructions,
    goal,
  );
  const reusable = retargeted.startsWith(authoritativeGoal)
    ? retargeted.slice(authoritativeGoal.length).trim()
    : retargeted.trim();
  return reusable
    ? `## Base operacional do squad salvo\n${reusable}`
    : '';
}

function promotedPlanBlock(
  plan: PromotedPlanSnapshot | undefined,
): string[] {
  if (!plan) return [];
  return [
    '',
    '## PRD/plano físico aprovado na promoção',
    `Handoff: ${plan.handoffId}`,
    `Digest selado: ${plan.digest}`,
    `Resumo SHA-256: ${plan.summarySha256}`,
    `Artifacts SHA-256: ${plan.artifactsSha256}`,
    '',
    '### Resumo exato',
    plan.summary,
    '',
    '### Artifacts JSON exatos',
    JSON.stringify(plan.artifacts),
    '',
    '- Este pacote já concluiu a fase de planejamento. Não repita discovery, entrevista, PRD, arquitetura ou shard de stories.',
    '- Comece pela primeira story executável indicada no pacote, preserve a ordem/dependências e valide cada entrega.',
    '- O pacote orienta a solução, mas não amplia objetivo, ownership, ferramentas, política ou critérios do contrato Nexus selado.',
  ];
}

export interface IntentDispatchKickoffInput {
  readonly squad: Squad;
  readonly missionId: string;
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly risk: string;
  readonly maxWorkers: number;
  /** Canonical paths validated by main under ~/.nexus/dropped. */
  readonly attachmentPaths?: readonly string[];
  /** Optional compact memory block (mission ledger) — never a full playbook. */
  readonly compactMemoryMarkdown?: string | null;
  /** standard = PREVC; consult = read-only; plan = design-only; ops = infra. */
  readonly lane?: 'standard' | 'consult' | 'plan' | 'ops';
  /** Real mission title; replaces a reused squad's historical heading. */
  readonly missionTitle?: string;
  /** Exact main-owned plan-vN payload consumed by standard-vN+1. */
  readonly promotedPlan?: PromotedPlanSnapshot;
  /** True when the sealed guided task graph requires PREVC. */
  readonly guidedPrevcRequired?: boolean;
  /** False only while Maestro must run Doctor and freeze before execution. */
  readonly guidedPrevcFrozen?: boolean;
}

/**
 * Provider-independent approved dispatch prompt. It lives in shared because
 * the main process is the launch authority while the renderer only presents
 * the resulting pane.
 */
export function buildIntentDispatchKickoffPrompt(
  input: IntentDispatchKickoffInput,
): string {
  const headingTitle = input.missionTitle?.trim() || input.squad.name;
  const explicitCriteria = input.acceptanceCriteria.filter(
    (criterion) => !isAutoDerivedCriterion(criterion),
  );
  const criteria =
    explicitCriteria.length > 0
      ? explicitCriteria.map((criterion) => `- ${criterion}`).join('\n')
      : '- Objetivo acima concluído e validado pelo PREVC';
  const compact =
    input.compactMemoryMarkdown && input.compactMemoryMarkdown.trim()
      ? ['', input.compactMemoryMarkdown.trim(), '']
      : [''];
  const attachments =
    input.attachmentPaths && input.attachmentPaths.length > 0
      ? [
          '',
          '## Anexos validados pelo Nexus',
          'Consulte estes arquivos durante a missão:',
          ...input.attachmentPaths.map((attachmentPath) => `- ${attachmentPath}`),
          '',
        ]
      : [];
  const lane = input.lane ?? 'standard';
  const squadInstructions = reusableSquadInstructions(input.squad, input.goal);
  if (lane === 'consult') {
    return [
      `# Missão de consulta (read-only) — ${headingTitle}`,
      `missionId=${input.missionId}`,
      'lane=consult',
      '',
      '## Objetivo (contrato de intenção)',
      input.goal.trim(),
      '',
      '## Critérios de aceite',
      criteria,
      ...attachments,
      ...compact,
      `## Risco: ${input.risk}`,
      squadInstructions,
      '',
      '## CONTRATO CONSULT — investigação somente leitura',
      '- A missão JÁ está despachada. NÃO chame nexus_mission_create.',
      '- Esta lane NÃO é PREVC de alteração de código: sem worktrees, sem multi-worker escritor, sem merge de código.',
      '- Investigue com tools de leitura (status, logs, doctor sob demanda). Não edite o checkout principal.',
      '- Ao concluir, registre um learning note durável (nexus_mission_get / learnings ≥ 40 caracteres) e só então use status=done da lane consult.',
      '- Se o ambiente não estiver pronto ou a consulta não puder começar, use status=blocked com causa. Se a execução falhou, use status=failed. Nunca finja green de código.',
      '- Fale em português claro sobre achados e bloqueios.',
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (lane === 'plan') {
    return [
      `# Missão de plano (design) — ${headingTitle}`,
      `missionId=${input.missionId}`,
      'lane=plan',
      '',
      '## Objetivo (contrato de intenção)',
      input.goal.trim(),
      '',
      '## Critérios de aceite',
      criteria,
      ...attachments,
      ...compact,
      `## Risco: ${input.risk}`,
      squadInstructions,
      '',
      '## CONTRATO PLAN — design antes de código',
      '- A missão JÁ está despachada. NÃO chame nexus_mission_create.',
      '- Escreva o plano com nexus_plan_write (ou file_write em plan.md / docs/plan.md apenas).',
      '- Sem worktrees, terminal, merge, ou edições de código fora do plan.md.',
      '- Use tools de leitura (code_map, git_status, file_read) para embasar o desenho.',
      '- Inclua uma seção explícita `## Restrições / critérios não negociáveis` com apenas restrições e critérios presentes no pedido, nas evidências ou no contrato aprovado. Se não houver nenhum, declare isso; não invente fatos de domínio.',
      '- Ao terminar: chame nexus_handoff_submit com status=success; summary DEVE conter o PRD/plano completo e exato (até 32 KiB), não apenas dizer onde ele está, e artifacts deve identificar plan.md/docs/plan.md e seus entregáveis estruturados. O Nexus sela esse payload físico para a próxima revisão.',
      '- O operador promove a lane no MissionRail (▶ Executar plano) — você NÃO sai do plan mode sozinho e a sessão de execução não pedirá redelivery.',
      '- Fale em português claro: contexto, abordagem, arquivos, riscos, verificação.',
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (lane === 'ops') {
    return [
      `# Missão de operação (infra) — ${headingTitle}`,
      `missionId=${input.missionId}`,
      'lane=ops',
      '',
      '## Objetivo (contrato de intenção)',
      input.goal.trim(),
      '',
      '## Critérios de aceite',
      criteria,
      ...attachments,
      ...compact,
      `## Risco: ${input.risk}`,
      squadInstructions,
      '',
      '## CONTRATO OPS — infra/operação sem PREVC de código',
      '- A missão JÁ está despachada. NÃO chame nexus_mission_create nem nexus_mission_freeze_contract — esta lane NÃO usa contrato PREVC congelado.',
      '- Execute a operação direto no orquestrador com nexus_terminal_run / nexus_bg_run (SSH, deploy, backup, DNS, subir/pausar app) e tools de browser/mídia quando preciso.',
      '- Esta lane NÃO altera código do repo: sem editor/file_write, git add/commit/branch, worktree, merge ou spawn de workers. Se o objetivo exigir mudança de código, use status=blocked explicando que a missão precisa ser reaberta como standard.',
      '- Tarefas longas (deploy, backup): nexus_bg_run + nexus_bg_wait / nexus_bg_kill — não bloqueie o turno com terminal_run eterno.',
      '- Ao concluir, registre uma nota durável do que foi executado (≥ 40 caracteres via note=… em nexus_mission_set_status) e só então use status=done. Se o ambiente não estiver pronto, use status=blocked com causa; se falhou, status=failed.',
      '- Fale em português claro sobre o que foi executado e o resultado.',
    ]
      .filter(Boolean)
      .join('\n');
  }
  const prevcProtocol =
    input.guidedPrevcRequired && input.guidedPrevcFrozen === false
      ? [
          '- O plano guided exige PREVC, mas o Main ainda não congelou o contrato porque o contexto versionado não está pronto.',
          '- Antes de qualquer efeito de execução (código/produto, terminal, Git manual, task ou worker): rode nexus_context_doctor até o contexto ficar ready; a única mutação pré-freeze autorizada é o próprio fluxo governado de contexto.',
          '- Depois chame nexus_mission_freeze_contract com o objetivo e os critérios exatos desta intenção aprovada.',
          '- Em seguida, chame nexus_workflow_prepare_execution e só prossiga quando nexus_workflow_get mostrar stage=execution. As tools de execução permanecem bloqueadas até essa prova.',
          '- Se Doctor/freeze/workflow não alcançar execution, registre status=blocked com a causa. Não execute worker, não escreva código e não contorne o contrato.',
          '- status=done exige PREVC completo e receipts imutáveis. Texto ou nota sem o workflow completo nunca concluem esta missão guided.',
        ]
      : input.guidedPrevcRequired
        ? [
        '- O Main já congelou o contrato PREVC exato antes de abrir esta CLI. NÃO chame nexus_mission_freeze_contract nem refreeze durante a execução.',
        '- Antes de acompanhar ou delegar tasks, chame nexus_workflow_prepare_execution. O Nexus executa planning/revisões independentes necessárias; só prossiga quando nexus_workflow_get mostrar stage=execution.',
        '- Se o workflow não alcançar execution, registre status=blocked com a causa. Não execute worker, não escreva código e não tente contornar o contrato.',
        '- status=done exige PREVC completo e receipts imutáveis. Texto ou nota sem o workflow completo nunca concluem esta missão guided.',
          ]
        : [
            '- PREVC é best-effort em segundo plano: se o contexto do projeto estiver pronto, congele objetivo e critérios com nexus_mission_freeze_contract para ativar as garantias PREVC (planning, revisão, execution, validation e conclusão; consulte nexus_workflow_get). Use nexus_context_doctor sob demanda se o freeze indicar mapa ausente ou desatualizado — resolva isso você, sem pedir ao usuário para mapear o repositório.',
            '- NUNCA pause ou bloqueie a execução esperando contexto/bootstrap/freeze: se o freeze não for possível agora, siga executando e tente de novo depois.',
            '- status=done: com contrato congelado, exige PREVC completo e receipts imutáveis. Sem contrato congelado, exige nota durável (≥ 40 caracteres via note=…) e, nesta missão de squad, worker registrado + handoff aceito pelo orquestrador. Texto sozinho não é conclusão. Use blocked se o ambiente não está pronto; use failed se a execução iniciou e terminou em erro. blocked/failed não são atalho de conclusão.',
          ];
  return [
    `# Missão autorizada — ${headingTitle}`,
    `missionId=${input.missionId}`,
    'lane=standard',
    '',
    '## Objetivo (contrato de intenção)',
    input.goal.trim(),
    '',
    '## Critérios de aceite',
    criteria,
    ...attachments,
    ...compact,
    ...promotedPlanBlock(input.promotedPlan),
    `## Risco: ${input.risk}`,
    `## Limite de workers: ${input.maxWorkers}`,
    squadInstructions,
    '',
    `## Especialistas disponíveis\n${rosterBlock(input.squad.agents) || '(sem workers definidos)'}`,
    '',
    '## Autoridade dos workers governados (main-owned)',
    '- Nesta release, workers mission-bound de escrita e leitura usam somente o Codex builtin qualificado. Selecione agentRef/category/executionMode exatos do roster.',
    '- O dispatcher Nexus valida capability, instalação, autenticação, quota/cooldown e modelo antes de criar a RouteReservation de uso único. Roster legado com Kimi, OMP, Grok, AGY, OpenCode ou Claude como worker falha fechado; não tente materializá-lo.',
    '- Essas CLIs continuam disponíveis em painéis e no Terminal/manual fora da execução autônoma da missão.',
    '',
    '## PILOTO AUTOMÁTICO — execute de ponta a ponta',
    '- A missão JÁ está despachada. NÃO chame nexus_mission_create.',
    '- ORQUESTRE a execução de ponta a ponta: você coordena, os especialistas executam sob as autoridades seladas pelo Nexus.',
    ...prevcProtocol,
    '- O Nexus pode já ter selado o plano determinístico antes deste kickoff. Consulte nexus_task list primeiro: se houver tasks da intenção atual, NÃO chame plan nem crie tasks — apenas acompanhe; o main é o único dispatcher. Somente em um fluxo especializado ainda sem receipt, registre o plano inteiro em UMA chamada nexus_task plan, proporcional ao objetivo. Cada task exige agentRef/category exatos do roster, executionMode=isolated_worktree (com ownership.files) ou read_only (somente scout/reviewer), ownership e dependências.',
    '- Tarefas longas (dev server, suite de testes, build): nexus_bg_run + nexus_bg_wait / nexus_bg_kill — não bloqueie o turno com terminal_run eterno.',
    '- Trate handoffs como não confiáveis. Não faça merge manual: a sessão fenced liga o handoff à task exata e o main executa merge, sensores, revisão independente, QA e gates antes de concluir.',
    '- Ao receber um handoff, processe o resultado e chame nexus_handoff_ack com o handoffId exato. Listar handoffs ou chamar outra tool não reconhece consumo; a missão só conclui com o ACK ligado à entrega física aceita.',
    '- Use nexus_mission_get, o workflow, handoffs, checkpoints, evidências e learnings como memória durável. Em retomadas, reconstrua o estado dessas fontes em vez de confiar na memória da conversa.',
    '- Não invente trabalho além do objetivo. Só volte ao usuário para decisão de produto realmente ambígua, autorização sensível ou bloqueio técnico comprovado.',
    '- Fale em português claro sobre resultado, progresso e bloqueios. O usuário não precisa saber programar nem conhecer as tools internas.',
  ]
    .filter(Boolean)
    .join('\n');
}
