export type StandardMissionTopology =
  | "delivery"
  | "team-read-only-fanout"
  | "wave-pack";

export const TEAM_READ_ONLY_FANOUT_DOMAIN = "team-read-only-fanout";

const TEAM_SCOPE =
  /\b(?:todos?\s+(?:os\s+|as\s+)?(?:panes?|agentes?|especialistas?|membros?|workers?)|cada\s+(?:pane|agente|especialista|membro|worker)|toda\s+a\s+equipe|equipe\s+inteira|all\s+(?:the\s+)?(?:panes?|agents?|specialists?|workers?|team\s+members?)|each\s+(?:pane|agent|specialist|worker|team\s+member)|the\s+whole\s+team)\b/;

const TEAM_RESPONSE =
  /\b(?:fal(?:a|e|em|ar)|dig(?:a|am)|respond(?:a|am|er)|explic(?:a|ar|am)|expliqu(?:e|em)|descrev(?:a|am|er)|relat(?:a|ar|em)|apresent(?:a|ar|e|em)|tell|say|respond|explain|describe|report|present)\b/;

const TEAM_RESPONSE_SUBJECT =
  /\b(?:papel|funcao|o\s*que\s+(?:\w+\s+){0,2}(?:faz|fazem)|oque\s+(?:\w+\s+){0,2}(?:faz|fazem)|perspectiva|opiniao|achados?|riscos?|recomendacoes?|diagnostico|contexto|analise|role|what\s+(?:it|they|you)\s+do|perspective|opinion|findings?|risks?|recommendations?|diagnosis|context|analysis)\b/;

const TEAM_RUNTIME_OBSERVATION =
  /\b(?:teste|testar|quero\s+ver|ver\s+como(?:\s+se\s+sai)?|test|watch\s+how)\b/;

const TEAM_RUNNING_ACTIVITY = /\b(?:rodando|executando|running)\b/;

const TEAM_ANALYSIS_ACTIVITY = /\b(?:analisando|analyzing)\b/;

const TEAM_OUTPUT_ACTIVITY =
  /\b(?:soltando|respondendo|relatando|answering|reporting)\b/;

const SHORT_PANE_SMOKE_TEST =
  /^(?:teste|testar|test)\s+(?:de\s+|the\s+)?panes?$/;

const ROLE_RESPONSE_SUBJECT =
  /\b(?:papel|funcao|o\s*que\s+(?:\w+\s+){0,2}(?:faz|fazem)|oque\s+(?:\w+\s+){0,2}(?:faz|fazem)|role|what\s+(?:it|they|you)\s+do)\b/;

const EXPLICIT_READ_ONLY =
  /\b(?:somente\s+leitura|apenas\s+leitura|sem\s+(?:editar|alterar|modificar|escrever)|nao\s+(?:edite|altere|modifique|escreva)|read[- ]only|without\s+(?:editing|changing|modifying|writing)|do\s+not\s+(?:edit|change|modify|write))\b/;

const MUTATING_ACTION =
  /\b(?:implement(?:a|ar|e|em|acao)|corr(?:ig|ij)(?:a|ir|e|em)|consert(?:a|ar|e|em)|melhor(?:a|ar|e|em)|otimiz(?:a|ar|e|em)|resolv(?:a|am|e|em|er)|entreg(?:a|ar|ue|uem)|apliqu(?:a|e|em|ar)(?:r)?(?:\s+\w+){0,4}\s+correc(?:ao|oes)|fac(?:a|am|er)(?:\s+\w+){0,4}\s+(?:mudancas?|alteracoes?|correcoes?)|refator\w*|cod(?:a|ar|em)|commit\w*|merge\w*|deploy\w*|public(?:a|ar|e|em)|edit(?:a|ar|e|em)|modific(?:a|ar|e|em)|alter(?:a|ar|e|em)|adicion(?:a|ar|e|em)|constru(?:a|ir|am)|desenvolv(?:a|er|am)|(?:escrev|grav)(?:a|am|er)\s+(?:o\s+|um\s+|uma\s+)?(?:codigo|arquivo|feature|funcao|componente|endpoint|tela|schema)|(?:cri|remov|exclu|apag)(?:a|ar|e|em)\s+(?:o\s+|um\s+|uma\s+)?(?:codigo|arquivo|feature|funcao|componente|endpoint|tela|painel|dashboard|interface|pagina|site|app|schema)|implement|fix|improve|optimi[sz]e|resolve|deliver|refactor|commit|merge|deploy|publish|edit|modify|change|build|develop|(?:write|create|add|remove|delete|update)\s+(?:the\s+|a\s+|an\s+|one\s+)?(?:code|file|feature|function|component|endpoint|screen|panel|dashboard|interface|page|site|app|schema))\b/;

