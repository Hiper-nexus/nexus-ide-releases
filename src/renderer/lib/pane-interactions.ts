import type { Mission, Squad } from "../../shared/orch-types";
import type { PaneModel } from "../../shared/types";

export const PANE_SKILL_DRAG_TYPE = "application/x-nexus-skill+json";

const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

export interface SkillDragPayload {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
}

export interface SkillDropPolicyInput {
  readonly pane: PaneModel;
  readonly skillName: string;
  readonly missions: readonly Mission[];
  readonly squads: readonly Squad[];
}

export type SkillDropPolicy =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

function validSkillName(value: string): boolean {
  return SAFE_SKILL_NAME.test(value);
}

export function serializeSkillDragPayload(input: {
  readonly id: string;
  readonly name: string;
}): string {
  if (!SAFE_SKILL_ID.test(input.id) || !validSkillName(input.name)) {
    throw new Error("invalid skill drag payload");
  }
  return JSON.stringify({ version: 1, id: input.id, name: input.name });
}

export function parseSkillDragPayload(raw: string): SkillDragPayload | null {
  if (raw.length === 0 || raw.length > 1_024) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed.version !== 1 ||
      typeof parsed.id !== "string" ||
      typeof parsed.name !== "string" ||
      !SAFE_SKILL_ID.test(parsed.id) ||
      !validSkillName(parsed.name)
    ) {
      return null;
    }
    return { version: 1, id: parsed.id, name: parsed.name };
  } catch {
    return null;
  }
}

export function hasSkillDragType(types: ArrayLike<string>): boolean {
  return Array.from(types).includes(PANE_SKILL_DRAG_TYPE);
}

function canonicalSkill(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Renderer preflight only. Mission-bound panes fail closed when their visible
 * roster cannot prove the skill is available. The main-process skill gate
 * remains authoritative after this UX check.
 */
export function resolveSkillDropPolicy({
  pane,
  skillName,
  missions,
  squads,
}: SkillDropPolicyInput): SkillDropPolicy {
  if (pane.kind !== "cli-agent") {
    return {
      allowed: false,
      reason: "Skills só podem ser enviadas a panes de agente.",
    };
  }
  if (!validSkillName(skillName)) {
    return { allowed: false, reason: "O identificador da skill é inválido." };
  }
  if (!pane.missionId) return { allowed: true };

  const mission = missions.find((item) => item.id === pane.missionId);
  const squad = mission?.squadId
    ? squads.find((item) => item.id === mission.squadId)
    : undefined;
  const agent =
    squad && pane.agentName
      ? squad.agents.find((item) => item.agentName === pane.agentName)
      : undefined;
  if (!mission || !squad || !agent) {
    return {
      allowed: false,
      reason: "O roster autorizado da missão ainda não está disponível.",
    };
  }
  if (agent.allowedSkills == null) return { allowed: true };
  const requested = canonicalSkill(skillName);
  const allowed = agent.allowedSkills.some(
    (item) => canonicalSkill(item) === requested,
  );
  return allowed
    ? { allowed: true }
    : {
        allowed: false,
        reason: "A skill não pertence à allowlist deste agente.",
      };
}

export function buildSkillInvocationPrompt(skillName: string): string {
  if (!validSkillName(skillName)) throw new Error("invalid skill name");
  return [
    `Use a skill \`${skillName}\` diretamente nesta tarefa.`,
    "Leia e siga o SKILL.md completo.",
    "A skill não amplia a rota, o escopo, as ferramentas ou as permissões atuais deste pane.",
    "Se o gate do Nexus negar a skill, reporte o bloqueio sem tentar contornar.",
  ].join(" ");
}

export function buildHandoffRequestPrompt(
  pane: Pick<PaneModel, "id" | "role" | "missionId" | "agentName">,
): string {
  if (pane.role !== "worker" || !pane.missionId) {
    throw new Error("handoff request requires a mission worker");
  }
  return [
    `Consolide agora o estado da sua tarefa na missão ${pane.missionId}.`,
    "Envie um handoff durável com `nexus_handoff_submit`, com resumo honesto, status e artefatos verificáveis.",
    "Não marque sucesso sem evidência e não escreva diretamente no pane do orquestrador.",
  ].join(" ");
}

export function buildWorktreePlanningPrompt(
  pane: Pick<PaneModel, "id" | "missionId" | "agentName">,
): string {
  if (!pane.missionId) {
    throw new Error("worktree planning requires a mission");
  }
  const source = pane.agentName ? `${pane.agentName} (${pane.id})` : pane.id;
  return [
    `Na missão ${pane.missionId}, avalie se o trabalho associado ao pane ${source} precisa de isolamento.`,
    "Se precisar, registre a tarefa em `nexus_task plan` com `executionMode=isolated_worktree`, ownership explícito e dependências corretas.",
    "Não materialize o checkout manualmente. O dispatcher main reserva a rota, cria o worktree e integra o handoff.",
  ].join(" ");
}
