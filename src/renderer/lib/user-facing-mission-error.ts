const DEFAULT_UNKNOWN_ERROR =
  "Não foi possível concluir esta etapa. Tente novamente. Se continuar, abra a missão e veja a aba Atividade.";
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
      return "Esta missão não aceita um novo objetivo no estado atual. Abra a missão e veja a aba Atividade.";
  }
}

/**
 * F-1470: o Main recusa o coordenador recém-aberto listando o que divergiu
 * (`...mismatched: account[diferente], model[a != b]`). O banner mostrava o
 * inglês cru; cada rótulo vira a ação que destrava. Build antigo sem rótulos
 * cai na cópia genérica.
 */
function refusedCoordinatorBindRecovery(raw: string): string | null {
  const match =
    /orchestrator physical spawn authority is missing or mismatched(?::\s*(.*))?/i.exec(
      raw,
    );
  if (!match) return null;
  const labels = match[1] ?? "";
  const retry = "Revise a equipe e aprove a missão de novo.";
  if (/\bother-orchestrator\[/i.test(labels)) {
    return "Já há outro coordenador rodando nesta missão. Feche os panes antigos do coordenador e use Retomar o coordenador.";
  }
  if (/\baccount\[/i.test(labels)) {
    return `O coordenador não voltou porque a conta aprovada para ele mudou. ${retry}`;
  }
  if (/\b(?:model|effort)\[/i.test(labels)) {
    return `O coordenador não voltou porque o modelo ou o esforço aprovado mudou. ${retry}`;
  }
  if (/\b(?:seal|intent|adapter)\b/i.test(labels)) {
    return `O coordenador não voltou porque a equipe aprovada mudou. ${retry}`;
  }
  return "O coordenador não voltou. Use Retomar o coordenador; se repetir, use Reportar bug.";
}

function knownMissionRecovery(raw: string): string | null {
  const refusedGoal = refusedGoalRecovery(raw);
  if (refusedGoal) return refusedGoal;
  const refusedCoordinator = refusedCoordinatorBindRecovery(raw);
  if (refusedCoordinator) return refusedCoordinator;
  // F-245: retry-kickoff com o pane do coordenador fechado pelo operador.
  if (/orchestrator_operator_dismissed/i.test(raw)) {
    return "Você fechou o pane do coordenador. Clique em Retomar para reabrir a missão.";
  }
  if (/guided_plan_unborn_with_files/i.test(raw)) {
    return "Esta pasta já tem arquivos sem histórico. Faça o primeiro commit e tente novamente.";
  }
  if (/guided_plan_legacy_receipt_blocked/i.test(raw)) {
    return "O plano aprovado ficou desatualizado. Revise a equipe e aprove a missão novamente.";
  }
  if (/guided_plan_squad_unbound/i.test(raw)) {
    return "Esta missão ainda não foi aprovada. Revise a equipe e aprove para começar.";
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
  if (
    /guided_prevc_context_bootstrap_blocked/i.test(raw) ||
    /guided_plan_preflight_blocked:[\s\S]*guided_prevc_context_bootstrap_blocked/i.test(
      raw,
    )
  ) {
    if (
      /invalid-context-attestation|missing-context-attestation/i.test(raw)
    ) {
      return "O contexto do projeto precisa de revisão: remova os arquivos inválidos em .context e tente de novo.";
    }
    return "O contexto do projeto não ficou pronto a tempo. Tente iniciar novamente.";
  }
  if (
    /workflow binding requires a clean committed checkout of the evidence surface/i.test(
      raw,
    )
  ) {
    return "Há arquivos não commitados em .context (evidência). Faça commit ou remova o arquivo sujo e tente novamente.";
  }
  if (/squad_runtime_unavailable:executor-unavailable/i.test(raw)) {
    return "Falta um executor com CLI autenticada e rota ativa (não-Claude). Troque o executor no squad ou autentique a CLI.";
  }
  if (/squad_runtime_unavailable:reviewer-unavailable/i.test(raw)) {
    return "Falta um reviewer/QA com CLI autenticada e rota ativa (não-Claude). Troque o reviewer ou autentique a CLI.";
  }
  if (/squad_runtime_unavailable:maestro-unverified/i.test(raw)) {
    // "Configurações › Orquestração" não existe na nav: o controle
    // (squadCliPolicy) vive em OrchestratorDefaults, dentro de Squads.
    return "O Maestro escolhido não está verificado nesta release. Ative Escolha livre em Configurações › Squads ou use Claude/Codex.";
  }
  if (/squad_runtime_unavailable:maestro-unavailable/i.test(raw)) {
    return "O Maestro não tem rota ativa. Autentique a CLI do Maestro e tente novamente.";
  }
  if (/squad_runtime_unavailable:/i.test(raw)) {
    const detail = /squad_runtime_unavailable:[a-z-]+:\s*(.+)$/i.exec(raw)?.[1];
    return detail
      ? truncateAtWord(
          `${detail.charAt(0).toLocaleUpperCase("pt-BR")}${detail.slice(1)}.`,
        )
      : "A equipe não está pronta para iniciar. Revise Maestro, executor e reviewer.";
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
    return 'Escolha a pasta de novo em “Escolher pasta” — o Nexus precisa da sua autorização para abri-la.';
  }
  if (/mission runtime source squad is unavailable/i.test(raw)) {
    return "A equipe preparada perdeu o vínculo com esta pasta. Prepare a missão novamente.";
  }
  // Orientação da equipe (DirectionComposer): as recusas do caminho direct
  // chegavam cruas em inglês (print 29/09) — cada uma vira a ação que destrava.
  if (/mission direct requires the current kickoff receipt/i.test(raw)) {
    return "A coordenação ainda está recebendo o briefing da missão. Envie de novo em alguns segundos.";
  }
  if (
    /mission direct (?:requires a live orchestrator session|orchestrator session is not live)/i.test(
      raw,
    )
  ) {
    return "O Maestro desta missão não está rodando. Use Retomar no Quadro para religá-lo.";
  }
  if (
    /mission direct orchestrator authority (?:is incomplete|mismatch)/i.test(
      raw,
    )
  ) {
    return "A missão não reconhece o terminal do Maestro. Use «Religar a missão ao Maestro» no Quadro.";
  }
  if (
    /mission direct target (?:requires sealed squad authority|squad authority is stale|agent is not in the sealed squad|is not an agent of this mission)/i.test(
      raw,
    )
  ) {
    return "O agente escolhido não faz parte desta missão. Envie para @todos.";
  }
  if (/mission direct requires live current dispatch authority/i.test(raw)) {
    return "A missão está parada. Use Retomar no Quadro antes de orientar a equipe.";
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

/**
 * Machine residue that is never operator copy in any language: internal snake
 * codes, stack frames, URLs, filesystem paths and errno-style constants.
 */
function containsErrnoStyleToken(value: string): boolean {
  // ENOENT/EACCES — not authored caps like EXATAMENTE (065 title).
  return /\bE[A-Z]{3,}\b/.test(value);
}

function containsMachineResidue(value: string): boolean {
  return (
    /(?:^|\s)[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}(?=[:\s]|$)/i.test(value) ||
    /\b(?:stack trace|typeerror|referenceerror)\b/i.test(value) ||
    /https?:\/\/|\bwww\./i.test(value) ||
    /(?:\/[^/\s]+){2,}/.test(value) ||
    /\bat\s+\S+\s+\([^)]*:\d+:\d+\)/i.test(value)
  );
}

/**
 * Portuguese prose here means copy a Nexus author wrote for the operator.
 * Accents or common function words are enough — these strings are authored,
 * not emitted by a transport or a provider SDK.
 */
function looksLikeAuthoredPortuguese(value: string): boolean {
  return (
    /[áàâãéêíóôõúüç]/i.test(value) ||
    /\b(?:não|missão|equipe|objetivo|aprovada?|exige|revise|tente|novamente|pasta|antes|nenhum|precisa|quando|porque)\b/i.test(
      value,
    )
  );
}

/**
 * Guards the golden path against raw transport/provider English.
 *
 * Field trap (28/07): the word list also matched *authored Portuguese* that
 * merely mentioned a technical noun — "O bootstrap exige uma missão running
 * com intenção aprovada. CTA: Retomar missão." was replaced by "tente
 * novamente", discarding a message that already told the operator exactly what
 * to do. Authored Portuguese now passes through; only machine residue and
 * genuinely English diagnostics are withheld.
 */
function looksLikeInternalDiagnostic(value: string): boolean {
  if (containsMachineResidue(value)) return true;
  if (looksLikeAuthoredPortuguese(value)) return false;
  if (containsErrnoStyleToken(value)) return true;
  return (
    /\b(?:ipc|preflight|bootstrap|worktree)\b/i.test(value) ||
    /\b(?:failed|failure|unavailable|invalid|missing|not authorized|not found|cannot|did not|timed? out|timeout|temporarily)\b/i.test(
      value,
    ) ||
    /\b(?:connection|refused|permission denied|access denied|unexpected|unable|could not|was not|is not|server|service|request|response|provider|try again|later)\b/i.test(
      value,
    )
  );
}

const MAX_TECHNICAL_DETAIL_LENGTH = 160;

/**
 * Last-resort disclosure for a failure with no mapped recovery.
 *
 * The golden path deliberately keeps English transport noise out of mapped
 * errors, and that stays true. But a *pre-launch* failure has no mission
 * journal to fall back on — "tente novamente" with nothing else left the
 * operator retrying a mission that could never start, with no way to report
 * what broke. When we genuinely have no recovery to offer, an opaque message
 * is worse than a technical one: the raw reason is appended, clearly labelled
 * and truncated, so it can be acted on or reported.
 */
function technicalDetailSuffix(raw: string): string {
  const stripped = stripTransportWrappers(raw) || raw;
  const detail = truncateAtWord(stripped, MAX_TECHNICAL_DETAIL_LENGTH);
  return detail ? ` Detalhe técnico: ${detail}` : "";
}

/**
 * Converts transport/provider diagnostics into brief recovery copy for the
 * golden path. Mapped errors stay clean; only the unmapped fallback carries
 * the raw reason, because there is nothing better to give the operator.
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
    return `${fallback}${technicalDetailSuffix(raw)}`;
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

/**
 * Main product surfaces have an Operations trail for diagnostics. Keep their
 * recovery copy actionable without repeating transport paths or stack residue.
 */
export function toUserFacingMissionRecovery(
  cause: unknown,
  fallback = DEFAULT_UNKNOWN_ERROR,
): string {
  return (
    toUserFacingMissionError(cause, fallback).split(" Detalhe técnico:", 1)[0] ??
    fallback
  );
}
