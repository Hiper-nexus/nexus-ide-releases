/**
 * Vigia de esteira (F-714): missão rodando, Maestro vivo e NENHUM worker há
 * muito tempo. Na noite de 30/09 o Maestro do HiperGO passou ~7h30 rodando
 * sozinho, uma depois da outra, validações locais de 40 a 140 min — e nenhum
 * worker adiantou as próximas unidades enquanto isso. Os vigias existentes
 * não pegam o caso: chef-idle e zero-entrega exigem workers vivos. Este
 * lembra o Maestro, por handoff de supervisor, de manter a esteira andando;
 * nunca decide por ele (se nada pode avançar antes do gate, ele diz e segue).
 */

export const MOMENTUM_SOLO_MS = 20 * 60_000;
export const MOMENTUM_REPEAT_MS = 60 * 60_000;

export type MomentumDecision =
  | { readonly action: 'none' }
  | { readonly action: 'nudge'; readonly soloForMs: number };

export function decideMomentumNudge(input: {
  readonly missionStatus: string;
  readonly lane?: string | null;
  /** Orçamento de workers da missão; 0 = execução direta. */
  readonly maxWorkers?: number | null;
  readonly workerPanes: number;
  /** Pane do orquestrador existe e não saiu/estacionou. */
  readonly orchestratorAlive: boolean;
  /** Desde quando a missão está sem worker (null = tem worker agora). */
  readonly soloSinceMs: number | null;
  readonly lastNudgeAtMs: number | null;
  readonly now: number;
}): MomentumDecision {
  if (input.missionStatus !== 'running') return { action: 'none' };
  if (input.lane === 'plan' || input.lane === 'consult') return { action: 'none' };
  if (input.maxWorkers === 0) return { action: 'none' };
  if (!input.orchestratorAlive || input.workerPanes > 0) return { action: 'none' };
  if (input.soloSinceMs === null) return { action: 'none' };
  const soloForMs = input.now - input.soloSinceMs;
  if (soloForMs < MOMENTUM_SOLO_MS) return { action: 'none' };
  if (input.lastNudgeAtMs !== null && input.now - input.lastNudgeAtMs < MOMENTUM_REPEAT_MS) {
    return { action: 'none' };
  }
  return { action: 'nudge', soloForMs };
}

export function momentumNudgeSummary(missionId: string, soloForMs: number): string {
  const minutes = Math.max(1, Math.round(soloForMs / 60_000));
  return (
    `[momentum:${missionId}] Esteira parada: a missão está sem nenhum worker há ${minutes} min. ` +
    'Gate longo (validador, make verify, suíte) não para a missão: enquanto ele roda, abra ' +
    'workers para as próximas unidades independentes do objetivo — planejar, implementar em ' +
    'worktree isolada (isolatedWriter: true), revisar. Só comando pesado local vai um por vez, ' +
    'e os workers não rodam suíte pesada enquanto o gate roda. Se nada pode avançar antes do ' +
    'gate, diga o porquê numa linha e siga.'
  );
}
