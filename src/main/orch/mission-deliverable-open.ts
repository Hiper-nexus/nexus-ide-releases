/**
 * Abrir a entrega no navegador é MECÂNICA, não inteligência.
 *
 * Doutrina da casa (cabeçalho de `intent-router.ts`): "inteligência decide O
 * QUÊ, mecânica garante QUE termina". Até a 0.68.3 o produto pedia no prompt
 * que o worker rodasse `open <arquivo>` antes do handoff — obediência de LLM
 * é probabilística, e no voo real do operador (23/08) a landing não abriu.
 *
 * A causa raiz é de contrato: `missionResultSchema` carrega `evidenceIds` e
 * `artifactRefs` (IDs), nunca um caminho. Nem o main nem a UI sabem QUAL
 * arquivo foi entregue. Enquanto o contrato não ganhar os caminhos, este
 * módulo fecha o buraco de forma determinística e contida: no done, procura
 * o HTML que a missão de fato produziu DENTRO do workspace e abre.
 *
 * Invariantes:
 * - só abre quando o objetivo pediu navegador (nunca surpreende o operador);
 * - só abre arquivo CONTIDO no workspace (path.relative, nunca `..`, nunca
 *   caminho absoluto de fora, nunca symlink para fora);
 * - só `.html`/`.htm`, e só se modificado DEPOIS do início da missão;
 * - uma vez por missão.
 */
import path from 'node:path';

/** Extensões que fazem sentido abrir no navegador do SO. */
const OPENABLE_EXT = new Set(['.html', '.htm']);

/** Diretórios que nunca contêm a entrega do operador. */
const IGNORED_DIR_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.nexus',
  'coverage',
  '.cache',
  '.vite',
  'out',
]);

/**
 * O objetivo pediu para abrir no navegador?
 *
 * Conservador de propósito: abrir uma janela sem o operador ter pedido é
 * mais intrusivo do que não abrir. Exige menção explícita a navegador/browser
 * ou a "abrir no/em" seguido de um alvo visual.
 */
export function objectiveWantsBrowserOpen(objective: string): boolean {
  const text = objective.trim().toLowerCase();
  if (!text) return false;
  return (
    /\b(?:no|em|pelo|pela|com)\s+(?:o\s+|a\s+)?(?:navegador|browser|chrome|safari|firefox)\b/u.test(
      text,
    ) ||
    /\babr(?:a|ir|e)\b[^.]{0,40}\b(?:navegador|browser)\b/u.test(text) ||
    /\bpreview\s+no\s+navegador\b/u.test(text)
  );
}

export interface DeliverableCandidate {
  /** Caminho absoluto no host. */
  readonly absolutePath: string;
  /** Epoch ms da última modificação. */
  readonly modifiedAtMs: number;
}

/**
 * True quando `absolutePath` está realmente dentro de `workspaceRoot`.
 *
 * `path.relative` é a checagem correta: comparação por prefixo de string
 * aceita `/projeto-evil` como se estivesse dentro de `/projeto`.
 */
export function isContainedInWorkspace(
  workspaceRoot: string,
  absolutePath: string,
): boolean {
  if (!path.isAbsolute(workspaceRoot) || !path.isAbsolute(absolutePath)) {
    return false;
  }
  const relative = path.relative(
    path.resolve(workspaceRoot),
    path.resolve(absolutePath),
  );
  if (relative === '') return false;
  return (
    !relative.startsWith('..') &&
    !path.isAbsolute(relative) &&
    !relative.split(path.sep).includes('..')
  );
}

function isIgnoredPath(workspaceRoot: string, absolutePath: string): boolean {
  const relative = path.relative(
    path.resolve(workspaceRoot),
    path.resolve(absolutePath),
  );
  return relative
    .split(path.sep)
    .some((segment) => IGNORED_DIR_SEGMENTS.has(segment));
}

/**
 * Escolhe o que abrir: o HTML mais recente produzido pela missão.
 *
 * `index.html` ganha de irmãos com a mesma modificação — é a raiz que o
 * operador espera ver. Empate restante decide pelo caminho mais curto (menos
 * aninhado = mais provável de ser a entrega, não um parcial).
 */
