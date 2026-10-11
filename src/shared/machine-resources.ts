import { z } from 'zod';

/**
 * F-1172: recursos da máquina para o operador (card em Uso e cotas e
 * indicador do rail). Vai no perf:snapshot e no push perf:paneFootprints —
 * sem canal novo. O main valida o que monta antes de mandar e o renderer
 * valida o que recebe: payload fora do contrato vira "sem leitura", nunca
 * número inventado.
 *
 * A memória disponível é a MESMA leitura do gate de admissão de panes
 * (memorystatus no macOS, `available` no Linux), e o veredito usa os mesmos
 * limiares — o card nunca diz "ok" enquanto o gate age, nem o contrário.
 */

const bytes = z.number().finite().nonnegative();
const ratio = z.number().finite().min(0).max(1);

export const machineResourcesSchema = z.object({
  sampledAt: z.number().finite().nonnegative(),
  memory: z.object({
    totalBytes: bytes,
    /** Disponível segundo o gate; null = gate sem leitura. */
    availableBytes: bytes.nullable(),
    usedRatio: ratio.nullable(),
    /** Maior uso visto na janela recente. */
    peakUsedRatio: ratio.nullable(),
    swapUsedBytes: bytes.nullable(),
    /** Reserva mínima do gate: abaixo disto é pressão. */
    minFreeBytes: bytes,
  }),
  cpu: z.object({
    cores: z.number().int().nonnegative(),
    /** Load average de 1 min; null onde o SO não expõe (Windows). */
    loadAvg1: z.number().finite().nonnegative().nullable(),
    /** Média do load de 1 min na janela. */
    averageLoad1: z.number().finite().nonnegative().nullable(),
  }),
  nexus: z.object({
    /** Soma do working set dos processos do Electron (app.getAppMetrics). */
    appBytes: bytes.nullable(),
    /** Soma do RSS das árvores dos panes (CLI + filhos); null = host PTY mudo. */
    panesBytes: bytes.nullable(),
    paneCount: z.number().int().nonnegative(),
  }),
  pressure: z.enum(['ok', 'pressure', 'unknown']),
  /** Gate de admissão ligado (NEXUS_PANE_GUARD != off). */
  admissionEnabled: z.boolean(),
  window: z.object({
    samples: z.number().int().nonnegative(),
    spanMs: z.number().finite().nonnegative(),
  }),
});

export type MachineResources = z.infer<typeof machineResourcesSchema>;

/** Valida sem lançar: fora do contrato = null. */
export function parseMachineResources(value: unknown): MachineResources | null {
  const parsed = machineResourcesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
