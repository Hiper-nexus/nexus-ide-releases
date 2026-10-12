/**
 * Origem da rota de um pane aberto por agente do operador (A, 25/09) — o que
 * o recibo, o chip do cabeçalho e o toast dizem quando o Jev não respondeu.
 * Vive em shared porque Main produz e renderer exibe.
 */
export type JevUnavailableReason =
  | 'disabled'
  | 'no-key'
  | 'invalid-answer'
  | 'timeout'
  | 'rate-limited'
  | 'client-error'
  | 'server-error'
  | 'network'
  | 'malformed'
  | 'aborted'
  | 'internal-error'
  /** A Decisions API recusou a consulta. Não é predicado negativo. */
  | 'refusal'
  /** A distribuição parseou, mas não serve o contrato. */
  | 'ambiguous'
  /** Os modelos do modo Juntos não concordaram. */
  | 'divergent'
  /** O orçamento de decisão da missão esgotou (F-1164). */
  | 'budget'
  /** Resposta com confiança abaixo do limiar (F-1265). */
  | 'low-confidence';

export type SpawnRouteSource = 'jev' | 'mixed' | 'heuristic';

/**
 * Confiança (0..1, 2 casas) do Jev em cada dimensão que ELE decidiu — só as
 * aceitas pelo limiar do roteador. Dimensão decidida pela heurística não tem
 * número: ausente, nunca inventado.
 */
export interface SpawnRouteConfidence {
  readonly tier?: number;
  readonly specialty?: number;
  readonly effort?: number;
}

/** O que a regra (heurística + tabela, sem o Jev) teria escolhido. */
export interface SpawnRuleChoice {
  readonly adapterId: string;
  readonly model?: string;
  readonly effort?: string;
}

/**
 * Contrafactual da regra: `'same'` = o Jev influenciou a classificação mas a
 * regra chegaria à mesma CLI/modelo/esforço; objeto = a regra escolheria outra
 * coisa. Ausente = o Jev não influenciou (nada a comparar). Só ids de
 * CLI/modelo/esforço — nunca texto da tarefa, conta, fingerprint ou token.
 */
export type SpawnRuleChoiceReceipt = SpawnRuleChoice | 'same';

export interface SpawnRouteInfo {
  readonly source: SpawnRouteSource;
  readonly jevUnavailable?: JevUnavailableReason;
  readonly confidence?: SpawnRouteConfidence;
  readonly ruleChoice?: SpawnRuleChoiceReceipt;
}

/** Teto de um id de CLI/modelo/esforço no recibo; acima disso não é id. */
const RULE_CHOICE_FIELD_MAX_CHARS = 120;

const CONFIDENCE_DIMENSIONS = ['tier', 'specialty', 'effort'] as const;

const CONFIDENCE_LABEL: Readonly<Record<(typeof CONFIDENCE_DIMENSIONS)[number], string>> = {
  tier: 'tarefa',
  specialty: 'especialidade',
  effort: 'esforço',
};

/** 0,8349 → 0,83: o recibo mostra duas casas, nunca a precisão espúria do Jev. */
export function roundConfidence(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Copia só as três dimensões conhecidas, cada uma um número finito em 0..1.
 * Qualquer outra chave (inclusive texto de tarefa que alguém tenha pendurado
 * no objeto) é ignorada. Nada aproveitável → undefined, nunca `{}`.
 */
export function parseSpawnRouteConfidence(raw: unknown): SpawnRouteConfidence | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const source = raw as Record<string, unknown>;
  const picked: { -readonly [K in keyof SpawnRouteConfidence]: number } = {};
  for (const dimension of CONFIDENCE_DIMENSIONS) {
    const value = source[dimension];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
      picked[dimension] = roundConfidence(value);
    }
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/** Ids de CLI e modelo: letras, dígitos e `._-:/[]`. Nada de controle, bidi nem marcação. */
const RULE_CHOICE_ID_PATTERN = /^[\w.\-:/[\]]+$/;

function idField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= RULE_CHOICE_FIELD_MAX_CHARS && RULE_CHOICE_ID_PATTERN.test(trimmed)
    ? trimmed
    : undefined;
}

/** `'same'` ou `{adapterId, model?, effort?}`; qualquer outra coisa → undefined. */
export function parseSpawnRuleChoice(raw: unknown): SpawnRuleChoiceReceipt | undefined {
  if (raw === 'same') return 'same';
  if (typeof raw !== 'object' || raw === null) return undefined;
  const source = raw as Record<string, unknown>;
  const adapterId = idField(source.adapterId);
  if (!adapterId) return undefined;
  const model = idField(source.model);
  const effort = idField(source.effort);
  return {
    adapterId,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

function formatConfidence(value: number): string {
  return value.toFixed(2).replace('.', ',');
}

function describeConfidence(confidence: SpawnRouteConfidence | undefined): string | null {
  if (!confidence) return null;
  const parts = CONFIDENCE_DIMENSIONS.flatMap((dimension) => {
    const value = confidence[dimension];
    return typeof value === 'number' ? [`${CONFIDENCE_LABEL[dimension]} ${formatConfidence(value)}`] : [];
  });
  return parts.length > 0 ? parts.join(' · ') : null;
}

function describeRuleChoice(ruleChoice: SpawnRuleChoiceReceipt | undefined): string | null {
  if (ruleChoice === undefined) return null;
  if (ruleChoice === 'same') return 'A regra teria escolhido o mesmo.';
  const target = ruleChoice.model ? `${ruleChoice.adapterId}/${ruleChoice.model}` : ruleChoice.adapterId;
  const effort = ruleChoice.effort ? ` (esforço ${ruleChoice.effort})` : '';
  return `A regra teria escolhido: ${target}${effort}.`;
}

/**
 * Texto (tooltip + aria-label) do chip da rota no cabeçalho do pane. `null` =
 * sem chip (heurística sem queda). Curto e sem jargão; só diz o que existe.
 */
export function spawnRouteTooltip(route: SpawnRouteInfo): string | null {
  if (route.jevUnavailable) {
    return `CLI escolhida pela heurística — Jev ${JEV_UNAVAILABLE_LABEL[route.jevUnavailable]}`;
  }
  if (route.source === 'heuristic') return null;
  const confidence = describeConfidence(route.confidence);
  const rule = describeRuleChoice(route.ruleChoice);
  if (!confidence && !rule) return 'CLI escolhida pelo Jev para esta tarefa';
  const chosen = `CLI escolhida pelo Jev${confidence ? ` (confiança: ${confidence})` : ''}.`;
  return rule ? `${chosen} ${rule}` : chosen;
}

export const JEV_UNAVAILABLE_LABEL: Readonly<Record<JevUnavailableReason, string>> = {
  disabled: 'desligado nas Configurações',
  'no-key': 'sem chave',
  'invalid-answer': 'resposta inválida',
  timeout: 'tempo esgotado',
  'rate-limited': 'limite de uso',
  'client-error': 'requisição recusada',
  'server-error': 'serviço fora',
  network: 'sem rede',
  malformed: 'resposta malformada',
  aborted: 'cancelado',
  'internal-error': 'erro interno do Nexus',
  refusal: 'recusa do modelo',
  ambiguous: 'resposta ambígua',
  divergent: 'sem acordo entre os modelos',
  budget: 'orçamento da missão esgotado',
  'low-confidence': 'baixa confiança',
};

export function isJevUnavailableReason(value: unknown): value is JevUnavailableReason {
  return typeof value === 'string' && Object.hasOwn(JEV_UNAVAILABLE_LABEL, value);
}
