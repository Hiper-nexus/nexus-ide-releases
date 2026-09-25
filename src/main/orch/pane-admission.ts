/**
 * Admissão de panes de agente (F-572): teto de panes simultâneos + gate por
 * memória do sistema.
 *
 * Incidente 16/09: 22 panes de agente (~1 GB cada: CLI + servidores MCP
 * filhos) num Mac de 24 GB levaram o sistema ao swap e ao freeze; o operador
 * desligou no botão. Nenhum caminho de spawn tinha teto global (maxWorkers só
 * vale por missão) e nada olhava a memória antes de abrir mais um.
 *
 * Doutrina "menos travas" (0.76.47): o gate AVISA por padrão — nomeia o dano
 * (freeze da máquina) e o caminho que funciona (quais panes ociosos fechar).
 * Trava dura é opt-in (NEXUS_PANE_CAP_HARD=1 ou NEXUS_PANE_GUARD=hard);
 * limites vêm de env para o operador ajustar sem rebuild; NEXUS_PANE_GUARD=off
 * desliga o teto e a pressão (a telemetria continua).
 *
 * O sinal de memória tem que ser o do AGORA: `free` disponível (o nível do
 * kernel no macOS). Swap em uso entra desarmado por padrão — no macOS ele
 * guarda o pico, não o agora (ver `limitsForMachine`), no Windows o campo do
 * Electron é commit (F-574), e cada máquina tem a sua medida. Lido como
 * pressão, um pico velho vira trava permanente no spawn e reaper em loop.
 */

import { execFile } from 'node:child_process';
import os from 'node:os';

export interface PaneAdmissionLimits {
  readonly enabled: boolean;
  /**
   * Panes de agente (cli-agent) vivos ao mesmo tempo. Por padrão é um AVISO
   * (0.76.45, doutrina "menos travas": contagem sem pressão de memória não
   * tem dano nomeado).
   */
  readonly maxAgentPanes: number;
  /**
   * Trava dura (0.76.47): teto E pressão de memória voltam a recusar o spawn.
   * O padrão é aviso — quem decide é a mão do operador; a válvula é
   * NEXUS_PANE_CAP_HARD=1 ou NEXUS_PANE_GUARD=hard. O guardian/reaper de panes
   * ociosos segue agindo por pressão real independentemente disto.
   */
  readonly hardBlocks: boolean;
  /** Abaixo disto de memória livre o spawn AVISA (recusa só na trava dura). */
  readonly minFreeMB: number;
  /**
   * Acima disto de swap em uso o spawn AVISA (recusa só na trava dura).
   * **0 (o default) = o swap não é sinal de pressão** — ver `limitsForMachine`.
   */
  readonly maxSwapUsedMB: number;
}

/**
 * Limites proporcionais à RAM (0.76.44; swap corrigido na 0.76.47). Régua:
 * reserva 8 GB para SO + apps e ~1,25 GB por pane de agente; mínimo
 * disponível = 15 % da RAM (num Mac de 24 GB, 3,6 GB — 1 GB era tarde demais,
 * a máquina já paginava). Teto entre 4 e 12: acima disso quem governa é o
 * guardian, não a RAM.
 *
 * `maxSwapUsedMB` nasce em 0: **swap em uso não é sinal de pressão**.
 * - No macOS ele nem mede o agora: `vm.swapusage` "used" guarda o pico, e o
 *   XNU não devolve o swap quando a pressão passa. Medido na máquina do
 *   operador com o kernel em NORMAL: 8.151 MB de swap, 62 % de RAM livre — e o
 *   mesmo Mac já chegou a 16 GB. Lido como pressão, um pico antigo vira trava
 *   permanente (o teto de 1 GB da 0.76.44 recusou todo spawn até o reboot) e o
 *   reaper de emergência estaciona um pane ocioso por minuto para sempre.
 * - No Windows o campo do Electron é commit, não swap (F-574).
 * Cada máquina tem a sua medida, então não existe número universal: quem
 * quiser o gate numa máquina específica arma com NEXUS_PANE_MAX_SWAP_MB.
 * O swap segue na telemetria (custo por pane).
 */
export function limitsForMachine(totalMB: number): PaneAdmissionLimits {
  const total = Number.isFinite(totalMB) && totalMB > 0 ? totalMB : 24 * 1024;
  // F-588: Em máquinas inferiores (<= 8 GB), 2 panes é o limite de segurança;
  // em 12 GB, 3; em 16 GB+, 4 a 12 proporcional à RAM livre.
  const minPanes = total <= 8 * 1024 ? 2 : total <= 12 * 1024 ? 3 : 4;
  const byRam = Math.floor((total - 8 * 1024) / 1280);
  return Object.freeze({
    enabled: true,
    hardBlocks: false,
    maxAgentPanes: Math.min(12, Math.max(minPanes, byRam)),
    minFreeMB: Math.max(1024, Math.round(0.15 * total)),
    maxSwapUsedMB: 0,
  });
}

/** Referência documentada: a régua aplicada a um Mac de 24 GB. */
export const DEFAULT_PANE_ADMISSION_LIMITS: PaneAdmissionLimits = limitsForMachine(24 * 1024);

/**
 * Os mesmos limiares do gate de spawn, lidos como "a máquina já está sob
 * pressão". Swap só entra se a máquina armou o gate dela.
 */
