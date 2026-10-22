// Keep actionable verbs shared: a new positive verb must also accept negation.
const ACTION_SOURCE = /(?:faca|fazer|realize|realizar|execute|perform|plan|planeje|planejar|use|usar|utilize|utilizar|help me|me ajude|analise|analyze|analyse|reverse[ -]engineer|decompile|decompilar)/.source;
const ACTION = new RegExp(String.raw`\b${ACTION_SOURCE}\b`);
const ACTIVITY_SOURCE = /(?:engenharia reversa|reverse[ -]engineer(?:ing)?|decompil(?:ar|e|em|ing)|rea)/.source;
// Also retain the infinitive/gerund forms previously accepted in refusals.
const REFUSAL_ACTION_SOURCE = `(?:${ACTION_SOURCE}|executar|do|doing|using)`;
// A short object may link the action to its technique ("analise este app por
// engenharia reversa"). Never cross punctuation, a connective or another action.
const OBJECT_WORD = String.raw`(?!(?:${REFUSAL_ACTION_SOURCE}|e|and|mas|but|apenas|just)\b)[a-z0-9_-]+\s+`;
const REFUSAL = new RegExp(String.raw`\b(?:nao|nunca|not|never|avoid|evite|don['’]t|sem|without)\s+(?:(?:quero|want to)\s+)?(?:${REFUSAL_ACTION_SOURCE}\s+(?:${OBJECT_WORD}){0,8})?(?:(?:a|o|the)\s+)?(?:skill\s+)?${ACTIVITY_SOURCE}\b`);

/** Task intent only: selecting a skill grants neither tools nor runtime availability. */
export function isReverseEngineeringTask(text: string): boolean {
  const normalized = text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  return normalized.split(/[\n.!?;]+/).some((part) => {
    const clause = part.trim();
    // Ignore only reviewed courtesy/emphasis asides when binding a refusal.
    // Keep other commas as clause boundaries: "nao execute o binario, apenas
    // faca engenharia reversa" negates running, not analysis.
    const refusal = clause
      .replace(/[,\s]*\b(?:por favor|please|under any circumstances)\b[,\s]*/g, ' ')
      .replace(/\s+/g, ' ');
    if (REFUSAL.test(refusal)) return false;
    const request = /^(?:(?:please|por favor)[, ]+)?(?:(?:can|could|would) you\s+|(?:voce )?pode(?:ria)?\s+)?/;
    const action = clause.replace(request, '');
    // Explanations/tutorials about the technique are not requests to use it.
    if (/^(?:what|why|how|o que|como|por que|explain|explique|compare|write documentation|documente o conceito)\b/.test(action)) {
      return false;
    }
    if (/^(?:reverse[ -]engineer|decompile|decompilar|decompilem)\b/.test(action)) return true;
    if (/^(?:engenharia reversa|reverse engineering)\b/.test(action)) return true;
    if (/\bdo reverse[ -]engineering\b/.test(action)) return true;
    if (/^(?:\$rea|\/rea)(?:\s|$)/.test(action)) return true;
    if (/\b(?:quero|preciso|i need|i want)\s+(?:de\s+)?(?:engenharia reversa|reverse engineering|rea)\b/.test(action)) return true;
    // A short context prefix is common ("Neste projeto, faça …"). Match
    // concrete action words anywhere in the clause, not arbitrary mentions.
    // Wanting/needing something alone is not an analysis action (e.g. docs).
    return ACTION.test(action)
      && /\b(?:engenharia reversa|reverse[ -]engineer(?:ing)?|decompil(?:ar|e|ing)|rea)\b/.test(action);
  });
}
