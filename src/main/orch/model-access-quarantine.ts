/**
 * F-683: modelo que o provider RECUSOU (acesso desligado, modelo inexistente
 * para a conta) sai do roteamento automático por algumas horas.
 *
 * O failover já troca o modelo do pane recusado (F-520), mas o roteador não
 * sabia disso e mandava o próximo helper para o mesmo modelo — em 29/09 um
 * worker OpenCode caiu em `opencode/deepseek-v4-flash` ("Upstream request
 * failed: Model access is disabled", 5 tentativas e exit 1). Estado em
 * memória do Main: some no reinício, que é quando a conta/CLI pode ter mudado.
 */

export const MODEL_ACCESS_QUARANTINE_MS = 12 * 60 * 60_000;

interface QuarantineEntry {
  readonly until: number;
  readonly reason: string;
}

const quarantined = new Map<string, QuarantineEntry>();

function key(adapterId: string, model: string): string {
  return `${adapterId}\0${model.trim().toLowerCase()}`;
}

export function quarantineRejectedModel(
  adapterId: string,
  model: string | undefined,
  reason: string,
  now = Date.now(),
  durationMs = MODEL_ACCESS_QUARANTINE_MS,
): void {
  if (!model?.trim()) return;
  quarantined.set(key(adapterId, model), { until: now + durationMs, reason });
}

/** Motivo da quarentena ativa, ou null. */
export function modelAccessQuarantine(
  adapterId: string,
  model: string | undefined,
  now = Date.now(),
): string | null {
  if (!model?.trim()) return null;
  const entry = quarantined.get(key(adapterId, model));
  if (!entry) return null;
  if (now >= entry.until) {
    quarantined.delete(key(adapterId, model));
    return null;
  }
  return entry.reason;
}

export function resetModelAccessQuarantineForTests(): void {
  quarantined.clear();
}
