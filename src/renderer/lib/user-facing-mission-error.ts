const DEFAULT_UNKNOWN_ERROR =
  "Não foi possível concluir esta etapa. Tente novamente. Se continuar, abra Operações para ver o diagnóstico.";
const MAX_USER_FACING_DETAIL_LENGTH = 180;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateAtWord(
  value: string,
  limit = MAX_USER_FACING_DETAIL_LENGTH,
): string {
  if (value.length <= limit) return value;
  const candidate = value.slice(0, limit - 1);
  const lastSpace = candidate.lastIndexOf(" ");
  const cutAt =
    lastSpace >= Math.floor(limit * 0.7) ? lastSpace : candidate.length;
  return `${candidate.slice(0, cutAt).trimEnd()}…`;
}

/**
 * A refused goal is a mission-state problem, never a wording problem. The raw
 * reason contains "invalid", so without this mapping it fell through to the
 * generic fallback and told the operator to revise their text — sending them
 * into a retype loop against a state that would refuse every attempt.
 */
function refusedGoalRecovery(raw: string): string | null {
  const match = /invalid transition ([a-z_]+) --submit_goal-->/i.exec(raw);
  if (!match) return null;
  switch (match[1]) {
    case "dispatched":
    case "executing":
    case "validating":
      return "A missão já está em execução e não aceita um novo objetivo agora. Pare a missão para redirecioná-la.";
    case "intent_compiling":
      return "O objetivo anterior ainda está sendo compilado. Aguarde um instante e envie de novo.";
    case "done":
      return "Esta missão já foi concluída. Abra uma nova missão para continuar.";
    default:
      return "Esta missão não aceita um novo objetivo no estado atual. Abra Operações para ver o diagnóstico.";
  }
}

function knownMissionRecovery(raw: string): string | null {
  const refusedGoal = refusedGoalRecovery(raw);
  if (refusedGoal) return refusedGoal;
  if (/guided_plan_unborn_with_files/i.test(raw)) {
    return "Esta pasta já tem arquivos sem histórico. Faça o primeiro commit e tente novamente.";
  }
  if (/guided_plan_legacy_receipt_blocked/i.test(raw)) {
    return "O plano aprovado ficou desatualizado. Revise a equipe e aprove a missão novamente.";
  }
  if (/guided_plan_squad_stale/i.test(raw)) {
    return "A equipe mudou depois da revisão. Revise o plano e aprove a missão novamente.";
  }
  if (/guided_plan_(?:executor|reviewer)_missing/i.test(raw)) {
    return "A equipe precisa de execução e revisão independente antes de começar.";
  }
  if (/guided_plan_roster_route_unavailable/i.test(raw)) {
    return "Um integrante da equipe não está disponível nesta máquina. Revise a equipe e tente novamente.";
  }
  if (/project runtime contains an invalid worktree state/i.test(raw)) {
    return "O estado local de uma execução anterior ficou inconsistente. Nenhum agente foi iniciado; encerre a missão travada antes de tentar novamente.";
  }
  if (
    /agent pane did not start after prompt delivery|agent prompt remained live without physical acceptance proof/i.test(
      raw,
    )
  ) {
    return "O agente não ficou pronto a tempo. O Nexus encerrou a execução com segurança; tente novamente.";
  }
  if (/guided post-merge intent authority is stale/i.test(raw)) {
    return "A missão mudou durante a validação. Reabra a missão para continuar com a revisão atual.";
  }
  if (/workspace path was not authorized by the folder picker/i.test(raw)) {
    return 'Autorize esta pasta em “Procurar” e tente novamente.';
  }
  if (/mission runtime source squad is unavailable/i.test(raw)) {
    return "A equipe preparada perdeu o vínculo com esta pasta. Prepare a missão novamente.";
  }
  return null;
}

function stripTransportWrappers(raw: string): string {
  return normalizeWhitespace(
    raw
      .replace(
        /^(?:A missão (?:não foi autorizada|não foi iniciada)|O lançamento imediato não foi autorizado):\s*/i,
        "",
      )
      .replace(/^Error invoking remote method '[^']+':\s*/i, "")
      .replace(/^(?:Error:\s*)+/i, "")
      // Internal snake_case codes can be nested before the human explanation.
      .replace(/^(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+:\s*)+/i, ""),
  );
}

function looksLikeInternalDiagnostic(value: string): boolean {
  return (
    /(?:^|\s)[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}(?=[:\s]|$)/i.test(value) ||
    /\b(?:ipc|preflight|bootstrap|worktree|stack trace|typeerror|referenceerror)\b/i.test(
      value,
    ) ||
    /\b(?:failed|failure|unavailable|invalid|missing|not authorized|not found|cannot|did not|timed? out|timeout|temporarily)\b/i.test(
      value,
    ) ||
    /\b(?:connection|refused|permission denied|access denied|unexpected|unable|could not|was not|is not|server|service|request|response|provider|try again|later)\b/i.test(
      value,
    ) ||
    /https?:\/\/|\bwww\./i.test(value) ||
    /\bE[A-Z]{3,}\b|(?:\/[^/\s]+){2,}/.test(value) ||
    /\bat\s+\S+\s+\([^)]*:\d+:\d+\)/i.test(value)
  );
}

/**
 * Converts transport/provider diagnostics into brief recovery copy for the
 * golden path. Raw details remain available in Operações and mission journals.
 */
export function humanizeMissionErrorDetail(
  detail: string | undefined,
  fallback = DEFAULT_UNKNOWN_ERROR,
): string | undefined {
  if (!detail) return undefined;
  const raw = normalizeWhitespace(detail);
  if (!raw) return undefined;

  const known = knownMissionRecovery(raw);
  if (known) return known;

  const sentence = stripTransportWrappers(raw);
  if (!sentence || looksLikeInternalDiagnostic(sentence)) {
    return fallback;
  }

  const capitalized = `${sentence.charAt(0).toLocaleUpperCase("pt-BR")}${sentence.slice(1)}`;
  return truncateAtWord(capitalized);
}

export function toUserFacingMissionError(
  cause: unknown,
  fallback = DEFAULT_UNKNOWN_ERROR,
): string {
  const detail =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : undefined;
  return humanizeMissionErrorDetail(detail, fallback) ?? fallback;
}
