import type { Mission, SquadAgent } from "../../shared/orch-types";
import type { WorkKind } from "../../shared/mission-work-kind";
import { assertPromotedPlanSnapshot } from "./plan-promotion-authority";
import { supportsMechanicallyReadOnlyCli } from "./mission-scheduler-plan";
import { supportsAdvisoryParticipationCli } from "../../shared/mission-advisory";
import { isGuidedUiMissionObjective } from "./guided-squad-skills";
import {
  DESIGN_SYSTEM_CANDIDATE_PATHS,
  resolveWorkspaceDesignContract,
  type WorkspaceDesignContract,
} from "./design-system-reader";
import {
  DESIGN_SYSTEM_BEGIN,
  DESIGN_SYSTEM_END,
} from "./design-context-format";

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

export interface GuidedWorkKindContractOptions {
  readonly workKind?: WorkKind;
  /** No reproduction body was sealed: the executor owns that proof. */
  readonly reproductionInContractOnly?: boolean;
  /** No regression body was sealed: the gate owns that verification. */
  readonly regressionInContractOnly?: boolean;
  /**
   * Main workspace root used to resolve the design contract at PLAN time.
   *
   * Sealing the bytes (rather than telling the worker to go read a file) is
   * deliberate: the worker runs in an isolated worktree built from a commit, so
   * a contract the bootstrap autopilot just materialized under `.context/` may
   * not physically exist there. Sealing also binds the executor and the gate to
   * the exact revision the plan was approved against.
   */
  readonly workspaceRoot?: string;
  /** Test seam; production always resolves through the workspace reader. */
  readonly resolveDesignContract?: (
    rootDir?: string,
  ) => WorkspaceDesignContract | null;
}

/** Never let an unreadable workspace turn prompt assembly into a plan failure. */
function guidedDesignContract(
  options: GuidedWorkKindContractOptions,
): WorkspaceDesignContract | null {
  const resolve =
    options.resolveDesignContract ?? resolveWorkspaceDesignContract;
  try {
    return resolve(options.workspaceRoot);
  } catch {
    return null;
  }
}

const GUIDED_DESIGN_CANDIDATE_LIST = DESIGN_SYSTEM_CANDIDATE_PATHS.join(" ou ");

/**
 * The blocked reason stops being a bare token the model may or may not echo:
 * the handoff body is templated with the surface and the exact paths Nexus
 * searched, so a human reading `design_contract_missing` learns what to create
 * and where. This adds no authority — it only makes the existing one legible.
 */
function guidedDesignContractMissingHandoff(goal: string): string {
  const surface = goal.replace(/\s+/g, " ").trim().slice(0, 240);
  return (
    "O handoff blocked precisa carregar, textualmente: " +
    `reason=design_contract_missing; superficie=${surface}; ` +
    `caminho_esperado=${DESIGN_SYSTEM_CANDIDATE_PATHS.join(" | ")}`
  );
}

/** The contract itself, fenced as trusted, with the path that answered named. */
function guidedDesignContractBlock(
  contract: WorkspaceDesignContract,
): readonly string[] {
  return [
    `O Nexus resolveu o contrato de design vigente em \`${contract.path}\` e entrega o conteúdo inteiro abaixo. Ele é a autoridade desta superfície: tokens, tipografia, escala de espaçamento, estados e referência visual saem dele, não do seu default.`,
    DESIGN_SYSTEM_BEGIN,
    contract.content.trimEnd(),
    DESIGN_SYSTEM_END,
  ];
}

/**
 * Work-kind clauses for the single writer.
 *
 * These are the ONLY place a work kind changes what the executor is asked to
 * deliver. Keeping them here (and not in the planner) means the graph module
 * decides shape and this module decides obligation — one reason each.
 */