const PRODUCT_SURFACE_MUTATION =
  /(?:\b(?:fac(?:a|am|er)|cri(?:a|e|em|ar)|constru(?:a|am|ir)|desenvolv(?:a|am|er)|mostr(?:a|ar|e|em)|exib(?:a|ir|am)|make|create|build|develop|show|display|render)\b[^.!?\n]{0,160}\b(?:tela|painel|dashboard|interface|pagina|site|app|screen|panel|page|website|ui)\b|\b(?:tela|painel|dashboard|interface|pagina|site|app|screen|panel|page|website|ui)\b[^.!?\n]{0,160}\b(?:mostr(?:a|ar|e|em)|exib(?:a|ir|am)|show|display|render)\b)/;

const ROLE_REQUEST_PREFIX_WORDS = new Set([
  "a",
  "agente",
  "agentes",
  "agent",
  "agents",
  "all",
  "as",
  "ask",
  "cada",
  "da",
  "das",
  "de",
  "devem",
  "descreva",
  "descrevam",
  "descrever",
  "describe",
  "diga",
  "digam",
  "do",
  "dos",
  "e",
  "each",
  "especialista",
  "especialistas",
  "equipe",
  "explain",
  "explica",
  "explicam",
  "explicar",
  "explique",
  "expliquem",
  "fala",
  "fale",
  "falem",
  "falar",
  "favor",
  "gostaria",
  "have",
  "i",
  "inteira",
  "is",
  "its",
  "like",
  "me",
  "member",
  "members",
  "membro",
  "membros",
  "nos",
  "o",
  "ouvir",
  "os",
  "pane",
  "panes",
  "peca",
  "please",
  "por",
  "preciso",
  "present",
  "qual",
  "que",
  "quero",
  "relata",
  "relatar",
  "relatem",
  "report",
  "respond",
  "responda",
  "respondam",
  "responder",
  "say",
  "seu",
  "sua",
  "specialist",
  "specialists",
  "team",
  "tell",
  "teste",
  "the",
  "their",
  "to",
  "toda",
  "todos",
  "um",
  "uma",
  "us",
  "what",
  "whole",
  "worker",
  "workers",
  "would",
  "your",
]);

const ROLE_RESPONSE_SUFFIX_WORDS = new Set([
  "a",
  "aqui",
  "app",
  "atual",
  "atualmente",
  "briefly",
  "context",
  "contexto",
  "curta",
  "current",
  "currently",
  "da",
  "de",
  "dentro",
  "do",
  "em",
  "essa",
  "esse",
  "esta",
  "este",
  "favor",
  "frase",
  "here",
  "in",
  "mission",
  "missao",
  "na",
  "naquela",
  "naquele",
  "nas",
  "nessa",
  "nesse",
  "nesta",
  "neste",
  "nexus",
  "no",
  "nos",
  "on",
  "our",
  "para",
  "por",
  "please",
  "project",
  "projeto",
  "repository",
  "repositorio",
  "resumidamente",
  "short",
  "sistema",
  "system",
  "that",
  "the",
  "this",
  "to",
  "uma",
  "us",
  "within",
]);

