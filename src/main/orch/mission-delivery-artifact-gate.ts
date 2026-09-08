import fs from 'node:fs';
import path from 'node:path';
import { suggestMissionLaneFromGoal } from '../../shared/mission-intent';
import { classifyStandardMissionTopology } from '../../shared/mission-topology';
import { looksLikePureQuestion } from './intent-router';

/**
 * Proof of physical delivery. Existing question/consult/ops paths remain
 * textual; declaring filenames never proves that software was delivered.
 */

export type DeliveryArtifactGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type ArtifactGateHandoff = {
  readonly status: string;
  readonly artifacts?: unknown;
  readonly summary?: string;
};

export interface DeliveryArtifactGateInput {
  readonly lane?: string | null;
  readonly goal: string;
  readonly rootRealPath: string;
  readonly handoffs: readonly ArtifactGateHandoff[];
  /** Paths already collected by Main; still checked against the filesystem. */
  readonly artifactRefs?: readonly string[];
  readonly resultSummary?: string;
  /** Deleted paths observed by Main's current candidate snapshot, never MCP args. */
  readonly deletedArtifactRefs?: readonly string[];
  /** Main has verified the existing read-only team-question contract. */
  readonly textOnly?: boolean;
}

const MAX_ARTIFACT_PATHS = 500;
const MAX_WALK_ENTRIES = 4_000;
const MAX_WALK_DEPTH = 10;
const NON_PRODUCT_DIRECTORIES = new Set([
  '.git', '.nexus', '.nexus-memory', 'node_modules', 'vendor', 'coverage',
  '.cache', '.vite', '__pycache__', '.venv',
]);
const REMOVAL_REQUEST_WORDS = new Set([
  'apague', 'apagar', 'remova', 'remover', 'exclua', 'excluir', 'delete', 'remove',
  'por', 'favor', 'o', 'a', 'os', 'as', 'e', 'do', 'da', 'de', 'no', 'na',
  'arquivo', 'arquivos', 'pasta', 'pastas', 'projeto', 'repositorio',
  'the', 'and', 'please', 'file', 'files', 'folder', 'folders', 'from', 'project',
]);

/** A closed removal request is proven by absence, even without Git. Mixed
 * requests keep the normal delivery path; a later build clause cannot vanish. */
function requestedRemovalPaths(goal: string): string[] {
  const paths = extractObjectivePaths(goal);
  if (paths.length === 0 || !/^\s*(?:por\s+favor[,:]?\s+|please\s+)?(?:apague|apagar|remova|remover|exclua|excluir|delete|remove)\b/iu.test(goal)) return [];
  let remaining = goal;
  for (const file of [...paths].sort((a, b) => b.length - a.length)) {
    remaining = remaining.replaceAll(file, ' ');
  }
  const words = remaining.normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  return words.every((word) => REMOVAL_REQUEST_WORDS.has(word)) ? paths : [];
}

/** Extrai caminhos de pasta/arquivo citados no objetivo (ex.: saas-waitlist/). */
export function extractObjectivePaths(goal: string): string[] {
  const text = goal.trim();
  if (!text) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  // Aceita pasta citada com barra final (saas-waitlist/) e arquivos com extensão.
  const pattern =
    /(?:^|[\s`"'(])((?:[\p{L}\p{N}_.-]+\/)+[\p{L}\p{N}_.-]*\/?|[\p{L}\p{N}_.-]+\.[A-Za-z][A-Za-z0-9]{0,9})(?=$|[\s`"'),.?!;:]|\))/gu;
  for (const match of text.matchAll(pattern)) {
    let raw = (match[1] ?? '').replace(/\/+$/, '');
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    found.push(raw);
    if (found.length >= MAX_ARTIFACT_PATHS) break;
  }
  return found;
}

function artifactPaths(raw: unknown, depth = 0): string[] {
  if (depth > 3) return [];
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) {
    return raw.slice(0, MAX_ARTIFACT_PATHS).flatMap((item) => artifactPaths(item, depth + 1));
  }
  if (!raw || typeof raw !== 'object') return [];
  const item = raw as { path?: unknown; files?: unknown };
  return [
    ...(typeof item.path === 'string' ? [item.path] : []),
    ...artifactPaths(item.files, depth + 1),
  ];
}

function isContainedProductPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative) &&
    !relative.split(path.sep).some((segment) => NON_PRODUCT_DIRECTORIES.has(segment));
}

interface ArtifactProbe {
  readonly root: string;
  readonly visitedDirectories: Set<string>;
  remaining: number;
}

function createProbe(root: string): ArtifactProbe | null {
  try {
    const real = fs.realpathSync(root);
    if (!fs.statSync(real).isDirectory()) return null;
    return { root: real, visitedDirectories: new Set(), remaining: MAX_WALK_ENTRIES };
  } catch {
    return null;
  }
}

