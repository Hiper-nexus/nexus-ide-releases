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

type StallWatchEvent = 'pause' | 'orchestration-gate';
const stallWatchListeners = new WeakMap<
  PhaseTimer,
  Set<(event: StallWatchEvent) => void>
>();

export function startPhaseTimer(
  now: () => number = () => Date.now(),
): PhaseTimer {
  const startedAt = now();
  let lastAt = startedAt;
  const phases: Record<string, number> = {};
  let lastPhase: string | null = null;
  const timer: PhaseTimer = {
    lastPhase: () => lastPhase,
    mark(name: string): void {
      const at = now();
      lastPhase = name;
      // Relógio de parede pode andar para trás; um delta negativo destruiria
      // a soma das fases — telemetria nunca reporta tempo negativo.
      phases[name] = (phases[name] ?? 0) + Math.max(0, at - lastAt);
      lastAt = at;
      if (name === 'orchestration-gate') {
        const listeners = stallWatchListeners.get(timer);
        if (listeners) {
          for (const listener of listeners) listener('orchestration-gate');
        }
      }
    },
    finish(): PhaseTimingResult {
      return { totalMs: Math.max(0, now() - startedAt), phases };
    },
  };
  return timer;
}

export interface PhaseTimerStall extends PhaseTimingResult {
  /** Last finished phase: the spawn is stuck in whatever awaits after it. */
  readonly afterPhase: string | null;
}

/**
 * Suspends `watchPhaseTimerStall` while `awaitCliSpawnOrchestration` is in
 * flight (which owns its own 30 s ceiling); marking `orchestration-gate`
 * automatically re-arms a fresh `stallMs` budget for the post-gate phases.
 */
export function pausePhaseTimerStall(timer: PhaseTimer): void {
  const listeners = stallWatchListeners.get(timer);
  if (!listeners) return;
  for (const listener of listeners) listener('pause');
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
  let handle: ReturnType<typeof setTimeout> | null = null;
  let fired = false;
  let stopped = false;
  const disarm = (): void => {
    if (handle !== null) {
      clearTimeout(handle);
      handle = null;
    }
  };
  const arm = (): void => {
    if (stopped || fired) return;
    disarm();
    handle = setTimeout(() => {
      handle = null;
      if (stopped || fired) return;
      fired = true;
      report({ ...timer.finish(), afterPhase: timer.lastPhase() });
    }, stallMs);
    handle.unref?.();
  };
  const onEvent = (event: StallWatchEvent): void => {
    if (event === 'pause') {
      disarm();
    } else if (event === 'orchestration-gate') {
      arm();
    }
  };
  let listeners = stallWatchListeners.get(timer);
  if (!listeners) {
    listeners = new Set();
    stallWatchListeners.set(timer, listeners);
  }
  listeners.add(onEvent);
  arm();
  return () => {
    stopped = true;
    disarm();
    listeners?.delete(onEvent);
  };
}
