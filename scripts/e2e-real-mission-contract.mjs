import { createHash } from "node:crypto";

export const REAL_MISSION_FLAG = "--nexus-real-mission-e2e";
export const REAL_MISSION_PRODUCT_WIZARD_FLAG =
  "--nexus-real-mission-product-wizard-e2e";
// A cadeia multi-CLI v9 é linear (planner → 4 scouts advisor → executor →
// revisor codex → 2 reviewers advisor → QA): 10 PTYs físicos sequenciais com
// modelos reais. 16 min bastavam para o pipeline codex de 4 panes; a suíte
// multi-CLI precisa de folga para boot + turno + handoff de cada advisor.
export const REAL_MISSION_TIMEOUT_MS = 32 * 60_000;
export const REAL_MISSION_EVIDENCE_FILE = "real-mission-evidence.json";
export const REAL_MISSION_EVIDENCE_SCHEMA_VERSION = 9;
export const REAL_MISSION_EXPECTED_CONTENT = "nexus-real-mission-e2e-ok\n";
export const REAL_MISSION_CTA =
  "Abra o relatório de evidências, corrija o estado bloqueado e execute novamente antes da release.";

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIRECTORY_MODE = 0o700;
/**
 * Comma-separated advisor CLI ids whose credentials/binaries were unavailable
 * when the gate staged the isolated HOME. The child observer reads this env to
 * mark those advisors as `skipped: no-credential` instead of failing.
 */
export const REAL_MISSION_ADVISOR_SKIP_ENV = "NEXUS_REAL_MISSION_ADVISOR_SKIP";
export const REAL_MISSION_ADVISOR_SKIP_PATTERN =
  /^[a-z0-9-]+(,[a-z0-9-]+)*$/u;

/**
 * Une o skip pedido pelo operador (já validado no env isolado) com os skips
 * detectados no staging (credencial/binário ausente). Nunca substituir um pelo
 * outro: se o staging achar só `agy` e o operador pediu `claude`, perder o
 * `claude` reintroduz advisor quebrado no roster e pode derrubar o gate com
 * `observer-invalid` / binding inconsistente.
 */
export function mergeRealMissionAdvisorSkipEnv(
  existing,
  autoSkips,
) {
  const merged = new Set();
  if (
    typeof existing === "string" &&
    existing.length > 0 &&
    existing.length <= 256 &&
    REAL_MISSION_ADVISOR_SKIP_PATTERN.test(existing)
  ) {
    for (const part of existing.split(",")) {
      const cli = part.trim();
      if (cli) merged.add(cli);
    }
  }
  for (const cli of autoSkips ?? []) {
    if (typeof cli === "string" && /^[a-z0-9-]+$/u.test(cli)) {
      merged.add(cli);
    }
  }
  return [...merged].sort().join(",");
}
/**
 * Variante de orquestrador do harness: codex (default, ausente) ou claude.
 * O launcher propaga somente valores estritos; o main cai no default codex.
 */
export const REAL_MISSION_ORCHESTRATOR_ENV = "NEXUS_REAL_MISSION_ORCHESTRATOR";
export const REAL_MISSION_ORCHESTRATOR_PATTERN = /^(?:codex|claude)$/u;
export const REAL_MISSION_CLAUDE_ORCHESTRATOR_EVIDENCE_FILE =
  "real-mission-evidence-claude-orchestrator.json";
/**
 * Roster advisor multi-CLI do harness (Fase 2), na ordem canônica que a
 * evidência registra. Advisors entram somente em tarefas read_only do fan-out
 * consultivo; o pipeline executor → revisor → QA continua codex-only.
 * Tier: grok/claude = mechanically-confined (Seatbelt/argv governado nativo);
 * kimi/agy/opencode/omp/glm = advisory-unconfined (MCP + Seatbelt Nexus).
 * GLM reuses the Claude Code binary with z.ai ANTHROPIC_* env (API key).
 */
export const REAL_MISSION_ADVISORS = Object.freeze([
  Object.freeze({
    id: "e2e-advisor-grok",
    name: "E2E Advisor Grok",
    cli: "grok",
    category: "reviewer",
    tier: "mechanically-confined",
  }),
  Object.freeze({
    id: "e2e-advisor-kimi",
    name: "E2E Advisor Kimi",
    cli: "kimi",
    category: "scout",
    tier: "advisory-unconfined",
  }),
  Object.freeze({
    id: "e2e-advisor-agy",
    name: "E2E Advisor Agy",
    cli: "agy",
    category: "scout",
    tier: "advisory-unconfined",
  }),
  Object.freeze({
    id: "e2e-advisor-opencode",
    name: "E2E Advisor OpenCode",
    cli: "opencode",
    category: "scout",
    tier: "advisory-unconfined",
  }),
  Object.freeze({
    id: "e2e-advisor-omp",
    name: "E2E Advisor OMP",
    cli: "omp",
    category: "scout",
    tier: "advisory-unconfined",
  }),
  Object.freeze({
    id: "e2e-advisor-claude",
    name: "E2E Advisor Claude",
    cli: "claude",
    category: "reviewer",
    tier: "mechanically-confined",
  }),
  Object.freeze({
    id: "e2e-advisor-glm",
    name: "E2E Advisor GLM",
    cli: "glm",
    category: "scout",
    tier: "advisory-unconfined",
  }),
]);