function boundedChildren(directory: string, limit: number): string[] {
  const handle = fs.opendirSync(directory);
  const children: string[] = [];
  try {
    while (children.length < limit) {
      const entry = handle.readSync();
      if (!entry) break;
      children.push(path.join(directory, entry.name));
    }
    return children;
  } finally {
    handle.closeSync();
  }
}

function pathHasContent(probe: ArtifactProbe | null, raw: string, fileOnly = false): boolean {
  if (!probe || !raw.trim() || raw.includes('\0')) return false;
  const stack = [{ absolute: path.resolve(probe.root, raw.trim()), depth: 0 }];
  while (stack.length > 0 && probe.remaining > 0) {
    const entry = stack.pop()!;
    probe.remaining -= 1;
    try {
      // Compare canonical paths: macOS may spell the same temp directory as
      // /var/... or /private/var/..., including in Main-collected artifacts.
      const real = fs.realpathSync(entry.absolute);
      if (!isContainedProductPath(probe.root, real)) continue;
      const stat = fs.statSync(real);
      if (stat.isFile() && stat.size > 0) return true;
      if (fileOnly || !stat.isDirectory() || entry.depth >= MAX_WALK_DEPTH ||
        probe.visitedDirectories.has(real)) continue;
      probe.visitedDirectories.add(real);
      for (const child of boundedChildren(real, probe.remaining)) {
        stack.push({ absolute: child, depth: entry.depth + 1 });
      }
    } catch {
      // Missing/inaccessible paths are not evidence. Try other delivered paths.
    }
  }
  return false;
}

function allowsTextDelivery(input: DeliveryArtifactGateInput): boolean {
  if (input.textOnly || input.lane === 'ops') return true;
  return classifyStandardMissionTopology(input.goal) === 'team-read-only-fanout' ||
    looksLikePureQuestion(input.goal) || suggestMissionLaneFromGoal(input.goal) === 'consult';
}

function isObservedDeletionStillAbsent(probe: ArtifactProbe | null, relative: string): boolean {
  if (!probe || !relative || relative.includes('\0') || path.isAbsolute(relative)) return false;
  const absolute = path.resolve(probe.root, relative);
  if (absolute === probe.root || !isContainedProductPath(probe.root, absolute)) return false;
  try {
    // Even a broken symlink means the named entry has not been removed.
    fs.lstatSync(absolute);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  let parent = path.dirname(absolute);
  while (parent !== probe.root) {
    try {
      fs.lstatSync(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      parent = path.dirname(parent);
      continue;
    }
    try {
      return isContainedProductPath(probe.root, fs.realpathSync(parent));
    } catch {
      return false;
    }
  }
  return true;
}

export function assertDeliveryArtifactsForDone(input: DeliveryArtifactGateInput): void {
  const result = evaluateDeliveryArtifactsForDone(input);
  if (result.ok) return;
  throw new Error(result.reason);
}

export function evaluateDeliveryArtifactsForDone(input: DeliveryArtifactGateInput): DeliveryArtifactGateResult {
  const lane = input.lane ?? 'standard';
  if (lane === 'consult') return { ok: true };
  const probe = createProbe(input.rootRealPath);

  if (lane === 'plan') {
    const planPaths = ['docs/plan.md', 'plan.md'];
    if (planPaths.some((p) => pathHasContent(probe, p, true))) {
      return { ok: true };
    }
    return {
      ok: false,
      reason:
        'missão plan não pode ficar Concluída sem plan.md ou docs/plan.md no disco.',
    };
  }

  const successful = input.handoffs.filter((handoff) => handoff.status === 'success');
  const paths = [...new Set([
    ...(input.artifactRefs ?? []),
    ...successful.flatMap((handoff) => artifactPaths(handoff.artifacts)),
    ...extractObjectivePaths(input.goal),
  ])].slice(0, MAX_ARTIFACT_PATHS);
  const removals = requestedRemovalPaths(input.goal);
  if (removals.length > 0) {
    return removals.every((file) => isObservedDeletionStillAbsent(probe, file))
      ? { ok: true }
      : { ok: false, reason: 'A exclusão solicitada ainda não corresponde aos arquivos do projeto.' };
  }
  if (input.deletedArtifactRefs && input.deletedArtifactRefs.length > 0) {
    if (!input.deletedArtifactRefs.every((file) => isObservedDeletionStillAbsent(probe, file))) {
      return { ok: false, reason: 'A entrega mudou após a verificação: uma exclusão observada não corresponde mais ao projeto.' };
    }
    // A deletion in a mixed task does not prove the requested new software.
  }
  if (paths.some((candidate) => pathHasContent(probe, candidate))) return { ok: true };
  const hasText = Boolean(input.resultSummary?.trim()) || successful.some((handoff) =>
    typeof handoff.summary === 'string' && handoff.summary.trim().length > 0);
  if (allowsTextDelivery(input) && hasText) {
    return { ok: true };
  }

  return {
    ok: false,
    reason:
      'missão não pode ficar Concluída sem uma entrega real no projeto. ' +
      'Confira os arquivos produzidos; uma lista de nomes ou a mensagem "Pronto" não comprova a criação.',
  };
}
