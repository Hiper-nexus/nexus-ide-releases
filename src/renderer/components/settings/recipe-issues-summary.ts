import type { RecipeLintIssue } from '../../../shared/types';

/**
 * Resumo legível das pendências do lint de receitas (página Fluxos).
 *
 * O lint é só diagnóstico: nenhum caminho de spawn ou missão consulta
 * `RecipeOverlayResult.ok`, então uma referência desconhecida numa equipe não
 * impede o uso do fluxo. Por isso o resumo é informativo e neutro — conta
 * fluxos (não linhas de lint), nomeia o motivo mais frequente e só vira alerta
 * quando a verificação em si falhou.
 */

export type RecipeIssueKind =
  | 'unrestricted-tools'
  | 'missing-tool'
  | 'missing-skill'
  | 'invalid-gap';

export interface RecipeIssueSummary {
  readonly tone: 'ok' | 'neutral';
  /** Texto curto do chip. */
  readonly label: string;
  /** Motivo principal em linguagem simples; null quando não há pendência. */
  readonly reason: string | null;
}

const KIND_PRIORITY: readonly RecipeIssueKind[] = [
  'missing-tool',
  'missing-skill',
  'unrestricted-tools',
  'invalid-gap',
];

export function recipeIssueKind(issue: RecipeLintIssue): RecipeIssueKind {
  if (issue.ref === '*') return 'unrestricted-tools';
  if (issue.ref.toLowerCase().startsWith('gap:')) return 'invalid-gap';
  return issue.field === 'allowedSkills' ? 'missing-skill' : 'missing-tool';
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function kindPhrase(kind: RecipeIssueKind, count: number): string {
  switch (kind) {
    case 'missing-tool':
      return `${plural(count, 'ferramenta citada não existe', 'ferramentas citadas não existem')} neste computador`;
    case 'missing-skill':
      return `${plural(count, 'instrução citada não está instalada', 'instruções citadas não estão instaladas')}`;
    case 'unrestricted-tools':
      return `${plural(count, 'agente usa', 'agentes usam')} todas as ferramentas, sem lista própria`;
    case 'invalid-gap':
      return `${plural(count, 'anotação de recurso faltante está', 'anotações de recurso faltante estão')} sem motivo`;
  }
}

/** Ordena as pendências pelo mesmo critério do resumo (tipo mais relevante primeiro). */
export function sortRecipeIssues(
  issues: readonly RecipeLintIssue[],
): RecipeLintIssue[] {
  return [...issues].sort(
    (a, b) =>
      KIND_PRIORITY.indexOf(recipeIssueKind(a)) -
      KIND_PRIORITY.indexOf(recipeIssueKind(b)),
  );
}

export function summarizeRecipeIssues(
  issues: readonly RecipeLintIssue[],
): RecipeIssueSummary {
  if (issues.length === 0) {
    return { tone: 'ok', label: 'Recursos verificados', reason: null };
  }
  const flows = new Set(issues.map((issue) => issue.squadId)).size;
  const counts = new Map<RecipeIssueKind, number>();
  for (const issue of issues) {
    const kind = recipeIssueKind(issue);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const ranked = KIND_PRIORITY.filter((kind) => counts.has(kind)).sort(
    (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0),
  );
  const top = ranked[0]!;
  const rest = issues.length - (counts.get(top) ?? 0);
  const more = rest > 0 ? ` e ${plural(rest, 'outro ajuste', 'outros ajustes')}` : '';
  return {
    tone: 'neutral',
    label: `${plural(flows, 'fluxo com ajustes pendentes', 'fluxos com ajustes pendentes')}`,
    reason:
      `Principal motivo: ${kindPhrase(top, counts.get(top) ?? 0)}${more}. ` +
      'Os fluxos continuam disponíveis; ajuste quando quiser.',
  };
}