function guidedWorkKindImplementationContract(
  options: GuidedWorkKindContractOptions,
  goal: string,
): readonly string[] {
  if (options.workKind === "bug") {
    return [
      "",
      "Contrato de correção de defeito:",
      options.reproductionInContractOnly
        ? "1. Nenhum agente de reprodução foi selado nesta missão: reproduzir o defeito é obrigação sua. Registre o comando exato e a saída observada antes de alterar qualquer arquivo."
        : "1. Confirme a reprodução entregue pelo agente de reprodução antes de alterar qualquer arquivo; se não conseguir reproduzir, envie handoff blocked em vez de adivinhar a causa.",
      "2. Escreva a verificação durável de regressão ANTES da correção. Ela precisa FALHAR no HEAD atual: cole no handoff o comando e a saída dessa falha.",
      "3. Corrija a causa-raiz e prove que exatamente a MESMA verificação passa depois. Cole no handoff a saída verde.",
      "4. Um teste que passa nos dois HEADs não é regressão: é decoração. Nunca declare sucesso com ele.",
    ];
  }
  if (options.workKind === "doc") {
    return [
      "",
      "Contrato de entrega de documentação:",
      "O artefato desta missão é o documento, não código. Sua ownership contém somente caminhos de documentação e o Nexus rejeita fisicamente qualquer diff fora dela.",
      "Não altere código, configuração, testes ou build para 'apoiar' o documento. Se o documento depender de uma mudança de código, descreva-a e envie handoff blocked.",
      "Não invente API nem comportamento: cada afirmação técnica precisa apontar para arquivo:linha real que você leu no workspace.",
    ];
  }
  if (options.workKind === "visual") {
    const designContract = guidedDesignContract(options);
    return [
      "",
      "Contrato de design obrigatório antes do primeiro CSS:",
      ...(designContract
        ? [
            "Antes de escrever a primeira linha de estilo, CSS ou token, leia o contrato de design vigente desta superfície — você não precisa procurá-lo.",
            ...guidedDesignContractBlock(designContract),
            "Não crie tokens paralelos nem restyle além do que ele autoriza. Se ele não cobrir algo que a superfície exige, diga isso no handoff em vez de improvisar.",
          ]
        : [
            `Antes de escrever a primeira linha de estilo, CSS ou token, o contrato de design vigente desta superfície precisa existir. O Nexus procurou em ${GUIDED_DESIGN_CANDIDATE_LIST} e não encontrou nenhum.`,
            "NÃO invente um contrato e NÃO comece pelo CSS: envie handoff blocked com o motivo `design_contract_missing`.",
            guidedDesignContractMissingHandoff(goal),
          ]),
      "Visual genérico de IA (sparkles, gradiente roxo, glassmorphism, grid de cards idênticos) é rejeição automática na revisão.",
    ];
  }
  return [];
}

function guidedWorkKindGateContract(
  options: GuidedWorkKindContractOptions,
  goal: string,
): readonly string[] {
  if (options.workKind === "bug") {
    return [
      "",
      "Contrato de correção de defeito (gate):",
      "Exija a prova de regressão: a verificação durável precisa falhar no HEAD anterior à correção e passar no HEAD integrado. Rode-a você mesmo no HEAD atual.",
      options.regressionInContractOnly
        ? "Nenhum agente de regressão foi selado nesta missão: conferir os dois lados dessa prova é obrigação sua."
        : "Confira também a evidência do agente de regressão; divergência entre a evidência dele e a sua é defeito.",
      "Se a verificação não existir, ou passar nos dois HEADs, o defeito não foi provado corrigido: bloqueie a entrega.",
    ];
  }
  if (options.workKind === "doc") {
    return [
      "",
      "Contrato de entrega de documentação (gate):",
      "O artefato é o documento. Não exija build, typecheck ou suíte de testes de código como condição de aceite.",
      "Verifique o que é verificável no documento: cada afirmação técnica aponta para arquivo:linha real, os comandos citados existem, e nenhum arquivo de código foi tocado.",
    ];
  }
  if (options.workKind === "visual") {
    const designContract = guidedDesignContract(options);
    return [
      "",
      "Contrato de design (gate):",
      ...(designContract
        ? [
            ...guidedDesignContractBlock(designContract),
            `Se houver CSS, tokens ou estilo no diff, confira-o contra \`${designContract.path}\` — é exatamente o contrato que o executor recebeu. Divergência entre o diff e esse contrato é defeito: bloqueie com a evidência.`,
          ]
        : [
            `O Nexus procurou o contrato de design em ${GUIDED_DESIGN_CANDIDATE_LIST} e não encontrou nenhum.`,
            "Estilo entregue sem contrato de design vigente é defeito: bloqueie com o motivo `design_contract_missing`.",
            guidedDesignContractMissingHandoff(goal),
          ]),
    ];
  }
  return [];
}

