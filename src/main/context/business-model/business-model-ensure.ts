import type { ProjectExecutionScope } from '../../../shared/types';
import { AsyncProcessGitRunner, type AsyncGitRunner } from '../../runtime/git-command';
import { trace } from '../../observability/main-trace';
import { extractBusinessModel } from './business-model-extract';
import {
  readBusinessModelAt,
  writeBusinessModel,
  type StoredBusinessModel,
} from './business-model-store';

/**
 * Garante que o modelo extraído do HEAD ATUAL existe no store — barato quando
 * já existe (rev-parse + read de um arquivo), determinístico quando extrai.
 *
 * É o que liga o pipeline fora do `nexus_context_doctor`: hook de prompt do
 * operador, geração de brief e MCP chamam `ensureBusinessModel` em vez de
 * esperar um orquestrador lembrar de rodar o doctor. `wait: false` dispara e
 * não bloqueia (hook/brief nunca esperam a extração terminar).
 *
 * Concorrência: um flight por (instalação, projeto, headSha); chamadas
 * simultâneas dividem a mesma extração.
 */

const HEAD_CACHE_MS = 30_000;

export interface EnsureBusinessModelOptions {
  /** `false` dispara a extração em background e devolve null imediatamente. */
  readonly wait?: boolean;
  readonly git?: AsyncGitRunner;
  /** Seam de teste: substitui a extração determinística. */
  readonly extract?: typeof extractBusinessModel;
  /** Seam de teste: relógio. */
  readonly now?: () => number;
}

interface HeadCacheEntry {
  readonly at: number;
  readonly headSha: string | null;
}

const headCache = new Map<string, HeadCacheEntry>();
const flights = new Map<string, Promise<StoredBusinessModel | null>>();

/** HEAD atual (rev-parse), com cache de 30s por raiz — o ensure é por commit. */
async function headShaFor(
  root: string,
  git: AsyncGitRunner,
  now: () => number,
): Promise<string | null> {
  const cached = headCache.get(root);
  if (cached && now() - cached.at < HEAD_CACHE_MS) return cached.headSha;
  let headSha: string | null = null;
  try {
    const result = await git.run(
      root,
      ['--no-optional-locks', 'rev-parse', '--verify', 'HEAD'],
      { allowFailure: true },
    );
    if (result.status === 0 && /^[0-9a-f]{40,64}$/.test(result.stdout.trim())) {
      headSha = result.stdout.trim();
    }
  } catch {
    headSha = null;
  }
  headCache.set(root, { at: now(), headSha });
  return headSha;
}

/**
 * Garante o modelo do HEAD no store. Devolve o registro (do disco ou recém-
 * extraído); `null` quando não há repo git, a extração não produz nada ou algo
 * falhou — sempre fail-open, nunca lança.
 */
export async function ensureBusinessModel(
  scope: ProjectExecutionScope,
  options: EnsureBusinessModelOptions = {},
): Promise<StoredBusinessModel | null> {
  const now = options.now ?? Date.now;
  const git = options.git ?? new AsyncProcessGitRunner();
  const root = scope.rootRealPath;
  const headSha = await headShaFor(root, git, now).catch(() => null);
  if (!headSha) return null;

  const stored = readBusinessModelAt(scope, headSha);
  if (stored) return stored;

  const flightKey = `${scope.installationId}\0${scope.projectId}\0${headSha}`;
  const running = flights.get(flightKey);
  if (running) return options.wait === false ? null : running;

  const extract = options.extract ?? extractBusinessModel;
  const flight = (async (): Promise<StoredBusinessModel | null> => {
    const startedAt = now();
    try {
      const extraction = await extract(root, { source: 'head', git });
      if (!extraction) return null;
      const record = writeBusinessModel(scope, {
        headSha,
        fingerprint: extraction.fingerprint,
        document: extraction.document,
        hurdles: extraction.hurdles,
        extractedAt: now(),
      });
      trace({
        kind: 'business-model',
        phase: 'extract',
        ms: now() - startedAt,
        headSha: headSha.slice(0, 7),
        flows: extraction.document.flows.length,
        invariants: extraction.document.invariants.length,
        hurdles: extraction.hurdles.length,
      });
      return record;
    } catch {
      return null;
    } finally {
      flights.delete(flightKey);
    }
  })();
  flights.set(flightKey, flight);
  if (options.wait === false) {
    // Evita unhandled rejection se o consumidor não aguardar o flight.
    flight.catch(() => undefined);
    return null;
  }
  return flight;
}

/** Test-only. */
export function __resetBusinessModelEnsureForTests(): void {
  headCache.clear();
  flights.clear();
}
