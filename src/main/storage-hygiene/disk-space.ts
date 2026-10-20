import fs from 'node:fs';
import type { DiskPressure, DiskSpaceSnapshot } from '../../shared/storage-hygiene';

const GiB = 1024 ** 3;

/**
 * Limiares de folga do volume. Crítico é só ABSOLUTO (5 GB): 40 GB livres num
 * disco de 1 TB são 4% e não são emergência — mas encurtam os prazos (`low`
 * também pela fração). No APFS o statfs não conta o espaço "purgável" (cache
 * de iCloud, snapshots locais): a leitura erra para o lado apertado.
 */
export const DISK_PRESSURE_THRESHOLDS = Object.freeze({
  lowFreeBytes: 20 * GiB,
  lowFreeRatio: 0.08,
  criticalFreeBytes: 5 * GiB,
});

export function diskPressureOf(
  sample: Pick<DiskSpaceSnapshot, 'freeBytes' | 'totalBytes'> | null,
): DiskPressure {
  // Sem leitura, nenhuma ação extra: os prazos normais já são seguros.
  if (!sample || !(sample.totalBytes > 0) || !(sample.freeBytes >= 0)) return 'ok';
  const t = DISK_PRESSURE_THRESHOLDS;
  if (sample.freeBytes < t.criticalFreeBytes) return 'critical';
  if (sample.freeBytes < t.lowFreeBytes || sample.freeBytes / sample.totalBytes < t.lowFreeRatio) return 'low';
  return 'ok';
}

export type StatfsFn = (target: string) => Promise<{ bavail: number | bigint; blocks: number | bigint; bsize: number | bigint }>;

/**
 * Espaço do volume que guarda `target` (statfs funciona em macOS, Linux e
 * Windows desde o Node 18.15). Nunca lança: sem leitura, `null`.
 */
export async function sampleDiskSpace(
  target: string,
  deps: { readonly statfs?: StatfsFn; readonly now?: () => number } = {},
): Promise<DiskSpaceSnapshot | null> {
  const statfs = deps.statfs ?? ((dir: string) => fs.promises.statfs(dir));
  try {
    const stats = await statfs(target);
    const bsize = Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * bsize;
    const totalBytes = Number(stats.blocks) * bsize;
    if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;
    return Object.freeze({ freeBytes, totalBytes, sampledAt: (deps.now ?? Date.now)() });
  } catch {
    return null;
  }
}