export function isUnderMemoryPressure(
  sample: SystemMemorySample | null,
  limits: PaneAdmissionLimits,
): boolean {
  if (!sample) return false;
  if (sample.freeMB !== null && sample.freeMB < limits.minFreeMB) return true;
  if (
    limits.maxSwapUsedMB > 0 &&
    sample.swapUsedMB !== null &&
    sample.swapUsedMB > limits.maxSwapUsedMB
  ) {
    return true;
  }
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

  const idleHint = describeIdleCandidates(input.idleCandidates);
  const capMessage =
    `Teto de ${limits.maxAgentPanes} panes de agente atingido ` +
    `(${input.liveAgentPanes} vivos). ${idleHint} ` +
    'Ajuste o teto com NEXUS_PANE_CAP se esta máquina aguenta mais.';
  if (input.liveAgentPanes >= limits.maxAgentPanes && limits.hardBlocks) {
    return { ok: false, reason: 'cap', message: capMessage };
  }

  if (memory) {
    // Pressão real (0.76.47): por padrão AVISA e deixa a mão do operador
    // decidir; só recusa com NEXUS_PANE_CAP_HARD=1 / NEXUS_PANE_GUARD=hard.
    // O dano nomeado (freeze da máquina) continua escrito no aviso.
    if (memory.freeMB !== null && memory.freeMB < limits.minFreeMB) {
      const message =
        `Memória livre baixa (${Math.round(memory.freeMB)} MB < ${limits.minFreeMB} MB): ` +
        `abrir mais um pane pode levar a máquina ao swap. ${idleHint}`;
      if (limits.hardBlocks) return { ok: false, reason: 'memory', message };
      return { ok: true, warning: message };
    }
    // Swap (0.76.47): só AVISA onde a máquina armou o gate dela
    // (NEXUS_PANE_MAX_SWAP_MB > 0). No macOS o número guarda o pico, não o
    // agora, então avisar por ele acusaria paginação numa máquina saudável.
    if (
      limits.maxSwapUsedMB > 0 &&
      memory.swapUsedMB !== null &&
      memory.swapUsedMB > limits.maxSwapUsedMB
    ) {
      const message =
        `Swap em uso alto (${Math.round(memory.swapUsedMB)} MB > ${limits.maxSwapUsedMB} MB): ` +
        `a máquina está apoiada em disco. ${idleHint} ` +
        'Ajuste com NEXUS_PANE_MAX_SWAP_MB se esta máquina aguenta mais.';
      if (limits.hardBlocks) return { ok: false, reason: 'memory', message };
      return { ok: true, warning: message };
    }
  }

  // Contagem acima do teto sem pressão de memória: aviso, não trava.
  if (input.liveAgentPanes >= limits.maxAgentPanes) {
    return { ok: true, warning: capMessage };
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
  const hard = (env.NEXUS_PANE_CAP_HARD ?? '').trim().toLowerCase();
  return {
    enabled: !(guard === 'off' || guard === '0' || guard === 'false'),
    hardBlocks: guard === 'hard' || hard === '1' || hard === 'true' || hard === 'on',
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
 * Swap em uso a partir do `getSystemMemoryInfo()` do Electron.
 *
 * win32: `swapTotal`/`swapFree` são MEMORYSTATUSEX.ullTotalPageFile/
 * ullAvailPageFile — limite e saldo de COMMIT (RAM + pagefile), não swap. Um
 * desktop saudável reporta > 20 GB de "uso" (medido em 16/09 nesta máquina:
 * 23.023 MB contra 143 MB de pagefile real), então lido como swap ele
 * recusaria TODO spawn de pane com o teto de 1 GB. Commit alto não é
 * paginação: sem sinal de swap a leitura fica ausente e o gate não inventa
 * pressão — o `free` disponível continua decidindo. Linux expõe swap real
 * (sysinfo) e mantém a conta.
 */
export function parseElectronSwapUsedMB(
  info: SystemMemoryInfoLike,
  platform: NodeJS.Platform,
): number | null {
  if (platform === 'win32') return null;
  return typeof info.swapTotal === 'number' && typeof info.swapFree === 'number'
    ? (info.swapTotal - info.swapFree) / 1024
    : null;
}

/**
 * Amostra da memória do sistema para o gate. `free` do Electron é em KB.
 * macOS: swap via `sysctl vm.swapusage` (o físico sai do nível do kernel).
 * Windows: o swap do Electron é commit, não swap (ver
 * `parseElectronSwapUsedMB`). Ausência de dado vira null — o gate nunca
 * inventa pressão.
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
  return { freeMB, swapUsedMB: parseElectronSwapUsedMB(info, platform) };
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
  request: { readonly agentRequested?: boolean } = {},
): PaneAdmissionVerdict {
  try {
    const base = readPaneAdmissionLimits(env);
    if (!base.enabled) return { ok: true };
    // C3 (25/09): delegação automática sem limite de profundidade pode abrir
    // panes em cascata (F-572: 33 panes, Mac em swap). Spawn pedido por AGENTE
    // do operador recusa no teto/pressão; o "+" do operador segue só avisando.
    const limits = request.agentRequested ? { ...base, hardBlocks: true } : base;
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