export function buildGuidedMissionTaskDetail(
  mission: Mission,
  options: GuidedWorkKindContractOptions = {},
): string {
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
    ...guidedWorkKindImplementationContract(options, contract.goal),
    "",
    "Entregue a menor solução completa e segura. Rode os checks relevantes e não alegue sucesso sem evidência.",
  ].join("\n");
  return detail;
}

/** Read-only stage that must prove the defect BEFORE the single writer runs. */
export function guidedReproductionDetail(
  mission: Mission,
  agent: SquadAgent,
): string {
  const contract = mission.intentContract;
  if (!contract) {
    throw new Error(
      "guided_plan_contract_missing: missão sem contrato aprovado",
    );
  }
  return [
    `Atue como agente de reprodução (${agent.agentName}) ANTES da correção.`,
    "Você está sob confinamento mecânico read-only do Nexus: não edite arquivos e não crie commit.",
    "Sua entrega é a prova do defeito, não a correção:",
    "1. Localize o comportamento defeituoso no HEAD atual e registre o caminho de código exato (arquivo:linha) onde ele nasce.",
    "2. Entregue a RECEITA DE REPRODUÇÃO: comando exato, passos, entrada e saída observada versus a esperada.",
    "3. Proponha a verificação durável de regressão que o executor deve escrever, e explique por que ela FALHA no HEAD atual.",
    "4. Se o defeito não reproduzir, diga isso explicitamente com a evidência: uma correção sem defeito reproduzido é chute.",
    "",
    "Objetivo aprovado:",
    contract.goal,
    "",
    "Critérios de aceite:",
    ...contract.acceptanceCriteria.map(
      (criterion, index) => `${index + 1}. ${criterion}`,
    ),
  ].join("\n");
}

/** Read-only stage that verifies the durable regression check after the fix. */
export function guidedRegressionDetail(
  mission: Mission,
  agent: SquadAgent,
): string {
  const contract = mission.intentContract;
  if (!contract) {
    throw new Error(
      "guided_plan_contract_missing: missão sem contrato aprovado",
    );
  }
  return [
    `Atue como agente de regressão (${agent.agentName}) depois da integração da correção.`,
    "Você está sob confinamento mecânico read-only do Nexus: não edite arquivos e não crie commit.",
    "Critério de aceite desta tarefa: o teste de regressão FALHA no HEAD anterior à correção e PASSA no HEAD integrado.",
    "1. Identifique no diff integrado a verificação durável que cobre o defeito.",
    "2. Rode-a no HEAD atual e cole a saída verde.",
    "3. Prove o outro lado: mostre por que ela falharia sem a correção (a saída da falha registrada pelo executor, o trecho corrigido que ela exercita, ou uma execução equivalente que não escreva no repositório).",
    "4. Se a verificação não existir, ou se você não conseguir demonstrar que ela distinguiria os dois HEADs, envie handoff blocked: o defeito não foi provado corrigido.",
    "",
    "Objetivo aprovado:",
    contract.goal,
    "",
    ...guidedVerificationAuthorityBoundary("revisão"),
    "",
    "Critérios aprovados:",
    ...contract.acceptanceCriteria.map(
      (criterion, index) => `${index + 1}. ${criterion}`,
    ),
  ].join("\n");
}

