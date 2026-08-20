import fs from 'node:fs';
import path from 'node:path';

/**
 * Gate: Concluída exige artefato no disco (ou handoff com arquivos) — nunca
 * verde com pasta vazia (live saas-waitlist).
 */

export type DeliveryArtifactGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type ArtifactGateHandoff = {
  readonly status: string;
  readonly artifacts?: unknown;
  readonly summary?: string;
};

/** Extrai caminhos de pasta/arquivo citados no objetivo (ex.: saas-waitlist/). */
export function extractObjectivePaths(goal: string): string[] {
  const text = goal.trim();
  if (!text) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  // Aceita pasta citada com barra final (saas-waitlist/) e arquivos com extensão.
  const pattern =
    /(?:^|[\s`"'(])((?:[\w.-]+\/)+[\w.-]*\/?|[\w.-]+\.(?:html?|css|js|jsx|ts|tsx|mjs|cjs|json|md))(?=$|[\s`"'),.?!;:]|\))/g;
  for (const match of text.matchAll(pattern)) {
    let raw = (match[1] ?? '').replace(/\/+$/, '');
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    found.push(raw);
    if (found.length >= 8) break;
  }
  return found;
}

function handoffListsFiles(handoff: ArtifactGateHandoff): boolean {
  const artifacts = handoff.artifacts;
  if (Array.isArray(artifacts) && artifacts.length > 0) return true;
  if (artifacts && typeof artifacts === 'object') {
    const files = (artifacts as { files?: unknown }).files;
    if (Array.isArray(files) && files.length > 0) return true;
  }
  return false;
}

function pathHasContent(rootRealPath: string, relative: string): boolean {
  const root = path.resolve(rootRealPath);
  const abs = path.resolve(root, relative);
  const rootRelative = path.relative(root, abs);
  if (rootRelative.startsWith('..') || path.isAbsolute(rootRelative)) {
    return false;
  }
  try {
    const st = fs.statSync(abs);
    if (st.isFile() && st.size > 0) return true;
    if (st.isDirectory()) {
      const entries = fs.readdirSync(abs);
      return entries.some((name) => {
        try {
          const child = fs.statSync(path.join(abs, name));
          return child.isFile() ? child.size > 0 : child.isDirectory();
        } catch {
          return false;
        }
      });
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Standard/ops: precisa de handoff success com arquivos OU pasta/arquivo do
 * objetivo existente no checkout. Plan: plan.md / docs/plan.md.
 * Lança se falhar — usado em completeVerified / set_status done.
 */
export function assertDeliveryArtifactsForDone(input: {
  readonly lane?: string | null;
  readonly goal: string;
  readonly rootRealPath: string;
  readonly handoffs: readonly ArtifactGateHandoff[];
}): void {
  const result = evaluateDeliveryArtifactsForDone(input);
  if (result.ok) return;
  throw new Error(result.reason);
}

export function evaluateDeliveryArtifactsForDone(input: {
  readonly lane?: string | null;
  readonly goal: string;
  readonly rootRealPath: string;
  readonly handoffs: readonly ArtifactGateHandoff[];
}): DeliveryArtifactGateResult {
  const lane = input.lane ?? 'standard';
  if (lane === 'consult') return { ok: true };

  if (lane === 'plan') {
    const planPaths = ['docs/plan.md', 'plan.md'];
    if (planPaths.some((p) => pathHasContent(input.rootRealPath, p))) {
      return { ok: true };
    }
    return {
      ok: false,
      reason:
        'missão plan não pode ficar Concluída sem plan.md ou docs/plan.md no disco.',
    };
  }

  const successWithFiles = input.handoffs.some(
    (handoff) =>
      handoff.status === 'success' && handoffListsFiles(handoff),
  );
  if (successWithFiles) return { ok: true };

  // Informational delivery: handoff success com resposta textual basta —
  // missão "quanto é 1+1?" não produz arquivo.
  const hasTextualDelivery = input.handoffs.some(
    (handoff) =>
      handoff.status === 'success' &&
      !handoffListsFiles(handoff) &&
      typeof handoff.summary === 'string' &&
      handoff.summary.trim().length > 0,
  );
  if (hasTextualDelivery) return { ok: true };

  const objectivePaths = extractObjectivePaths(input.goal);
  if (
    objectivePaths.some((relative) =>
      pathHasContent(input.rootRealPath, relative),
    )
  ) {
    return { ok: true };
  }

  // Sem path explícito: qualquer handoff success com artefato já passou;
  // fail-closed se não há prova de arquivo.
  return {
    ok: false,
    reason:
      'missão não pode ficar Concluída sem arquivos no disco (ou handoff ' +
      'success listando artefatos). O objetivo ainda não produziu entrega.',
  };
}
