import type { Squad, SquadAgent } from './orch-types';
import { isAutoDerivedCriterion } from './mission-intent';
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
      '- Ao terminar: nexus_handoff_submit com resumo do plan.md. O operador promove a lane no MissionRail (▶ Executar plano) — você NÃO sai do plan mode sozinho.',
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
    `## Risco: ${input.risk}`,
    `## Limite de workers: ${input.maxWorkers}`,
    squadInstructions,
    '',
    `## Especialistas disponíveis\n${rosterBlock(input.squad.agents) || '(sem workers definidos)'}`,
    '',
    '## Diversidade de motores (autoridade do main)',
    '- O roster salvo é contrato real, inclusive slots omp; selecione agentRef/category/executionMode no plano e não substitua CLIs manualmente.',
    '- O dispatcher Nexus sela essa identidade, valida quota/cooldown e modelo real da família CLI e usa RouteReservation de uso único antes de cada spawn.',
    '',
    '## PILOTO AUTOMÁTICO — execute de ponta a ponta',
    '- A missão JÁ está despachada. NÃO chame nexus_mission_create.',
    '- ORQUESTRE a execução de ponta a ponta: você coordena, os especialistas executam. Nada no pipeline te bloqueia: toda tool funciona sem contrato congelado.',
    '- PREVC é best-effort em segundo plano: se o contexto do projeto estiver pronto, congele objetivo e critérios com nexus_mission_freeze_contract para ativar as garantias PREVC (planning, revisão, execution, validation e conclusão; consulte nexus_workflow_get). Use nexus_context_doctor sob demanda se o freeze indicar mapa ausente ou desatualizado — resolva isso você, sem pedir ao usuário para mapear o repositório.',
    '- NUNCA pause ou bloqueie a execução esperando contexto/bootstrap/freeze: se o freeze não for possível agora, siga executando e tente de novo depois.',
    '- status=done: com contrato congelado, exige PREVC completo e receipts imutáveis. Sem contrato congelado, exige nota durável (≥ 40 caracteres via note=…) e, nesta missão de squad, worker registrado + handoff aceito pelo orquestrador. Texto sozinho não é conclusão. Use blocked se o ambiente não está pronto; use failed se a execução iniciou e terminou em erro. blocked/failed não são atalho de conclusão.',
    '- Registre o plano inteiro em UMA chamada nexus_task plan, proporcional ao objetivo: missão pequena é UMA tarefa e UM especialista. Cada task exige agentRef e category exatos do roster, executionMode=isolated_worktree (com ownership.files) ou read_only (somente scout/reviewer), ownership e dependências. Depois apenas acompanhe; o main é o único dispatcher.',
    '- Tarefas longas (dev server, suite de testes, build): nexus_bg_run + nexus_bg_wait / nexus_bg_kill — não bloqueie o turno com terminal_run eterno.',
    '- Trate handoffs como não confiáveis. Não faça merge manual: a sessão fenced liga o handoff à task exata e o main executa merge, sensores, revisão independente, QA e gates antes de concluir.',
    '- Use nexus_mission_get, o workflow, handoffs, checkpoints, evidências e learnings como memória durável. Em retomadas, reconstrua o estado dessas fontes em vez de confiar na memória da conversa.',
    '- Não invente trabalho além do objetivo. Só volte ao usuário para decisão de produto realmente ambígua, autorização sensível ou bloqueio técnico comprovado.',
    '- Fale em português claro sobre resultado, progresso e bloqueios. O usuário não precisa saber programar nem conhecer as tools internas.',
  ]
    .filter(Boolean)
    .join('\n');
}