export function guidedFanoutPlannerId(
  kind: "advisory" | "review" | "warmup",
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

export function guidedWarmupDetail(
  mission: Mission,
  agent: SquadAgent,
): string {
  const contract = mission.intentContract;
  if (!contract) {
    throw new Error(
      "guided_plan_contract_missing: missão sem contrato aprovado",
    );
  }
  return [
    `Aquecimento de ${agent.agentName}: prepare desde já a revisão do diff que será integrado.`,
    "Explore o codebase, mapeie os caminhos que o objetivo aprovado provavelmente tocará e prepare um checklist de revisão/validação (pontos de risco, testes a observar, invariantes a conferir).",
    "Você está sob confinamento mecânico read-only do Nexus: não edite arquivos e não crie commit. O diff ainda não existe — seu trabalho é chegar à revisão com o critério pronto.",
    "Entregue no handoff o checklist e os caminhos mapeados; a revisão formal acontece depois do merge do executor.",
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

export function guidedTeamCoordinationDetail(
  mission: Mission,
  agent: SquadAgent,
): string {
  const contract = mission.intentContract;
  if (!contract) {
    throw new Error(
      "guided_plan_contract_missing: missão sem contrato aprovado",
    );
  }
  const attachments =
    contract.attachmentPaths && contract.attachmentPaths.length > 0
      ? [
          "",
          "Anexos validados pelo Nexus:",
          ...contract.attachmentPaths.map((attachmentPath) => `- ${attachmentPath}`),
        ]
      : [];
  return [
    `Participe como ${agent.agentName} de uma rodada paralela da equipe.`,
    "Responda diretamente ao objetivo sob a perspectiva do seu papel no roster.",
    "Esta tarefa é somente leitura: não edite arquivos, não crie commit, não implemente código e não inicie outra tarefa.",
    "Se o objetivo pedir apenas apresentação, não explore o repositório nem rode testes/build. Se pedir análise, inspecione somente o contexto necessário.",
    "Finalize com um handoff curto, concreto e em português para o Maestro apresentar ao operador.",
    "",
    "Objetivo aprovado:",
    contract.goal,
    "",
    "Critérios de aceite:",
    ...contract.acceptanceCriteria.map(
      (criterion, criterionIndex) => `${criterionIndex + 1}. ${criterion}`,
    ),
    ...attachments,
  ].join("\n");
}

export function guidedIndependentReviewDetail(
  mission: Mission,
  agent: SquadAgent,
  options: {
    readonly qualityGateReadOnly?: boolean;
    /** Autopilot option B: this review is the only quality step after delivery. */
    readonly finalPostDeliveryReview?: boolean;
  } = {},
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
  const qualityClose = options.finalPostDeliveryReview
    ? "Esta é a revisão de qualidade da missão: rode checks não mutantes, confira se o código segue padrões/skills do projeto e critérios de aceite, e envie handoff success com evidências e achados (ou blocked se houver defeito real). Não edite."
    : options.qualityGateReadOnly
      ? "Rode apenas verificações não mutantes e envie handoff success com evidências e achados; o QA final também será mecanicamente read-only e bloqueará a entrega se encontrar um defeito."
      : "Rode apenas verificações não mutantes e envie handoff success com evidências e achados; o QA corretivo final repetirá os checks e corrigirá apenas defeitos reais.";
  return [
    `Atue como revisor independente (${agent.agentName}) após a integração do executor.`,
    "Inspecione o HEAD integrado sem confiar no resumo do autor. Não edite arquivos e não crie commit.",
    confinement,
    qualityClose,
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
  options: { readonly readOnly?: boolean } & GuidedWorkKindContractOptions = {},
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
      ...guidedWorkKindGateContract(options, contract.goal),
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
    ...guidedWorkKindGateContract(options, contract.goal),
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
