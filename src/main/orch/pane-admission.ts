/**
 * Admissão de panes de agente (F-572): teto de panes simultâneos + gate por
 * memória do sistema.
 *
 * Incidente 16/09: 22 panes de agente (~1 GB cada: CLI + servidores MCP
 * filhos) num Mac de 24 GB levaram o sistema ao swap e ao freeze; o operador
 * desligou no botão. Nenhum caminho de spawn tinha teto global (maxWorkers só
 * vale por missão) e nada olhava a memória antes de abrir mais um.
 *
 * Doutrina "menos travas": a recusa tem dano nomeado (freeze da máquina) e
 * SEMPRE diz o caminho que funciona — quais panes ociosos fechar e como.
 * Limites vêm de env para o operador ajustar sem rebuild; NEXUS_PANE_GUARD=off
 * desliga o teto (a telemetria continua).
 */

import { execFile } from 'node:child_process';
import os from 'node:os';

export interface PaneAdmissionLimits {
  readonly enabled: boolean;
  /** Panes de agente (cli-agent) vivos ao mesmo tempo. */
  readonly maxAgentPanes: number;
  /** Abaixo disto de memória livre, nenhum pane novo. */
  readonly minFreeMB: number;
  /** Acima disto de swap em uso, nenhum pane novo. */
  readonly maxSwapUsedMB: number;
}

/**
 * Limites proporcionais à RAM (0.76.44). Régua: reserva 8 GB para SO + apps
 * e ~1,25 GB por pane de agente; mínimo disponível = 15 % da RAM (num Mac de
 * 24 GB, 3,6 GB — 1 GB era tarde demais, a máquina já paginava); swap > 1 GB
 * = já está paginando. Teto entre 4 e 12: acima disso quem governa é o
 * guardian, não a RAM.
 */
export function limitsForMachine(totalMB: number): PaneAdmissionLimits {
  const total = Number.isFinite(totalMB) && totalMB > 0 ? totalMB : 24 * 1024;
  const byRam = Math.floor((total - 8 * 1024) / 1280);
  return Object.freeze({
    enabled: true,
    maxAgentPanes: Math.min(12, Math.max(4, byRam)),
    minFreeMB: Math.max(1024, Math.round(0.15 * total)),
    maxSwapUsedMB: 1024,
  });
}

/** Referência documentada: a régua aplicada a um Mac de 24 GB. */
export const DEFAULT_PANE_ADMISSION_LIMITS: PaneAdmissionLimits = limitsForMachine(24 * 1024);

/** Os mesmos limiares do gate de spawn, lidos como "a máquina já está sob pressão". */
export function isUnderMemoryPressure(
  sample: SystemMemorySample | null,
  limits: PaneAdmissionLimits,
): boolean {
  if (!sample) return false;
  if (sample.freeMB !== null && sample.freeMB < limits.minFreeMB) return true;
  if (sample.swapUsedMB !== null && sample.swapUsedMB > limits.maxSwapUsedMB) return true;
  return false;
}

export interface SystemMemorySample {
  readonly freeMB: number | null;
  readonly swapUsedMB: number | null;
}

export interface IdlePaneCandidate {
  readonly paneId: string;
  readonly paneNumber?: number;
  readonly title?: string;
  readonly idleForMs: number;
}

export interface PaneAdmissionInput {
  readonly liveAgentPanes: number;
  readonly limits: PaneAdmissionLimits;
  readonly memory: SystemMemorySample | null;
  readonly idleCandidates: readonly IdlePaneCandidate[];
}

export type PaneAdmissionVerdict =
  | { readonly ok: true; readonly warning?: string }
  | {
      readonly ok: false;
      readonly reason: 'cap' | 'memory';
      readonly message: string;
    };

const CAP_WARNING_RATIO = 0.8;

