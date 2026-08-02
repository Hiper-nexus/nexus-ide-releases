/**
 * Plano selado ÓRFÃO — o terceiro estado que faltava.
 *
 * Todo consumidor do plano busca o receipt por `(missão, intentVersion)` e,
 * ao não achar, cai num ramo de "esta missão não tem plano". Isso funde dois
 * estados MUITO diferentes:
 *
 *  (a) a missão nunca teve plano selado  → caminho livre, legítimo;
 *  (c) a missão TEM plano selado, porém em OUTRA versão da intenção → ÓRFÃO.
 *
 * Tratar (c) como (a) é degradação silenciosa de autoridade: o roteador volta
 * a oferecer adapter fora do roster, a validação de merge roda sem vínculo com
 * o plano e o dispatcher devolve a autoridade de execução para o LLM. O órfão
 * é FALHA NOMEADA, nunca ausência — e é isto que este módulo dá nome.
 *
 * Puro: sem zod, sem node, sem electron — importável por main e renderer.
 */

/** Token durável para reconhecer o órfão em descrição/last_error/log. */
export const ORPHAN_SEALED_PLAN_MARKER = '[NEXUS_ORPHAN_SEALED_PLAN]';

/** Código estável do erro, usado por gates e testes. */
export const ORPHAN_SEALED_PLAN_CODE = 'orphan_sealed_plan';

export interface OrphanSealedPlanFacts {
  readonly missionId?: string;
  /** Versão da intenção em que a missão está AGORA. */
  readonly missionIntentVersion: number;
  /** Versões em que existe plano selado (nenhuma é a corrente). */
  readonly sealedIntentVersions: readonly number[];
}

function versionList(versions: readonly number[]): string {
  const sorted = [...new Set(versions)].sort((a, b) => a - b);
  if (sorted.length === 0) return '—';
  if (sorted.length === 1) return String(sorted[0]);
  return `${sorted.slice(0, -1).join(', ')} e ${sorted[sorted.length - 1]}`;
}

/**
 * Mensagem única do órfão. Nomeia as duas versões e diz o que fazer — nunca
 * "plano não encontrado", que é o texto que escondia o defeito.
 */
export function orphanSealedPlanMessage(facts: OrphanSealedPlanFacts): string {
  return (
    `${ORPHAN_SEALED_PLAN_MARKER} ${ORPHAN_SEALED_PLAN_CODE}: o plano selado ` +
    `está na versão ${versionList(facts.sealedIntentVersions)} da intenção e a ` +
    `missão está na versão ${facts.missionIntentVersion}. Um plano órfão não ` +
    'concede autoridade de rota, merge nem despacho. Retome a missão para ' +
    're-selar o plano na versão atual.'
  );
}

/**
 * Erro fail-closed do órfão. Carrega os fatos para que qualquer superfície
 * possa apresentar a causa sem reparsear texto.
 */
export class OrphanSealedPlanError extends Error {
  readonly code = ORPHAN_SEALED_PLAN_CODE;
  readonly missionId?: string;
  readonly missionIntentVersion: number;
  readonly sealedIntentVersions: readonly number[];

  constructor(facts: OrphanSealedPlanFacts) {
    super(orphanSealedPlanMessage(facts));
    this.name = 'OrphanSealedPlanError';
    if (facts.missionId !== undefined) this.missionId = facts.missionId;
    this.missionIntentVersion = facts.missionIntentVersion;
    this.sealedIntentVersions = Object.freeze([...facts.sealedIntentVersions]);
  }
}

/** True quando o erro/texto observado é o órfão (cross-process safe). */
export function isOrphanSealedPlan(value: unknown): boolean {
  if (value instanceof OrphanSealedPlanError) return true;
  const text =
    typeof value === 'string'
      ? value
      : value instanceof Error
        ? `${value.name}: ${value.message}`
        : '';
  return (
    text.includes(ORPHAN_SEALED_PLAN_MARKER) ||
    text.includes(ORPHAN_SEALED_PLAN_CODE)
  );
}

/**
 * Classificação dos três estados. `sealedIntentVersions` são TODAS as versões
 * com plano selado para a missão.
 */
export type SealedPlanPresence = 'none' | 'current' | 'orphan';

export function sealedPlanPresence(input: {
  readonly missionIntentVersion: number;
  readonly sealedIntentVersions: readonly number[];
}): SealedPlanPresence {
  if (input.sealedIntentVersions.length === 0) return 'none';
  return input.sealedIntentVersions.includes(input.missionIntentVersion)
    ? 'current'
    : 'orphan';
}
