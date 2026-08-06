/**
 * Identidade de AUTORIDADE de um roster aprovado (digest, 06/08).
 *
 * O gate de aprovação saiu do caminho da missão (zero fricção) e com ele o
 * arquivo de confiança "não perguntar de novo" — não há mais pergunta para
 * lembrar. O que sobrevive é o CONCEITO de c9634478: uma identidade ESTÁVEL
 * do que foi autorizado, imune a re-decomposições do engine e a campos
 * voláteis (conta/effort). Ela serve ao REGISTRO auditável (o log de
 * autorização automática cita o que rodou) e a qualquer válvula futura que o
 * dono decida religar — deliberadamente, nunca por acidente de refactor.
 */

import { createHash } from "node:crypto";

import { isEngineGeneratedSquadId } from "../../shared/orch-types";

/**
 * Squads salvos: a identidade durável é a revisão de ORIGEM registrada pelo
 * selo (a cópia mission-runtime-* tem hash próprio; a origem não muda).
 */
export function missionApprovalTrustRevisionHash(squad: {
  readonly hash: string;
  readonly runtimeSourceSquadId?: string | null;
  readonly runtimeSourceSquadRevisionHash?: string | null;
}): string {
  return squad.runtimeSourceSquadRevisionHash ?? squad.hash;
}

export function missionApprovalTrustIdentityHash(
  squad: {
    readonly id: string;
    readonly hash: string;
    readonly runtimeSourceSquadId?: string | null;
    readonly runtimeSourceSquadRevisionHash?: string | null;
    readonly agents?: readonly {
      readonly category: string;
      readonly cli: string;
      readonly allowedTools: readonly string[] | null;
      readonly allowedSkills: readonly string[] | null;
    }[];
  },
  grantRuntime: {
    readonly adapterId: string;
    readonly model?: string | null;
    readonly readOnly?: boolean;
    readonly nativeReadOnly?: boolean;
    /** Ignorado por design: rotação de conta é política main-owned volátil. */
    readonly accountId?: string | null;
    /** Ignorado por design: tuning de effort não muda a autoridade. */
    readonly effort?: string | null;
  },
): string {
  const originId = squad.runtimeSourceSquadId ?? squad.id;
  if (!isEngineGeneratedSquadId(originId)) {
    return missionApprovalTrustRevisionHash(squad);
  }
  const team = [...(squad.agents ?? [])]
    .map((agent) => ({
      category: agent.category,
      cli: agent.cli,
      allowedTools: agent.allowedTools ? [...agent.allowedTools].sort() : null,
      allowedSkills: agent.allowedSkills
        ? [...agent.allowedSkills].sort()
        : null,
    }))
    .sort(
      (a, b) =>
        a.category.localeCompare(b.category) || a.cli.localeCompare(b.cli),
    );
  const canonical = JSON.stringify({
    kind: "engine-authority",
    team,
    grant: {
      adapterId: grantRuntime.adapterId,
      model: grantRuntime.model ?? null,
      readOnly: grantRuntime.readOnly === true,
      nativeReadOnly: grantRuntime.nativeReadOnly === true,
    },
  });
  return `engine-authority:${createHash("sha256").update(canonical).digest("hex")}`;
}
