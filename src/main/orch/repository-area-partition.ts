/**
 * Particionamento do inventário vivo em ÁREAS disjuntas — prong (b).
 *
 * O planner já lê o repositório (`guided-mission-planner.ts:482-489`,
 * `deps.listRepositoryOwnership`) e achata tudo num `baseOwnership` único, para
 * UMA tarefa de entrega. Por isso um plano nasce com 1 raiz mesmo quando o
 * objetivo toca frentes independentes: não faltava conhecimento do repo,
 * faltava PARTIÇÃO.
 *
 * Escada de fronteiras, na ordem em que o próprio projeto as declara:
 *   1. pacote de monorepo (`apps/*`, `services/*`, `packages/*`, `libs/*`)
 *   2. diretório de primeiro nível (`src`, `scripts`, `docs`…)
 *   3. fronteira de teste (`tests`, `__tests__`) como área própria
 *
 * Conservador por contrato: só existe área onde a disjunção é PROVÁVEL por
 * prefixo. Glue reservado (lockfiles, index, migrations) nunca entra em área
 * nenhuma — continua exclusivo, como sempre foi.
 *
 * Puro: sem IO, sem store. Decide a forma; quem emite as raízes é o planner.
 * Ver docs/analysis/2026-08-06-decomposicao-por-area.md.
 */
import { isReservedGlueFile, normalizeSchedulePath } from './mission-scheduler-ownership';

export interface RepositoryArea {
  /** Prefixo canônico da área (`services/api`, `src`, `tests`). */
  readonly id: string;
  /** Fatia do inventário que pertence a esta área, em ordem estável. */
  readonly files: readonly string[];
}

/** Raízes de monorepo onde o SEGUNDO segmento é que nomeia o pacote. */
const MONOREPO_ROOTS = new Set(['apps', 'services', 'packages', 'libs']);

/** Diretórios de teste viram área própria: escrita ali não colide com código. */
const TEST_ROOTS = new Set(['tests', 'test', '__tests__', 'e2e']);

/**
 * Prefixo de área de um caminho. `apps/web/src/app.tsx` → `apps/web`;
 * `src/a.ts` → `src`; `tests/e2e/x.spec.ts` → `tests`.
 */
function areaIdFor(file: string): string | null {
  // Curinga (`services/api/**`) é declaração de área, não arquivo solto.
  const clean = file.replace(/\/\*+$/, '').replace(/\/+$/, '');
  const segments = clean.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  const head = segments[0]!;
  if (MONOREPO_ROOTS.has(head) && segments.length >= 2) {
    return `${head}/${segments[1]}`;
  }
  if (TEST_ROOTS.has(head)) return head;
  // Arquivo na raiz (`AGENTS.md`) não forma área: é superfície compartilhada.
  if (segments.length === 1) return null;
  return head;
}

export function partitionOwnershipIntoAreas(
  ownership: readonly string[],
): readonly RepositoryArea[] {
  const byArea = new Map<string, string[]>();
  for (const raw of ownership) {
    const file = normalizeSchedulePath(raw);
    // Glue reservado nunca vira fatia de ninguém — segue exclusivo.
    if (isReservedGlueFile(file)) continue;
    const id = areaIdFor(file);
    if (!id) continue;
    const bucket = byArea.get(id);
    if (bucket) bucket.push(file);
    else byArea.set(id, [file]);
  }
  const areas = [...byArea.entries()]
    .map(([id, files]) =>
      Object.freeze({
        id,
        files: Object.freeze([...files].sort((a, b) => a.localeCompare(b))),
      }),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  return Object.freeze(areas);
}
