import { createHash } from "node:crypto";

export const REAL_MISSION_FLAG = "--nexus-real-mission-e2e";
export const REAL_MISSION_PRODUCT_WIZARD_FLAG =
  "--nexus-real-mission-product-wizard-e2e";
export const REAL_MISSION_TIMEOUT_MS = 16 * 60_000;
export const REAL_MISSION_EVIDENCE_FILE = "real-mission-evidence.json";
export const REAL_MISSION_EVIDENCE_SCHEMA_VERSION = 7;
export const REAL_MISSION_EXPECTED_CONTENT = "nexus-real-mission-e2e-ok\n";
export const REAL_MISSION_CTA =
  "Abra o relatório de evidências, corrija o estado bloqueado e execute novamente antes da release.";

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const REAL_MISSION_CHILD_PHASES = new Set([
  "spawned",
  "booting",
  "renderer-mounted",
  "orchestration-ready",
  "fixture-persisted",
  "fixture-prepared",
  "observer-armed",
  "product-wizard-ready",
]);
export const REAL_MISSION_FAILURE_CODES = new Set([
  "setup-failed",
  "renderer-failed",
  "observer-invalid",
  "mission-blocked",
  "mission-failed",
  "invariant-failed",
  "timeout",
  "app-error",
  "mcp-prompt-detected",
]);
export const REAL_MISSION_FAILURE_REASONS = new Set([
  "boot_timeout",
  "timeout",
  "session_exited",
  "write_failed",
  "authority_lost",
]);
export const REAL_MISSION_STATUSES = new Set([
  "pending",
  "running",
  "blocked",
  "done",
  "failed",
]);
export const SAFE_CHILD_ENV_KEYS = new Set([
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TZ",
  "USER",
]);
export const RELEASE_IDENTITY_PATTERN =
  /^Developer ID Application: .+ \([A-Z0-9]{10}\)$/u;
export const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export const GIT_SHA_PATTERN = /^[a-f0-9]{40,64}$/u;
export const MISSION_DRIVER_WORKFLOW_STAGES = new Set([
  "planning",
  "review-primary",
  "review-secondary",
  "execution",
  "validation-primary",
  "validation-secondary",
  "confirmation",
  "complete",
]);
export const REAL_MISSION_ACCEPTANCE_CRITERIA = Object.freeze([
  "O executor Codex do roster cria resultado.txt no próprio worktree — nunca o orquestrador nem o processo main.",
  "resultado.txt contém exatamente nexus-real-mission-e2e-ok seguido de newline.",
  "O próprio executor faz o commit local e chama nexus_handoff_submit; sessão e encarnação conferem com o primeiro dispatch.",
  "O motor Nexus integra o commit antes de liberar a tarefa dependente do revisor.",
  "O revisor Codex abre um segundo PTY físico, valida o HEAD integrado e chama nexus_handoff_submit sem commit vazio nem alteração cosmética.",
  "O motor Nexus emite worktree_validated_no_change para o revisor antes de liberar a tarefa dependente de QA.",
  "O QA Codex abre um terceiro PTY físico, consome o handoff do revisor e valida o HEAD integrado; o QA não deve editar, alterar ou escrever arquivos e chama nexus_handoff_submit sem mudança artificial.",
  "O motor Nexus emite o receipt final worktree_validated_no_change e marca a missão done sem atalho manual.",
]);
export const REAL_MISSION_GOAL =
  'Entregue resultado.txt com o conteúdo exato "nexus-real-mission-e2e-ok\\n". ' +
  "O executor deve implementar e enviar seu handoff; depois um revisor independente " +
  "deve validar o HEAD integrado e enviar seu handoff; por fim o QA deve validar a " +
  "revisão integrada e enviar o terceiro handoff. O QA não deve editar, alterar ou " +
  "escrever arquivos nem criar mudança artificial. " +
  "O orquestrador não pode editar nem commitar o arquivo.";
export const REAL_MISSION_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA = Object.freeze([
  `Objetivo concluído conforme: ${REAL_MISSION_GOAL}`,
]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  const seen = new Set();
  const visit = (input, inArray) => {
    if (input === null) return "null";
    if (typeof input === "string" || typeof input === "boolean") {
      return JSON.stringify(input);
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) {
        throw new Error("canonical JSON rejects non-finite numbers");
      }
      return JSON.stringify(Object.is(input, -0) ? 0 : input);
    }
    if (typeof input === "undefined") return inArray ? "null" : undefined;
    if (typeof input !== "object" || seen.has(input)) {
      throw new Error("canonical JSON rejects unsupported or cyclic values");
    }
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        return `[${input.map((item) => visit(item, true) ?? "null").join(",")}]`;
      }
      const members = [];
      for (const key of Object.keys(input).sort()) {
        const encoded = visit(input[key], false);
        if (encoded !== undefined) {
          members.push(`${JSON.stringify(key)}:${encoded}`);
        }
      }
      return `{${members.join(",")}}`;
    } finally {
      seen.delete(input);
    }
  };
  const encoded = visit(value, false);
  if (encoded === undefined) {
    throw new Error("canonical JSON root cannot be undefined");
  }
  return encoded;
}

export function milestoneAttestationId(missionId, stepId, binding) {
  return `milestone:${sha256(canonicalJson({
    version: "nexus-milestone-validation-v1",
    missionId,
    milestoneId: stepId,
    binding,
  }))}`;
}

export function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

export function hasExactKeys(value, expectedKeys) {
  const item = record(value);
  if (!item) return false;
  const actual = Object.keys(item).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}