function describeIdleCandidates(candidates: readonly IdlePaneCandidate[]): string {
  if (candidates.length === 0) {
    return 'Nenhum pane ocioso para sugerir; feche panes que já entregaram.';
  }
  const sorted = [...candidates].sort((a, b) => b.idleForMs - a.idleForMs);
  const names = sorted.slice(0, 6).map((candidate) => {
    const label =
      candidate.paneNumber !== undefined
        ? `pane ${candidate.paneNumber}`
        : candidate.paneId;
    const minutes = Math.round(candidate.idleForMs / 60_000);
    const title = candidate.title ? ` "${candidate.title}"` : '';
    return `${label}${title} (ocioso há ${minutes} min)`;
  });
  return (
    `Panes ociosos para fechar primeiro: ${names.join('; ')}. ` +
    'Feche com nexus_pane_close (paneId ou scope caller_workspace) ou pelo ✕ do cabeçalho.'
  );
}

export function evaluatePaneAdmission(input: PaneAdmissionInput): PaneAdmissionVerdict {
  const { limits, memory } = input;
  if (!limits.enabled) return { ok: true };

  if (input.liveAgentPanes >= limits.maxAgentPanes) {
    return {
      ok: false,
      reason: 'cap',
      message:
        `Teto de ${limits.maxAgentPanes} panes de agente atingido ` +
        `(${input.liveAgentPanes} vivos). ${describeIdleCandidates(input.idleCandidates)} ` +
        'Ajuste o teto com NEXUS_PANE_CAP se esta máquina aguenta mais.',
    };
  }

  if (memory) {
    if (memory.freeMB !== null && memory.freeMB < limits.minFreeMB) {
      return {
        ok: false,
        reason: 'memory',
        message:
          `Memória livre baixa (${Math.round(memory.freeMB)} MB < ${limits.minFreeMB} MB): ` +
          `abrir mais um pane levaria a máquina ao swap. ${describeIdleCandidates(input.idleCandidates)}`,
      };
    }
    if (memory.swapUsedMB !== null && memory.swapUsedMB > limits.maxSwapUsedMB) {
      return {
        ok: false,
        reason: 'memory',
        message:
          `Swap em uso alto (${Math.round(memory.swapUsedMB)} MB > ${limits.maxSwapUsedMB} MB): ` +
          `a máquina já está paginando. ${describeIdleCandidates(input.idleCandidates)}`,
      };
    }
  }

  const next = input.liveAgentPanes + 1;
  if (next >= Math.ceil(limits.maxAgentPanes * CAP_WARNING_RATIO)) {
    return {
      ok: true,
      warning:
        `${next}/${limits.maxAgentPanes} panes de agente após este spawn — ` +
        'feche os que já entregaram antes de abrir mais.',
    };
  }
  return { ok: true };
}

