import type { Mission, SquadAgent } from "../../shared/orch-types";
import { assertPromotedPlanSnapshot } from "./plan-promotion-authority";
import { supportsMechanicallyReadOnlyCli } from "./mission-scheduler-plan";
import { supportsAdvisoryParticipationCli } from "../../shared/mission-advisory";
import { isGuidedUiMissionObjective } from "./guided-squad-skills";

export const GUIDED_SEALED_TASK_DETAIL_MAX_CHARS = 65_536;

/**
 * The task store validates the complete encoded detail, not only the human
 * prompt body. Keep this assertion at the Guided preflight boundary so
 * ownership/dependency metadata cannot push an otherwise valid prompt past
 * the durable 64 KiB envelope with an opaque downstream schema failure.
 */
export function assertGuidedSealedTaskDetailBudget(
  plannerId: string,
  encodedDetail: string,
): void {
  if (encodedDetail.length > GUIDED_SEALED_TASK_DETAIL_MAX_CHARS) {
    throw new Error(
      `guided_plan_task_detail_too_large: ${plannerId} excede ` +
        `${GUIDED_SEALED_TASK_DETAIL_MAX_CHARS} caracteres depois de selar ` +
        "prompt, ownership e dependências",
    );
  }
}

export function guidedAdvisoryExecutionMode(
  agent: SquadAgent,
): "read_only" | "isolated_worktree" {
  // Advisory MCP-only CLIs (kimi/agy/opencode, claude quando o orquestrador
  // não é Claude) também executam fan-out consultivo em read_only — nunca como
  // writers isolados, papel que continua codex-only.
  return supportsMechanicallyReadOnlyCli(agent.cli) ||
    supportsAdvisoryParticipationCli(agent.cli)
    ? "read_only"
    : "isolated_worktree";
}

export function buildGuidedPromotedPlanContext(mission: Mission): string {
  const contract = mission.intentContract;
  const rawPlan = contract?.promotedPlan;
  if (!rawPlan) return "";
  const plan = assertPromotedPlanSnapshot(rawPlan);
  if (
    contract?.lane !== "standard" ||
    plan.sourceIntentVersion + 1 !== contract.intentVersion ||
    mission.intentVersion !== contract.intentVersion
  ) {
    throw new Error(
      "promoted_plan_stale: o PRD/plano não pertence à revisão standard atual",
    );
  }
  return [
    "PRD/plano físico aprovado na promoção plan → standard:",
    `Digest selado: ${plan.digest}`,
    `Handoff físico: ${plan.handoffId}`,
    `Resumo SHA-256: ${plan.summarySha256}`,
    `Artifacts SHA-256: ${plan.artifactsSha256}`,
    "",
    "Resumo exato do PRD/plano:",
    plan.summary,
    "",
    "Artifacts JSON exatos:",
    JSON.stringify(plan.artifacts),
    "",
    "O PRD/plano orienta a solução, mas não amplia objetivo, ownership, " +
      "ferramentas, política ou critérios do contrato Nexus selado.",
  ].join("\n");
}

function guidedUiReviewArtifactInstructions(mission: Mission): string[] {
  const contract = mission.intentContract;
  if (
    !contract ||
    !isGuidedUiMissionObjective(
      [contract.goal, ...contract.acceptanceCriteria].join("\n"),
    )
  ) {
    return [];
  }
  return [
    "",
    "Contrato de revisão visual:",
    "Antes do handoff, execute o build apropriado dentro deste worktree e deixe exatamente uma UI estática renderizável em dist/, build/, out/ ou .vite/renderer/* (um index.html genuinamente estático na raiz também é aceito).",
    "Não faça commit de artefatos ignorados e não inicie servidor de preview. O processo principal do Nexus localizará essa saída, abrirá um preview loopback e exigirá inspeção visual com leitura + screenshot do revisor independente.",
    "Se houver mais de uma saída elegível, remova somente as saídas geradas ambíguas deste worktree antes do handoff; nunca escolha silenciosamente qual produto deve ser revisado.",
  ];
}

