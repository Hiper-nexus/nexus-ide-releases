/**
 * F-213: medidor de fases para o trace `pane-spawn-timing`. O nascimento de
 * um pane de agente passa por etapas encadeadas (preparo de provider, gate de
 * auth rotativo, permissão de spawn, PTY) e o incidente de 28/09 mostrou
 * esperas de ~50 s sem nenhuma pista de ONDE o tempo foi gasto.
 *
 * Uso: crie no início do caminho, chame `mark(name)` ao fim de cada etapa
 * awaitada (o delta medido é sempre desde o mark anterior — ou da criação, no
 * primeiro) e `finish()` no retorno para obter `{ totalMs, phases }`.
 */
export interface PhaseTimingResult {
  readonly totalMs: number;
  /** Duração acumulada por fase, na ordem em que foram marcadas. */
  readonly phases: Readonly<Record<string, number>>;
}

export interface PhaseTimer {
  mark(name: string): void;
  finish(): PhaseTimingResult;
  /** Most recent `mark`, even when its name was visited before. */
  lastPhase(): string | null;
}

export function startPhaseTimer(
  now: () => number = () => Date.now(),
): PhaseTimer {
  const startedAt = now();
  let lastAt = startedAt;
  const phases: Record<string, number> = {};
  let lastPhase: string | null = null;
  return {
    lastPhase: () => lastPhase,
    mark(name: string): void {
      const at = now();
      lastPhase = name;
      // Relógio de parede pode andar para trás; um delta negativo destruiria
      // a soma das fases — telemetria nunca reporta tempo negativo.
      phases[name] = (phases[name] ?? 0) + Math.max(0, at - lastAt);
      lastAt = at;
    },
    finish(): PhaseTimingResult {
      return { totalMs: Math.max(0, now() - startedAt), phases };
    },
  };
}

export interface PhaseTimerStall extends PhaseTimingResult {
  /** Last finished phase: the spawn is stuck in whatever awaits after it. */
  readonly afterPhase: string | null;
}

/**
 * `pane-spawn-timing` is emitted when a spawn settles, so a spawn that never
 * settles leaves no trace at all. Fires `report` once if the timer is still
 * unfinished after `stallMs`; the returned function disarms it.
 */
export function watchPhaseTimerStall(
  timer: PhaseTimer,
  stallMs: number,
  report: (stall: PhaseTimerStall) => void,
): () => void {
  const handle = setTimeout(() => {
    report({ ...timer.finish(), afterPhase: timer.lastPhase() });
  }, stallMs);
  handle.unref?.();
  return () => clearTimeout(handle);
}