export function pickOpenableDeliverable(
  workspaceRoot: string,
  candidates: readonly DeliverableCandidate[],
  missionStartedAtMs: number,
): string | null {
  const eligible = candidates.filter((candidate) => {
    if (!OPENABLE_EXT.has(path.extname(candidate.absolutePath).toLowerCase())) {
      return false;
    }
    if (!isContainedInWorkspace(workspaceRoot, candidate.absolutePath)) {
      return false;
    }
    if (isIgnoredPath(workspaceRoot, candidate.absolutePath)) return false;
    // Arquivo que já existia antes da missão não é entrega dela.
    return candidate.modifiedAtMs >= missionStartedAtMs;
  });
  if (eligible.length === 0) return null;

  let best = eligible[0]!;
  for (const candidate of eligible.slice(1)) {
    if (candidate.modifiedAtMs > best.modifiedAtMs) {
      best = candidate;
      continue;
    }
    if (candidate.modifiedAtMs < best.modifiedAtMs) continue;
    const candidateIsIndex =
      path.basename(candidate.absolutePath).toLowerCase() === 'index.html';
    const bestIsIndex =
      path.basename(best.absolutePath).toLowerCase() === 'index.html';
    if (candidateIsIndex && !bestIsIndex) {
      best = candidate;
      continue;
    }
    if (!candidateIsIndex && bestIsIndex) continue;
    if (candidate.absolutePath.length < best.absolutePath.length) {
      best = candidate;
    }
  }
  return best.absolutePath;
}

const openedMissions = new Set<string>();

/** Só para teste: zera o registro de "já abriu". */
export function resetMissionDeliverableOpenState(): void {
  openedMissions.clear();
}

export interface MissionDeliverableOpenDeps {
  readonly listHtmlCandidates: (
    workspaceRoot: string,
  ) => readonly DeliverableCandidate[];
  readonly openPath: (absolutePath: string) => void;
  readonly log?: (message: string) => void;
}

export interface MissionDeliverableOpenInput {
  readonly missionId: string;
  readonly objective: string;
  readonly workspaceRoot: string;
  readonly missionStartedAtMs: number;
}

/**
 * Abre a entrega da missão no navegador do SO, uma única vez.
 * Retorna o caminho aberto, ou null quando não havia nada a abrir.
 */
export function openMissionDeliverable(
  deps: MissionDeliverableOpenDeps,
  input: MissionDeliverableOpenInput,
): string | null {
  if (openedMissions.has(input.missionId)) return null;
  if (!objectiveWantsBrowserOpen(input.objective)) return null;
  if (!input.workspaceRoot) return null;

  let candidates: readonly DeliverableCandidate[];
  try {
    candidates = deps.listHtmlCandidates(input.workspaceRoot);
  } catch {
    return null;
  }
  const target = pickOpenableDeliverable(
    input.workspaceRoot,
    candidates,
    input.missionStartedAtMs,
  );
  if (!target) return null;

  openedMissions.add(input.missionId);
  try {
    deps.openPath(target);
  } catch (error) {
    deps.log?.(
      `[mission-deliverable-open] falha ao abrir ${target}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
  return target;
}

/**
 * Varredura limitada por HTML dentro do workspace.
 *
 * Limites duros porque isto roda no done de toda missão: profundidade 6 e
 * teto de entradas visitadas. Uma pasta gigante degrada para "não achou",
 * nunca para travar o main.
 */
export function scanHtmlCandidates(
  workspaceRoot: string,
  fsImpl: {
    readdirSync: (
      p: string,
      o: { withFileTypes: true },
    ) => readonly {
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
    }[];
    statSync: (p: string) => { mtimeMs: number };
  },
  limits: { maxDepth?: number; maxEntries?: number } = {},
): DeliverableCandidate[] {
  const maxDepth = limits.maxDepth ?? 6;
  const maxEntries = limits.maxEntries ?? 5_000;
  const found: DeliverableCandidate[] = [];
  let visited = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || visited >= maxEntries) return;
    let entries: readonly {
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
    }[];
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= maxEntries) return;
      visited += 1;
      if (IGNORED_DIR_SEGMENTS.has(entry.name)) continue;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!OPENABLE_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        found.push({
          absolutePath,
          modifiedAtMs: fsImpl.statSync(absolutePath).mtimeMs,
        });
      } catch {
        // Arquivo sumiu entre o readdir e o stat: ignora.
      }
    }
  };

  walk(workspaceRoot, 0);
  return found;
}
