/**
 * F-1483: com missão viva, o Main relê a cota da frota (também as contas
 * inativas) a cada 5 min, mesmo com a janela do Nexus fechada ou escondida.
 * A troca por limite e a cadeia A → B → C decidem por folga MEDIDA e fresca
 * (até 10 min); antes, só o renderer pedia leitura, com a janela visível.
 * A leitura não é forçada: o serviço respeita o TTL, o backoff e o limite de
 * concorrência dele. Uma volta por vez; sem missão, nenhuma leitura.
 */
export const MISSION_QUOTA_POLL_MS = 5 * 60_000;

export interface MissionQuotaPollDeps {
  /** Há pane de missão vivo agora? */
  readonly hasLiveMission: () => boolean;
  /** Snapshot da frota, não forçado. */
  readonly refresh: () => Promise<unknown>;
}

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export function startMissionQuotaPoll(deps: MissionQuotaPollDeps): void {
  stopMissionQuotaPoll();
  timer = setInterval(() => {
    if (inFlight) return;
    let live = false;
    try {
      live = deps.hasLiveMission();
    } catch {
      live = false;
    }
    if (!live) return;
    inFlight = true;
    void Promise.resolve()
      .then(deps.refresh)
      .catch((error) => {
        console.warn('[mission-quota-poll] leitura de cota falhou:', error instanceof Error ? error.message : error);
      })
      .finally(() => {
        inFlight = false;
      });
  }, MISSION_QUOTA_POLL_MS);
  timer.unref?.();
}

export function stopMissionQuotaPoll(): void {
  if (timer) clearInterval(timer);
  timer = null;
  inFlight = false;
}