function envInt(value: string | undefined, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

export function readPaneAdmissionLimits(
  env: NodeJS.ProcessEnv = process.env,
  totalMB: number = os.totalmem() / (1024 * 1024),
): PaneAdmissionLimits {
  const base = limitsForMachine(totalMB);
  const guard = (env.NEXUS_PANE_GUARD ?? '').trim().toLowerCase();
  return {
    enabled: !(guard === 'off' || guard === '0' || guard === 'false'),
    maxAgentPanes: envInt(env.NEXUS_PANE_CAP, base.maxAgentPanes, 1),
    minFreeMB: envInt(env.NEXUS_PANE_MIN_FREE_MB, base.minFreeMB, 0),
    maxSwapUsedMB: envInt(env.NEXUS_PANE_MAX_SWAP_MB, base.maxSwapUsedMB, 0),
  };
}

// ---------------------------------------------------------------------------
// Leitura da memória do sistema (barata, com cache curto).
// ---------------------------------------------------------------------------

interface SystemMemoryInfoLike {
  readonly total?: number;
  readonly free?: number;
  readonly available?: number;
  readonly swapTotal?: number;
  readonly swapFree?: number;
}

function parseDarwinSwapUsage(output: string): number | null {
  // "total = 2048.00M  used = 1234.50M  free = 813.50M  (encrypted)"
  const match = output.match(/used\s*=\s*([\d.]+)([MG])/i);
  if (!match) return null;
  const value = Number.parseFloat(match[1] ?? '');
  if (!Number.isFinite(value)) return null;
  return match[2]?.toUpperCase() === 'G' ? value * 1024 : value;
}

/**
 * macOS: "free" do Electron NÃO é sinal de pressão (um Mac saudável de 24 GB
 * mostra ~800 MB livres com 5 GB inativos). O sinal do kernel é
 * `kern.memorystatus_level` (% de memória disponível, 0-100) — o mesmo que
 * o jetsam usa. Convertido em MB disponíveis sobre `hw.memsize`.
 */
export interface DarwinMemoryReading {
  readonly availableMB: number | null;
  readonly swapUsedMB: number | null;
}

export function parseDarwinSysctl(output: string): DarwinMemoryReading {
  // `sysctl -n kern.memorystatus_level vm.swapusage hw.memsize` → 3 linhas.
  const lines = output.split('\n').map((line) => line.trim());
  const level = Number.parseInt(lines[0] ?? '', 10);
  const swapUsedMB = parseDarwinSwapUsage(lines[1] ?? '');
  const memsize = Number.parseInt(lines[2] ?? '', 10);
  const availableMB =
    Number.isFinite(level) && level >= 0 && level <= 100 && Number.isFinite(memsize) && memsize > 0
      ? (level / 100) * (memsize / (1024 * 1024))
      : null;
  return { availableMB, swapUsedMB };
}

export { parseDarwinSwapUsage };

const DARWIN_SAMPLE_TTL_MS = 5_000;
let darwinCache: { at: number; reading: DarwinMemoryReading } | null = null;
let darwinInFlight: Promise<DarwinMemoryReading> | null = null;

function readDarwinMemory(): Promise<DarwinMemoryReading> {
  const now = Date.now();
  if (darwinCache && now - darwinCache.at < DARWIN_SAMPLE_TTL_MS) {
    return Promise.resolve(darwinCache.reading);
  }
  if (darwinInFlight) return darwinInFlight;
  darwinInFlight = new Promise<DarwinMemoryReading>((resolve) => {
    execFile(
      'sysctl',
      ['-n', 'kern.memorystatus_level', 'vm.swapusage', 'hw.memsize'],
      { encoding: 'utf8', timeout: 1_500, killSignal: 'SIGKILL' },
      (error, stdout) => {
        const reading: DarwinMemoryReading = error
          ? { availableMB: null, swapUsedMB: null }
          : parseDarwinSysctl(stdout);
        darwinCache = { at: Date.now(), reading };
        darwinInFlight = null;
        resolve(reading);
      },
    );
  });
  return darwinInFlight;
}

function readElectronMemory(): SystemMemoryInfoLike | null {
  const read = (
    process as NodeJS.Process & { getSystemMemoryInfo?: () => SystemMemoryInfoLike }
  ).getSystemMemoryInfo;
  if (typeof read !== 'function') return null;
  try {
    return read.call(process);
  } catch {
    return null;
  }
}

/**
 * Amostra da memória do sistema para o gate. `free` do Electron é em KB.
 * macOS: swap via `sysctl vm.swapusage` (o Electron só expõe swap em
 * Windows/Linux). Ausência de dado vira null — o gate nunca inventa pressão.
 */
export async function sampleSystemMemory(
  platform: NodeJS.Platform = process.platform,
): Promise<SystemMemorySample | null> {
  const info = readElectronMemory();
  if (!info) return null;
  const kbToMB = (value: number | undefined): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value / 1024 : null;
  if (platform === 'darwin') {
    // Sinal do kernel (memorystatus_level × memsize); `free` cru só como
    // último recurso quando o sysctl falhar.
    const darwin = await readDarwinMemory();
    return {
      freeMB: darwin.availableMB ?? kbToMB(info.free),
      swapUsedMB: darwin.swapUsedMB,
    };
  }
  // Linux expõe `available`, que já conta cache recuperável; nos demais, `free`.
  const freeMB = platform === 'linux' ? kbToMB(info.available) ?? kbToMB(info.free) : kbToMB(info.free);
  const swapUsedMB =
    typeof info.swapTotal === 'number' && typeof info.swapFree === 'number'
      ? (info.swapTotal - info.swapFree) / 1024
      : null;
  return { freeMB, swapUsedMB };
}

// ---------------------------------------------------------------------------
// Cache síncrono para o gate de spawn: o spawn não pode esperar `sysctl`;
// uma amostra de até MEMORY_CACHE_TTL_MS atrás é boa o bastante para dizer
// "a máquina já está em swap". Stale dispara refresh em background.
// ---------------------------------------------------------------------------

const MEMORY_CACHE_TTL_MS = 5_000;
let memoryCache: { at: number; sample: SystemMemorySample | null } | null = null;
let memoryRefreshInFlight: Promise<void> | null = null;

export function refreshSystemMemorySample(): Promise<void> {
  if (memoryRefreshInFlight) return memoryRefreshInFlight;
  memoryRefreshInFlight = sampleSystemMemory()
    .then(
      (sample) => {
        memoryCache = { at: Date.now(), sample };
      },
      () => {
        memoryCache = { at: Date.now(), sample: null };
      },
    )
    .finally(() => {
      memoryRefreshInFlight = null;
    });
  return memoryRefreshInFlight;
}

/** Última amostra conhecida (ou null); dispara refresh quando vencida. */
export function getCachedSystemMemory(now = Date.now()): SystemMemorySample | null {
  if (!memoryCache || now - memoryCache.at >= MEMORY_CACHE_TTL_MS) {
    void refreshSystemMemorySample();
  }
  return memoryCache?.sample ?? null;
}

export function primeSystemMemoryCacheForTest(
  sample: SystemMemorySample | null,
  at = Date.now(),
): void {
  memoryCache = { at, sample };
}

// ---------------------------------------------------------------------------
// Gate síncrono chamado pelo pty-manager (ponto físico único de spawn de
// agente — cobre "+ Pane", nexus_pane_spawn, Via Rápida, respawn, revival e
// spawns main-owned). O pty-manager conta as sessões; quem sabe NOMEAR os
// panes ociosos (número/título) é o registro de panes, que se registra aqui
// como conselheiro para não criar ciclo de import.
// ---------------------------------------------------------------------------

export interface PaneAdmissionAdvisor {
  readonly idleCandidates: (now: number) => readonly IdlePaneCandidate[];
}

let advisor: PaneAdmissionAdvisor | null = null;

export function registerPaneAdmissionAdvisor(next: PaneAdmissionAdvisor | null): void {
  advisor = next;
}

/**
 * Veredito síncrono para um spawn de agente. Nunca lança: defeito interno da
 * telemetria vira admissão (fail-open com aviso) — o gate protege a máquina,
 * não pode virar uma trava nova para a mão do operador.
 */
export function admitAgentSpawnSync(
  liveAgentPanes: number,
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): PaneAdmissionVerdict {
  try {
    const limits = readPaneAdmissionLimits(env);
    if (!limits.enabled) return { ok: true };
    let idleCandidates: readonly IdlePaneCandidate[] = [];
    try {
      idleCandidates = advisor?.idleCandidates(now) ?? [];
    } catch {
      idleCandidates = [];
    }
    return evaluatePaneAdmission({
      liveAgentPanes,
      limits,
      memory: getCachedSystemMemory(now),
      idleCandidates,
    });
  } catch (error) {
    return {
      ok: true,
      warning: `gate de admissão indisponível, admitindo: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