const EXPLICIT_READ_ONLY_REQUEST_WORDS = new Set([
  ...ROLE_REQUEST_PREFIX_WORDS,
  ...ROLE_RESPONSE_SUFFIX_WORDS,
  "achado",
  "achados",
  "analise",
  "analisem",
  "analisar",
  "altere",
  "alterar",
  "analysis",
  "analyze",
  "and",
  "apenas",
  "apresente",
  "apresentem",
  "arquivo",
  "arquivos",
  "audit",
  "audite",
  "auditem",
  "avalie",
  "avaliem",
  "check",
  "change",
  "changing",
  "code",
  "codigo",
  "compare",
  "comparem",
  "comparar",
  "diagnosis",
  "diagnostico",
  "documentacao",
  "editing",
  "edit",
  "editar",
  "edite",
  "escreva",
  "escrever",
  "evaluate",
  "examine",
  "find",
  "finding",
  "findings",
  "identifique",
  "identifiquem",
  "identify",
  "inspect",
  "inspecione",
  "inspecionem",
  "investigate",
  "investigue",
  "investiguem",
  "leia",
  "leiam",
  "leitura",
  "modifique",
  "modify",
  "modificar",
  "modifying",
  "nao",
  "not",
  "only",
  "opiniao",
  "opinioes",
  "paralelo",
  "perspectiva",
  "perspectivas",
  "pesquise",
  "pesquisem",
  "read",
  "recommendation",
  "recommendations",
  "recomendacao",
  "recomendacoes",
  "review",
  "revise",
  "revisem",
  "risk",
  "risks",
  "risco",
  "riscos",
  "sem",
  "seus",
  "somente",
  "without",
  "write",
  "writing",
]);

function canonicalGoal(goal: string): string {
  return goal
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    // ponytail: normalize the observed one-key typo without opening fuzzy routing.
    .replace(/\btopdos?\b/g, "todos")
    .replace(/\s+/g, " ")
    .trim();
}

function words(value: string): string[] {
  return value.match(/[a-z0-9]+/g) ?? [];
}

function hasClosedRoleResponse(goal: string): boolean {
  const subject = ROLE_RESPONSE_SUBJECT.exec(goal);
  if (!subject) return false;
  const subjectEnd = subject.index + subject[0].length;
  return (
    words(goal.slice(0, subject.index)).every((word) =>
      ROLE_REQUEST_PREFIX_WORDS.has(word),
    ) &&
    words(goal.slice(subjectEnd)).every((word) =>
      ROLE_RESPONSE_SUFFIX_WORDS.has(word),
    )
  );
}

function hasClosedExplicitReadOnlyResponse(goal: string): boolean {
  return words(goal).every((word) =>
    EXPLICIT_READ_ONLY_REQUEST_WORDS.has(word),
  );
}

/**
 * Selects a different standard-lane graph only for an explicit, high-confidence
 * request that every squad participant should inspect/respond independently.
 *
 * Ambiguous wording and any mutation signal stay on the delivery graph. This
 * keeps classification fast and restart-stable without asking an LLM to make
 * an authority decision on every mission.
 */
export function classifyStandardMissionTopology(
  goal: string,
): StandardMissionTopology {
  const canonical = canonicalGoal(goal);
  const hasObservedTeamRuntime =
    TEAM_RUNTIME_OBSERVATION.test(canonical) &&
    TEAM_RUNNING_ACTIVITY.test(canonical) &&
    TEAM_ANALYSIS_ACTIVITY.test(canonical) &&
    TEAM_OUTPUT_ACTIVITY.test(canonical);
  const hasShortPaneSmokeTest =
    canonical.split(" ").length <= 4 && SHORT_PANE_SMOKE_TEST.test(canonical);
  const hasClosedReadOnlyRequest =
    (
      EXPLICIT_READ_ONLY.test(canonical) &&
      hasClosedExplicitReadOnlyResponse(canonical)
    ) ||
    hasClosedRoleResponse(canonical) ||
    hasObservedTeamRuntime ||
    hasShortPaneSmokeTest;
  const hasTeamResponse =
    TEAM_RESPONSE.test(canonical) && TEAM_RESPONSE_SUBJECT.test(canonical);
  const mutationCandidate = canonical.replace(
    EXPLICIT_READ_ONLY,
    " read-only ",
  );
  if (
    canonical.length < 8 ||
    MUTATING_ACTION.test(mutationCandidate) ||
    PRODUCT_SURFACE_MUTATION.test(canonical) ||
    (!TEAM_SCOPE.test(canonical) && !hasShortPaneSmokeTest) ||
    (!hasTeamResponse && !hasObservedTeamRuntime && !hasShortPaneSmokeTest) ||
    !hasClosedReadOnlyRequest
  ) {
    return "delivery";
  }
  return "team-read-only-fanout";
}

export function hasTeamReadOnlyFanoutDomain(
  domains: readonly string[],
): boolean {
  return domains.some(
    (domain) =>
      domain.toLocaleLowerCase("en-US") === TEAM_READ_ONLY_FANOUT_DOMAIN,
  );
}