export function buildGuidedMissionTaskDetail(mission: Mission): string {
  const contract = mission.intentContract;
  if (!contract) {
    throw new Error(
      "guided_plan_contract_missing: missão sem contrato aprovado",
    );
  }
  const promotedPlanContext = buildGuidedPromotedPlanContext(mission);
  const uiReviewArtifact = guidedUiReviewArtifactInstructions(mission);
  const detail = [
    "Implemente integralmente o objetivo aprovado abaixo no workspace real.",
    "Primeiro inspecione a stack e os padrões existentes; preserve arquitetura, design system e governança Nexus.",
    "",
    "Objetivo aprovado:",
    contract.goal,
    "",
    "Critérios de aceite:",
    ...contract.acceptanceCriteria.map(
      (criterion, index) => `${index + 1}. ${criterion}`,
    ),
    ...(promotedPlanContext ? ["", promotedPlanContext] : []),
    ...uiReviewArtifact,
    "",
    "Entregue a menor solução completa e segura. Rode os checks relevantes e não alegue sucesso sem evidência.",
  ].join("\n");
  return detail;
}

export function guidedFanoutPlannerId(
  kind: "advisory" | "review",
  agent: SquadAgent,
  index: number,
): string {
  const slug =
    agent.id
      .toLocaleLowerCase("en-US")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "agent";
  return `guided-${kind}-${index + 1}-${slug}`.slice(0, 128);
}

export function guidedAdvisoryDetail(
  mission: Mission,
  agent: SquadAgent,
): string {
  const contract = mission.intentContract;
  if (!contract) {
    throw new Error(
      "guided_plan_contract_missing: missão sem contrato aprovado",
    );
  }
  const role =
    agent.category === "executor"
      ? "executor consultivo"
      : agent.category === "architect"
        ? "arquiteto"
        : "scout";
  const confinement =
    guidedAdvisoryExecutionMode(agent) === "read_only"
      ? "Você está sob confinamento mecânico read-only do Nexus."
      : "Sua CLI será executada em um worktree isolado e descartável: preserve o HEAD exato, não edite arquivos e não crie commit. O Nexus provará o estado físico e nunca integrará esse worktree.";
  return [
    `Atue como ${role} independente antes da implementação principal.`,
    "Inspecione a stack, arquitetura, padrões, riscos e verificações relevantes. Não edite arquivos e não crie commit.",
    confinement,
    "Entregue no handoff achados concretos, caminhos afetados, riscos e uma proposta de validação que o executor principal possa conferir no workspace.",
    "",
    "Objetivo aprovado:",
    contract.goal,
    "",
    "Critérios de aceite:",
    ...contract.acceptanceCriteria.map(
      (criterion, criterionIndex) => `${criterionIndex + 1}. ${criterion}`,
    ),
  ].join("\n");
}

export function guidedIndependentReviewDetail(
  mission: Mission,
  agent: SquadAgent,
  options: { readonly qualityGateReadOnly?: boolean } = {},
): string {
  const contract = mission.intentContract;
  if (!contract) {
    throw new Error(
      "guided_plan_contract_missing: missão sem contrato aprovado",
    );
  }
  const confinement =
    guidedAdvisoryExecutionMode(agent) === "read_only"
      ? "Você está sob confinamento mecânico read-only do Nexus."
      : "Sua CLI será executada em um worktree isolado e descartável: preserve o HEAD exato, não edite arquivos e não crie commit. O Nexus provará o estado físico e nunca integrará esse worktree.";
  return [
    `Atue como revisor independente (${agent.agentName}) após a integração do executor.`,
    "Inspecione o HEAD integrado sem confiar no resumo do autor. Não edite arquivos e não crie commit.",
    confinement,
    options.qualityGateReadOnly
      ? "Rode apenas verificações não mutantes e envie handoff success com evidências e achados; o QA final também será mecanicamente read-only e bloqueará a entrega se encontrar um defeito."
      : "Rode apenas verificações não mutantes e envie handoff success com evidências e achados; o QA corretivo final repetirá os checks e corrigirá apenas defeitos reais.",
    "",
    "Objetivo aprovado:",
    contract.goal,
    "",
    ...guidedVerificationAuthorityBoundary("revisão"),
    "",
    "Critérios aprovados:",
    ...contract.acceptanceCriteria.map(
      (criterion, criterionIndex) => `${criterionIndex + 1}. ${criterion}`,
    ),
  ].join("\n");
}