/**
 * Cadeia linear exata selada pelo Guided Planner para o conjunto de advisors
 * presentes (não-skipped): scouts advisor → executor codex → revisor codex →
 * reviewers advisor → QA codex. Cada membro depende exatamente do anterior.
 */
export function realMissionExpectedTaskChain(presentAdvisorClis) {
  const present = new Set(presentAdvisorClis);
  const scouts = REAL_MISSION_ADVISORS.filter(
    (advisor) => advisor.category === "scout" && present.has(advisor.cli),
  );
  const reviewAdvisors = REAL_MISSION_ADVISORS.filter(
    (advisor) => advisor.category === "reviewer" && present.has(advisor.cli),
  );
  const reviewers = [
    { id: "e2e-reviewer", name: "E2E Revisor", cli: "codex" },
    ...reviewAdvisors,
  ];
  return [
    ...scouts.map((advisor, index) => ({
      agentRef: advisor.id,
      agentName: advisor.name,
      cli: advisor.cli,
      agentCategory: "scout",
      plannerId: `guided-advisory-${index + 1}-${advisor.id}`,
      executionMode: "read_only",
      kind: "advisory",
    })),
    {
      agentRef: "e2e-executor",
      agentName: "E2E Executor",
      cli: "codex",
      agentCategory: "executor",
      plannerId: "guided-execution",
      executionMode: "isolated_worktree",
      kind: "execution",
    },
    ...reviewers.map((reviewer, index) => ({
      agentRef: reviewer.id,
      agentName: reviewer.name,
      cli: reviewer.cli,
      agentCategory: "reviewer",
      plannerId: `guided-review-${index + 1}-${reviewer.id}`,
      executionMode: "read_only",
      kind: "review",
    })),
    {
      agentRef: "e2e-qa",
      agentName: "E2E QA",
      cli: "codex",
      agentCategory: "reviewer",
      plannerId: "guided-quality-gate",
      executionMode: "read_only",
      kind: "quality-gate",
    },
  ];
}
export const REAL_MISSION_CHILD_PHASES = new Set([
  "spawned",
  "booting",
  "renderer-mounted",
  "orchestration-ready",
  "fixture-persisted",
  "fixture-prepared",
  "observer-armed",
  "product-wizard-ready",
  "product-wizard-launch-clicked",
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
  "advisor-absent",
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
  "Cada CLI advisor credenciada (grok, kimi, agy, opencode, omp, claude) abre PTY físico, chama ao menos uma tool nexus_* e submete nexus_handoff_submit; a evidência registra o tier de confinamento de cada uma.",
]);
export const REAL_MISSION_CLAUDE_ORCHESTRATOR_CRITERION =
  "A variante orquestrador Claude executa o ciclo completo (kickoff→dispatch→handoffs→integração→done) com o pipeline codex e advisors não-Claude, sem segundo processo Claude.";
export const REAL_MISSION_CLAUDE_ORCHESTRATOR_ACCEPTANCE_CRITERIA =
  Object.freeze([
    ...REAL_MISSION_ACCEPTANCE_CRITERIA,
    REAL_MISSION_CLAUDE_ORCHESTRATOR_CRITERION,
  ]);
export function realMissionAcceptanceCriteria(orchestratorCli) {
  return orchestratorCli === "claude"
    ? REAL_MISSION_CLAUDE_ORCHESTRATOR_ACCEPTANCE_CRITERIA
    : REAL_MISSION_ACCEPTANCE_CRITERIA;
}
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

export function productWizardReceiptChainSha256(receipt) {
  return sha256(
    JSON.stringify({
      version: "nexus-product-wizard-causal-chain-v1",
      origin: receipt?.origin,
      missionId: receipt?.missionId,
      workspaceSha256: receipt?.workspaceSha256,
      sourceSquadRevisionHash: receipt?.sourceSquadRevisionHash,
      squadRevisionHash: receipt?.squadRevisionHash,
      submittedContractSha256: receipt?.submittedContractSha256,
      approvedContractSha256: receipt?.approvedContractSha256,
      armedAt: receipt?.armedAt,
      intentSubmittedAt: receipt?.intentSubmittedAt,
      nativeDialogOpenedAt: receipt?.nativeDialogOpenedAt,
      nativeDialogAcceptedAt: receipt?.nativeDialogAcceptedAt,
      approvalReturnedAt: receipt?.approvalReturnedAt,
    }),
  );
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
