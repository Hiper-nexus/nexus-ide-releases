import type { PeriodicTaskContext } from '../observability/periodic-task';
/**
 * Reconciliador de mortalidade: transforma "exit perdido" em exit sintetizado.
 *
 * Caso de campo 20/08 (pane fantasma, recorrente há meses): um worker AGY
 * morreu no nascimento sem que o host publicasse `exit`. Toda a consequência
 * de morte (frame session_exited, aviso ao renderer, reset de status, respawn
 * do fast-lane) é serializada atrás do onExit — exit perdido = sessão imortal:
 * pane preto para sempre, chef em `chef_idle_awaiting_workers` contando o
 * morto como vivo, missão travada.
 *
 * Doutrina (session-liveness.ts): NUNCA colapsar "não sei" em "morto".
 * Este módulo não viola isso — ele ADQUIRE prova: o host responde quais
 * sessões têm handle vivo no seu mapa. Ausência confirmada em N probes
 * consecutivos, após período de graça, é evidência física de que nenhum
 * processo atende a sessão — aí o exit é sintetizado e o pipeline existente
 * de morte roda inteiro. Resposta nula (host mudo/timeout) é unverifiable e
 * nunca condena.
 */

export interface MortalityCandidate {
  readonly sessionId: string;
  /** Momento de criação da sessão no main (ms). */
  readonly spawnedAtMs: number;
}

export interface MortalityReconcilerDeps {
  /** Sessões em estado vivo (spawning/busy/idle) sem voo de terminação. */
  listCandidates(): readonly MortalityCandidate[];
  /**
   * Pergunta ao host quais destas sessões têm handle vivo. `null` = host não
   * respondeu (unverifiable) — nunca interpretar como morte.
   */
  probeLiveness(
    sessionIds: readonly string[],
  ): Promise<ReadonlySet<string> | null>;
  /** Sintetiza o exit perdido (dispara o pipeline de morte existente). */
  condemn(sessionId: string, evidence: { readonly strikes: number }): void;
  log(message: string): void;
  now(): number;
}

export interface MortalityReconcilerOptions {
  /** Idade mínima da sessão antes do primeiro probe (spawn ainda em trânsito). */
  readonly graceMs?: number;
  /** Ausências consecutivas exigidas antes de condenar. */
  readonly strikesToCondemn?: number;
}

const DEFAULT_GRACE_MS = 20_000;
const DEFAULT_STRIKES = 2;

export interface MortalityReconciler {
  /** Uma rodada de reconciliação. Serializada: reentrada vira no-op. */
  tick(context?: PeriodicTaskContext): Promise<void>;
  /** Remove memória de strikes de uma sessão (finalizada por outra via). */
  forget(sessionId: string): void;
}

export function createMortalityReconciler(
  deps: MortalityReconcilerDeps,
  options: MortalityReconcilerOptions = {},
): MortalityReconciler {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const strikesToCondemn = options.strikesToCondemn ?? DEFAULT_STRIKES;
  const strikes = new Map<string, number>();
  let inFlight = false;

  return {
    async tick(context): Promise<void> {
      if (inFlight) return;
      inFlight = true;
      try {
        const now = deps.now();
        const candidates = deps
          .listCandidates()
          .filter((candidate) => now - candidate.spawnedAtMs >= graceMs);
        // Poda memória de sessões que deixaram de ser candidatas (morreram
        // pela via normal ou entraram em terminação) — sem isso, um id
        // reusado herdaria strikes antigos.
        const candidateIds = new Set(candidates.map((c) => c.sessionId));
        for (const id of [...strikes.keys()]) {
          await context?.checkpoint();
          if (!candidateIds.has(id)) strikes.delete(id);
        }
        if (candidates.length === 0) return;

        const live = await deps.probeLiveness(
          candidates.map((c) => c.sessionId),
        );
        context?.assertCurrent();
        if (live === null) return; // unverifiable — nunca condena

        for (const candidate of candidates) {
          await context?.checkpoint();
          const current = deps.listCandidates().find((live) => live.sessionId === candidate.sessionId);
          if (!current || current.spawnedAtMs !== candidate.spawnedAtMs) { strikes.delete(candidate.sessionId); continue; }
          if (live.has(candidate.sessionId)) {
            strikes.delete(candidate.sessionId);
            continue;
          }
          const count = (strikes.get(candidate.sessionId) ?? 0) + 1;
          if (count >= strikesToCondemn) {
            strikes.delete(candidate.sessionId);
            deps.log(
              `[pty] mortalidade: sessão ${candidate.sessionId} sem handle no host ` +
                `em ${count} probes consecutivos — sintetizando exit perdido`,
            );
            deps.condemn(candidate.sessionId, { strikes: count });
          } else {
            strikes.set(candidate.sessionId, count);
          }
        }
      } finally {
        inFlight = false;
      }
    },
    forget(sessionId: string): void {
      strikes.delete(sessionId);
    },
  };
}