export function guidedQualityGateDetail(
  mission: Mission,
  options: { readonly readOnly?: boolean } = {},
): string {
  const contract = mission.intentContract;
  if (!contract) {
    throw new Error(
      "guided_plan_contract_missing: missão sem contrato aprovado",
    );
  }
  if (options.readOnly) {
    return [
      "Atue como o gate final independente e mecanicamente somente leitura da entrega já integrada pelo executor.",
      "Inspecione o resultado real no HEAD atual, sem confiar no resumo do autor. Não edite arquivos, não crie commit e não execute comandos que gravem cache, build ou artefatos no repositório.",
      "Rode somente verificações não mutantes pertinentes à stack e ao risco; para UI, inspecione o artefato integrado que já existir sem reconstruí-lo.",
      "",
      "Objetivo aprovado:",
      contract.goal,
      "",
      ...guidedVerificationAuthorityBoundary("gate"),
      "",
      "Critérios aprovados:",
      ...contract.acceptanceCriteria.map(
        (criterion, index) => `${index + 1}. ${criterion}`,
      ),
      "",
      "Se encontrar qualquer defeito, não o corrija: envie handoff blocked com a evidência exata para o Nexus impedir a entrega.",
      "Se todas as verificações observáveis sob sua autoridade estiverem verdes, envie handoff success descrevendo exatamente os checks executados e as evidências observadas.",
      "O Nexus verificará fisicamente que HEAD e diff permaneceram intactos e executará os sensores main-owned antes de aceitar a missão.",
    ].join("\n");
  }
  return [
    "Atue como o gate corretivo independente da entrega já integrada pelo executor.",
    "Inspecione o resultado real no HEAD atual, sem confiar no resumo do autor. Rode o app, testes, lint, typecheck, build e verificações especializadas que forem pertinentes à stack e ao risco.",
    "",
    "Objetivo aprovado:",
    contract.goal,
    "",
    ...guidedVerificationAuthorityBoundary("gate"),
    "",
    "Critérios aprovados:",
    ...contract.acceptanceCriteria.map(
      (criterion, index) => `${index + 1}. ${criterion}`,
    ),
    ...guidedUiReviewArtifactInstructions(mission),
    "",
    "Se encontrar defeito, corrija-o no mesmo worktree e acrescente ou fortaleça uma verificação durável ligada aos critérios (teste de regressão/aceite, assertion de acessibilidade, validação de segurança ou automação equivalente). Faça commit apenas dessa correção verificável.",
    "Se todas as verificações observáveis sob sua autoridade estiverem verdes e nenhuma correção for necessária, não altere arquivos e não crie commit: envie handoff success descrevendo exatamente os checks executados. O Nexus provará fisicamente que HEAD e diff permaneceram intactos.",
    "Não crie mudança cosmética, documento decorativo nem commit vazio só para concluir.",
    "A integração Nexus executará novamente sensores main-owned e revisão independente antes de aceitar uma correção ou emitir o receipt físico de validação sem mudança.",
  ].join("\n");
}

function guidedVerificationAuthorityBoundary(
  role: "gate" | "revisão",
): readonly string[] {
  const heading =
    role === "gate"
      ? "Fronteira temporal e de autoridade do gate:"
      : "Fronteira temporal e de autoridade da revisão:";
  return [
    heading,
    "Valide agora o HEAD, o comportamento, os checks e os handoffs predecessores que esta tarefa consegue observar.",
    "São provas Main-owned: dispatch, sessão, encarnação, PTY, tool call, tier de confinamento, ordem de integração, receipts mecânicos e a transição final da missão. O processo principal valida essas provas na etapa apropriada; não tente recriá-las nem exija que nexus_handoff_list as exponha.",
    "A ausência, antes do seu handoff, de receipt final ou de missão done é esperada: ambos só podem existir depois que você enviar o handoff. Isso não é defeito da entrega.",
    "Uma CLI removida do roster pelo preflight ou registrada como skipped por indisponibilidade não é participação pendente. Valide somente os predecessores que a tarefa efetivamente recebeu.",
    "Nunca envie handoff blocked somente porque uma prova Main-owned futura, um advisor não admitido ou um estado pós-handoff ainda não existe. Use blocked apenas para defeito concreto e reproduzível no resultado que você pode observar agora.",
  ];
}
