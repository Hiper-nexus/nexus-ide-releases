/**
 * Pré-autorização de missão por squad+projeto (atrito peer ADE/Orca).
 *
 * O operador aprova uma vez; enquanto o roster (squadRevisionHash) e o projeto
 * não mudarem, o próximo approve reusa a confiança e pula o modal nativo —
 * ainda produz o `approvalReviewSha256` do review integral (fence intacto).
 *
 * Desligado no gate E2E real: a causalidade exige exatamente um diálogo nativo.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

import type { ProjectExecutionScope } from "../../shared/types";
import { isEngineGeneratedSquadId } from "../../shared/orch-types";
import { isCurrentProcessRealMissionE2E } from "../../shared/real-mission-e2e";

const TRUST_FILE = "mission-approval-trust.json";
const TRUST_SCHEMA_VERSION = 1 as const;

export interface MissionApprovalTrustKey {
  readonly installationId: string;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly squadRevisionHash: string;
}

interface MissionApprovalTrustRecord extends MissionApprovalTrustKey {
  readonly trustedAt: number;
  readonly sourceSquadId?: string;
}

interface MissionApprovalTrustFile {
  readonly schemaVersion: typeof TRUST_SCHEMA_VERSION;
  readonly records: MissionApprovalTrustRecord[];
}

function trustPath(): string {
  return path.join(app.getPath("userData"), TRUST_FILE);
}

function readFile(): MissionApprovalTrustFile {
  try {
    const raw = fs.readFileSync(trustPath(), "utf8");
    const parsed = JSON.parse(raw) as MissionApprovalTrustFile;
    if (
      parsed?.schemaVersion !== TRUST_SCHEMA_VERSION ||
      !Array.isArray(parsed.records)
    ) {
      return { schemaVersion: TRUST_SCHEMA_VERSION, records: [] };
    }
    return parsed;
  } catch {
    return { schemaVersion: TRUST_SCHEMA_VERSION, records: [] };
  }
}

function writeFile(file: MissionApprovalTrustFile): void {
  const dir = path.dirname(trustPath());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${trustPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmp, trustPath());
}

function sameKey(
  left: MissionApprovalTrustKey,
  right: MissionApprovalTrustKey,
): boolean {
  return (
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.squadRevisionHash === right.squadRevisionHash
  );
}

export function missionApprovalTrustKeyFrom(
  scope: Pick<
    ProjectExecutionScope,
    "installationId" | "projectId" | "checkoutId"
  >,
  squadRevisionHash: string,
): MissionApprovalTrustKey {
  return Object.freeze({
    installationId: scope.installationId,
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    squadRevisionHash,
  });
}

/**
 * Identidade de confiança do roster revisado.
 *
 * O approve sela o squad numa cópia imutável `mission-runtime-*` e rebinda a
 * missão nela (renderer-mission-authority: sealMissionSquadForApproval). O hash
 * do snapshot inclui o id, então a cópia tem hash diferente da origem — e o
 * próximo candidato da MESMA missão perderia a confiança que o operador acabou
 * de conceder. A cópia é byte a byte o roster revisado, logo a identidade
 * durável é a revisão de ORIGEM que a selagem registra.
 */
export function missionApprovalTrustRevisionHash(squad: {
  readonly hash: string;
  readonly runtimeSourceSquadId?: string | null;
  readonly runtimeSourceSquadRevisionHash?: string | null;
}): string {
  return squad.runtimeSourceSquadRevisionHash ?? squad.hash;
}

/**
 * Identidade de confiança ESTÁVEL entre decomposições (fix 06/08).
 *
 * Squads gerados pelo engine (`agentic-*`/`custom-*`) re-geram id e hash a
 * cada decomposição — o "não perguntar de novo" gravado nunca voltava a bater
 * (provado em campo: registro às 09:33:50 e o modal de volta às 09:34:57).
 * Para esses squads a identidade durável é o QUE o operador aprovou, não a
 * geração: forma do time (categoria+cli, ordenada), permissões por agente e a
 * autoridade do orquestrador (adapter/modelo/confinamento — nunca conta/effort,
 * que são política main-owned volátil). Squads salvos continuam na revisão de
 * ORIGEM (comportamento 664b534f), que já é estável.
 */
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

/** True when this project+roster was previously delegated by the operator. */
export function hasMissionApprovalTrust(key: MissionApprovalTrustKey): boolean {
  if (isCurrentProcessRealMissionE2E()) return false;
  return readFile().records.some((record) => sameKey(record, key));
}

/** Persist "não perguntar de novo" for this exact project+roster hash. */
export function rememberMissionApprovalTrust(
  key: MissionApprovalTrustKey,
  sourceSquadId?: string,
): void {
  if (isCurrentProcessRealMissionE2E()) return;
  const file = readFile();
  const next: MissionApprovalTrustRecord = Object.freeze({
    ...key,
    trustedAt: Date.now(),
    ...(sourceSquadId ? { sourceSquadId } : {}),
  });
  const records = [
    next,
    ...file.records.filter((record) => !sameKey(record, key)),
  ].slice(0, 64);
  writeFile({ schemaVersion: TRUST_SCHEMA_VERSION, records });
}

/** Test seam: wipe trust file. */
export function clearMissionApprovalTrustForTests(): void {
  try {
    fs.rmSync(trustPath(), { force: true });
  } catch {
    // ignore
  }
}
