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
 * Workers automáticos de missão respeitam o orçamento de paralelismo; para
 * a mão do operador a trava dura é opt-in (CAP_HARD=1 ou GUARD=hard).
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
 *
 * Máquinas ≤ 16 GB usam uma estimativa conservadora de 10 GB para SO +
 * apps, limitando o teto de 16 GB a 4 panes. A admissão também considera a
 * memória disponível; este teto não garante ausência de swap em todo projeto.
 * Acima de 16 GB a reserva histórica de 8 GB permanece.
 */
export function limitsForMachine(
  totalMB: number,
  platform: NodeJS.Platform = process.platform,
): PaneAdmissionLimits {
  const total = Number.isFinite(totalMB) && totalMB > 0 ? totalMB : 24 * 1024;
  // F-588: Em máquinas inferiores (<= 8 GB), 2 panes é o limite de segurança;
  // em 12 GB, 3; em 16 GB+, 4 a 12 proporcional à RAM livre.
  const minPanes = total <= 8 * 1024 ? 2 : total <= 12 * 1024 ? 3 : 4;
  const osReserveMB = total <= 16 * 1024 ? 10 * 1024 : 8 * 1024;
  const byRam = Math.floor((total - osReserveMB) / 1280);
  // A reserva de 15 % crescia sem teto: 4,9 GB num Mac/PC de 32 GB e 9,8 GB
  // num de 64 GB, bloqueando o 3º worker automático numa máquina com folga
  // real (cliente Windows 32 GB, 2 panes vivos). Teto de 4 GB — e 2 GB no
  // win32, onde o `free` medido ainda ignora parte da Standby List que o
  // `memorystatus_level` do macOS já conta (ver `sampleSystemMemory`). Com
  // isso uma máquina >= 16 GB e poucos panes vivos (<= 4) só recusa quando
  // não cabe nem 1 worker (~1,25 GB) acima da reserva.
  const win32 = platform === 'win32';
  const reserveCapMB = win32 ? 2048 : 4096;
  const reservePct = win32 ? 0.08 : 0.15;
  return Object.freeze({
    enabled: true,
    hardBlocks: false,
    maxAgentPanes: Math.min(12, Math.max(minPanes, byRam)),
    minFreeMB: Math.min(reserveCapMB, Math.max(1024, Math.round(reservePct * total))),
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
  /** Main-owned mission worker; explicit operator panes keep warning-only policy. */
  readonly automaticWorker?: boolean;
}

export type PaneAdmissionVerdict =
  | { readonly ok: true; readonly warning?: string }
  | {
      readonly ok: false;
      readonly reason: 'cap' | 'memory';
      readonly message: string;
    };

export type PaneAdmissionRefusalReason = 'cap' | 'memory';

/**
 * F-1270: recusa de capacidade prefixada com um código estável. O ACK pendente
 * do spawn só retém `Error.message`, então o código é a única forma de o
 * supervisor distinguir "teto/memória" (CLI-agnóstico, não reroteia) de uma
 * recusa da própria CLI (modelo selado etc., que reroteia). Segue o padrão do
 * `LicenseError` (`license_error: message`).
 */
export function paneAdmissionRefusalError(
  reason: PaneAdmissionRefusalReason,
  message: string,
): string {
  return `pane_admission_${reason}: ${message}`;
}

export interface PaneAdmissionRefusal {
  readonly reason: PaneAdmissionRefusalReason;
  readonly message: string;
}

/** Recupera a recusa de capacidade de um `Error.message` (ou string). */
export function parsePaneAdmissionRefusal(error: unknown): PaneAdmissionRefusal | null {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const match = text.match(/\bpane_admission_(cap|memory):\s*([\s\S]*)$/u);
  if (!match) return null;
  return {
    reason: match[1] as PaneAdmissionRefusalReason,
    message: (match[2] ?? '').trim(),
  };
}

/**
 * F-1534: o que é pressão DA MÁQUINA/DA MAIN e o que é a CLI morta.
 *
 * Campo 14/10, com o Main sob carga (6+ workers e o gate de regressão
 * mapeando), spawns recusados viraram "falha da CLI": contaram no disjuntor
 * (F-736), abriram o disjuntor e mandaram a tarefa para uma CLI de qualidade
 * menor. A recusa NÃO era da CLI — era da máquina. Esta função é a régua: ela
 * classifica o texto de recusa que o tap de spawn pendente recebe.
 *
 * O escopo garante a leitura: o tap só fala de tentativas cujo PTY NUNCA
 * nasceu (antes de qualquer sessão), então o texto é do mecanismo de spawn —
 * nunca da saída de uma CLI falando com o provedor. Um erro de rede do
 * provedor chega pelo outro caminho (turno recusado, `provider-request`), que
 * segue sendo falha da conta.
 *
 * Recusa da CLI que NÃO entra aqui e continua sendo falha dela: modelo
 * selado fora do argv, binário ausente no PATH, effort não suportado.
 */
export type MainPressureRefusalKind =
  /** Teto de panes ou memória, pelo gate (F-572/F-1270). */
  | 'admission'
  /** O Main está encerrando PTYs — estado da Main, não da CLI. */
  | 'shutdown'
  /** Licença/teto de agentes: conta da máquina, não a CLI. */
  | 'license'
  /** O SO não cedeu o recurso para o fork (memória, descritores, disco). */
  | 'os-pressure';

export interface MainPressureRefusal {
  readonly kind: MainPressureRefusalKind;
  /** Motivo real, legível, já sem o código interno. */
  readonly message: string;
}

/**
 * `pty-manager` codifica a recusa (`pane_admission_*`); o caminho MCP de
 * `tool-util` joga a mesma recusa como frase para o Maestro ler. As duas são
 * capacidade — as duas precisam ser lidas como tal.
 */
const TOOL_PATH_ADMISSION_REFUSAL =
  /\bspawn recusado pela admiss[aã]o de panes\s*\((?:teto|mem[oó]ria)\)\s*:\s*([\s\S]*)$/iu;
/** Recusa da licença/teto de agentes, com o padrão do `LicenseError`. */
const LICENSE_REFUSAL = /\b(license_agent_limit|license_access_denied)\b\s*:?\s*([\s\S]*)$/iu;
/** Erros de recurso do SO no fork/spawn do PTY (pty-manager re-lança o host). */
const OS_PRESSURE_CODES =
  /\b(?:spawn\s+\S+\s+)?\b(EAGAIN|EMFILE|ENFILE|ENOMEM|ENOSPC|EBUSY|ETXTBSY|ECONNRESET)\b/iu;

/**
 * Recupera a recusa por pressão da Main de um `Error.message` (ou string).
 * Devolve `null` quando a recusa é da própria CLI (ou não é recusa).
 */
export function parseMainPressureRefusal(error: unknown): MainPressureRefusal | null {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!text.trim()) return null;
  // Capacidade tem precedência: o código do gate é mais específico que o texto.
  const admission = parsePaneAdmissionRefusal(text);
  if (admission) {
    return { kind: 'admission', message: admission.message };
  }
  const toolPath = text.match(TOOL_PATH_ADMISSION_REFUSAL);
  if (toolPath) {
    return { kind: 'admission', message: (toolPath[1] ?? '').trim() };
  }
  if (/PTY shutdown is in progress/iu.test(text)) {
    return { kind: 'shutdown', message: 'o Main está encerrando as PTYs' };
  }
  const license = text.match(LICENSE_REFUSAL);
  if (license) {
    return {
      kind: 'license',
      message: (license[2] ?? '').trim() || 'a licença não abre mais agentes nesta máquina',
    };
  }
  const os = text.match(OS_PRESSURE_CODES);
  if (os) {
    return {
      kind: 'os-pressure',
      message: `o sistema não cedeu recurso para abrir a PTY (${os[1]?.toUpperCase()})`,
    };
  }
  return null;
}

/**
 * F-1534: a máquina (ou o Main) está no limite AGORA — falta vaga de pane,
 * falta memória com a reserva dos agentes já vivos, ou o gate está fechado.
 * Só com folga zero; com uma vaga livre a máquina não está sob pressão.
 *
 * É o sinal que segura o disjuntor e o reenvio enquanto o Main está
 * saturado: uma CLI que "não começou" porque a máquina não tinha vaga não é
 * uma CLI quebrada.
 */
export function mainPressureNow(
  deps: {
    readonly limits?: PaneAdmissionLimits;
    readonly env?: NodeJS.ProcessEnv;
    readonly liveAgentPanes?: () => number;
    readonly now?: number;
  } = {},
): boolean {
  try {
    const limits = deps.limits ?? readPaneAdmissionLimits(deps.env);
    // Gate desligado: o dono da máquina mandou não travar. Sem pressão do gate
    // não há recusa por carga para culpar.
    if (!limits.enabled) return false;
    const now = deps.now ?? Date.now();
    const memory = getMemoryAfterAgentReservations(now) ?? getCachedSystemMemory(now);
    if (isUnderMemoryPressure(memory, limits)) return true;
    const liveAgentPanes = deps.liveAgentPanes?.() ?? 0;
    const budget = parallelHelperBudget({ liveAgentPanes, limits, memory });
    return budget !== null && budget.slots === 0;
  } catch {
    // A telemetria nunca vira trava: sem leitura, sem pressão inventada.
    return false;
  }
}

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
  if (input.automaticWorker) {
    const budget = parallelHelperBudget(input);
    if (budget && budget.slots === 0) {
      const message = budget.limitedBy === 'cap'
        ? capMessage
        : memory?.freeMB !== null && memory
          ? `Memória RAM da máquina sem folga para outro worker: ${Math.round(memory.freeMB)} MB livres medidos ` +
            `< reserva de ${limits.minFreeMB} MB + ${AGENT_PANE_FOOTPRINT_MB} MB por worker ` +
            `(folga de memória física, não limite do plano). ${idleHint}`
          : `Memória sem folga para outro worker (${AGENT_PANE_FOOTPRINT_MB} MB acima da reserva de ${limits.minFreeMB} MB; ` +
            `memória física da máquina, não limite do plano). ${idleHint}`;
      return {
        ok: false,
        reason: budget.limitedBy === 'cap' ? 'cap' : 'memory',
        message: `${message} Aguarde a saída dos workers em andamento e tente novamente; continue a missão em lotes.`,
      };
    }
  }
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
  platform: NodeJS.Platform = process.platform,
): PaneAdmissionLimits {
  const base = limitsForMachine(totalMB, platform);
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
// F-784: orçamento de paralelismo — o teto que amarra o leque da delegação.
// ---------------------------------------------------------------------------

/** Régua de `limitsForMachine`: ~1,25 GB por pane de agente (CLI + MCP filhos). */
export const AGENT_PANE_FOOTPRINT_MB = 1280;

export interface ParallelHelperBudget {
  /** Helpers novos que cabem agora; 0 = não abrir mais. */
  readonly slots: number;
  /** O que fixou o número: teto de panes vivos, memória disponível ou swap armado. */
  readonly limitedBy: 'cap' | 'memory' | 'swap';
  readonly liveAgentPanes: number;
  readonly maxAgentPanes: number;
  /** Memória disponível do kernel; null = sem amostra (só o teto de panes decide). */
  readonly freeMB: number | null;
}

/**
 * Quantos helpers o Nexus pode PEDIR agora em paralelo (F-784). Missão
 * Terminais, 03/10: ~15 CLIs vivas, dois `tsc` de 720 MB e 9,2 de 10 GB de
 * swap — e a diretiva de delegação ainda mandava abrir "um worker por parte".
 * Mesmos insumos do gate de spawn (F-572): panes de agente vivos contra o
 * teto proporcional à RAM e a memória disponível do kernel acima do mínimo
 * livre, à régua de ~1,25 GB por pane. Sem amostra de memória só o teto de
 * panes conta (o gate nunca inventa pressão); guard desligado
 * (`NEXUS_PANE_GUARD=off`) = sem orçamento (null).
 */
export function parallelHelperBudget(input: {
  readonly liveAgentPanes: number;
  readonly limits: PaneAdmissionLimits;
  readonly memory: SystemMemorySample | null;
}): ParallelHelperBudget | null {
  const { limits, memory, liveAgentPanes } = input;
  if (!limits.enabled) return null;
  const capSlots = Math.max(0, limits.maxAgentPanes - liveAgentPanes);
  const freeMB = memory?.freeMB ?? null;
  const base = {
    liveAgentPanes,
    maxAgentPanes: limits.maxAgentPanes,
    freeMB,
  };
  // Swap só pesa onde a máquina armou o gate dela (ver isUnderMemoryPressure).
  if (
    limits.maxSwapUsedMB > 0 &&
    memory !== null &&
    memory.swapUsedMB !== null &&
    memory.swapUsedMB > limits.maxSwapUsedMB
  ) {
    return { ...base, slots: 0, limitedBy: 'swap' };
  }
  const memorySlots =
    freeMB === null
      ? capSlots
      : Math.max(0, Math.floor((freeMB - limits.minFreeMB) / AGENT_PANE_FOOTPRINT_MB));
  return memorySlots < capSlots
    ? { ...base, slots: memorySlots, limitedBy: 'memory' }
    : { ...base, slots: capSlots, limitedBy: 'cap' };
}

/**
 * Helpers a abrir AGORA para `parts` partes independentes: todas, até o teto
 * seguro. Sem orçamento (guard desligado) não há corte.
 */
export function helpersToOpenNow(
  parts: number,
  budget: ParallelHelperBudget | null,
): number {
  const wanted = Math.max(0, Math.floor(parts));
  return budget ? Math.min(wanted, budget.slots) : wanted;
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

/** Dependências de leitura de memória, injetáveis para testes fora do Electron. */
export interface SystemMemoryDeps {
  readonly readElectron?: () => SystemMemoryInfoLike | null;
  /** `os.freemem()` em bytes; injetável para determinismo nos testes. */
  readonly freemem?: () => number;
}

/**
 * Amostra da memória do sistema para o gate. `free` do Electron é em KB.
 * macOS: swap via `sysctl vm.swapusage` (o físico sai do nível do kernel).
 * Windows: o swap do Electron é commit, não swap (ver
 * `parseElectronSwapUsedMB`) e o `free` cru ignora a Standby List (cache
 * reutilizável na hora): o sinal é o MAIOR entre `free`, `os.freemem()`
 * (GlobalMemoryStatusEx ullAvailPhys, inclui standby) e `available`, senão
 * uma máquina de 32 GB com 2 panes parece sem folga para o 3º (cliente
 * 15/10). Ausência de dado vira null — o gate nunca inventa pressão.
 */
export async function sampleSystemMemory(
  platform: NodeJS.Platform = process.platform,
  deps: SystemMemoryDeps = {},
): Promise<SystemMemorySample | null> {
  const info = (deps.readElectron ?? readElectronMemory)();
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
  if (platform === 'win32') {
    const freeMB = Math.max(
      kbToMB(info.free) ?? 0,
      Math.floor((deps.freemem ?? os.freemem)() / (1024 * 1024)),
      kbToMB(info.available) ?? 0,
    );
    return { freeMB, swapUsedMB: parseElectronSwapUsedMB(info, platform) };
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
interface AgentMemoryCensus {
  readonly live: number;
  readonly pending: number;
}
const agentMemoryCensuses = new Map<string, () => AgentMemoryCensus>();
let heavyCommandMemoryReservation: (() => number) | null = null;
let lastPaneSpawnAdmittedAt = 0;
let paneSpawnEntriesInFlight = 0;
const paneSpawnActivityListeners = new Set<(at: number) => void>();

function notePaneSpawnAdmitted(now: number): void {
  lastPaneSpawnAdmittedAt = Math.max(lastPaneSpawnAdmittedAt, now);
  for (const listener of paneSpawnActivityListeners) {
    try {
      listener(now);
    } catch {
      // Activity listeners must never interfere with pane admission.
    }
  }
}

/**
 * Counts a `pty:spawn` call from entry until its result settles. Permit,
 * Codex-version and native-proof waits happen before any transport marks the
 * pane as spawning, so the census alone cannot see them.
 */
export function trackPaneSpawnEntry<T>(run: () => T): T {
  paneSpawnEntriesInFlight += 1;
  const settle = () => {
    paneSpawnEntriesInFlight = Math.max(0, paneSpawnEntriesInFlight - 1);
    notePaneSpawnAdmitted(Date.now());
  };
  let result: T;
  try {
    result = run();
  } catch (error) {
    settle();
    throw error;
  }
  if (result instanceof Promise) {
    void result.then(settle, settle);
    return result;
  }
  settle();
  return result;
}

/** True while a pty:spawn call or any agent transport (PTY or ACP) is still starting a pane. */
export function hasPendingPaneSpawns(): boolean {
  if (paneSpawnEntriesInFlight > 0) return true;
  const census = readAgentMemoryCensus();
  return census !== null && census.pending > 0;
}

export function getLastPaneSpawnAdmittedAt(): number {
  return lastPaneSpawnAdmittedAt;
}

export function onPaneSpawnActivity(listener: (at: number) => void): () => void {
  paneSpawnActivityListeners.add(listener);
  return () => {
    paneSpawnActivityListeners.delete(listener);
  };
}

export function resetPaneSpawnActivityForTest(): void {
  lastPaneSpawnAdmittedAt = 0;
  paneSpawnEntriesInFlight = 0;
}

/** Main's heavy-command pool owns this counter; keeps admission acyclic. */
export function registerHeavyCommandMemoryReservation(read: () => number): void {
  heavyCommandMemoryReservation = read;
}

/** Main supplies physical reservations; no process probe runs on the spawn path. */
export function registerAgentMemoryCensus(read: () => AgentMemoryCensus, source = 'pty'): () => void {
  agentMemoryCensuses.set(source, read);
  return () => { if (agentMemoryCensuses.get(source) === read) agentMemoryCensuses.delete(source); };
}

function readAgentMemoryCensus(): AgentMemoryCensus | null {
  if (agentMemoryCensuses.size === 0) return null;
  let live = 0;
  let pending = 0;
  for (const read of agentMemoryCensuses.values()) {
    const census = read();
    // Each transport reads the SAME physical license count, but owns only
    // its own pending startups. Never count the shared live inventory twice.
    live = Math.max(live, census.live);
    pending += census.pending;
  }
  return { live, pending };
}

let memoryCache: { at: number; sample: SystemMemorySample | null; allocatedAgents: number | null } | null = null;
let memoryRefreshInFlight: Promise<void> | null = null;

function allocatedAgentCount(): number | null {
  const census = readAgentMemoryCensus();
  return census ? census.live - census.pending : null;
}

export function refreshSystemMemorySample(
  deps: SystemMemoryDeps & { readonly platform?: NodeJS.Platform } = {},
): Promise<void> {
  if (memoryRefreshInFlight) return memoryRefreshInFlight;
  // Capture BEFORE reading: children starting during the async sample cannot
  // be assumed to have their footprint reflected in it. But a pane whose
  // startup already COMPLETED before the read finished IS in the sample —
  // count it too, or the reservation below debits 1280 MB per pane the system
  // already measured (cliente Windows 32 GB: 2 panes vivos, 3º recusado).
  const before = allocatedAgentCount();
  const maxAllocated = (a: number | null, b: number | null): number | null =>
    a === null ? b : b === null ? a : Math.max(a, b);
  memoryRefreshInFlight = sampleSystemMemory(deps.platform ?? process.platform, deps)
    .then(
      (sample) => {
        memoryCache = {
          at: Date.now(),
          sample,
          allocatedAgents: maxAllocated(before, allocatedAgentCount()),
        };
      },
      () => {
        memoryCache = { at: Date.now(), sample: null, allocatedAgents: before };
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

/** Shared by agent and heavy-command admission; never mutates the raw sample. */
export function getMemoryAfterAgentReservations(now = Date.now()): SystemMemorySample | null {
  const memory = getCachedSystemMemory(now);
  if (!memory || memory.freeMB === null) return memory;
  const census = readAgentMemoryCensus();
  if (!census) return memory;
  // A cached MB cannot fund multiple children. Pending startup stays reserved
  // across refreshes until a sample starts after startup has completed.
  const unmeasured = Math.max(census.pending, census.live - (memoryCache?.allocatedAgents ?? census.live));
  return { ...memory, freeMB: memory.freeMB - unmeasured * AGENT_PANE_FOOTPRINT_MB };
}

export function primeSystemMemoryCacheForTest(
  sample: SystemMemorySample | null,
  at = Date.now(),
): void {
  memoryCache = { at, sample, allocatedAgents: allocatedAgentCount() };
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
  request: { readonly agentRequested?: boolean; readonly automaticWorker?: boolean } = {},
): PaneAdmissionVerdict {
  try {
    const limits = readPaneAdmissionLimits(env);
    if (!limits.enabled) {
      notePaneSpawnAdmitted(now);
      return { ok: true };
    }
    // Only trusted automatic mission workers consume the delegation budget.
    // Human panes and workspace helpers retain the existing warning policy.
    let idleCandidates: readonly IdlePaneCandidate[] = [];
    try {
      idleCandidates = advisor?.idleCandidates(now) ?? [];
    } catch {
      idleCandidates = [];
    }
    let memory = request.automaticWorker ? getMemoryAfterAgentReservations(now) : getCachedSystemMemory(now);
    if (request.automaticWorker && memory && memory.freeMB !== null) {
      // The inverse race: a heavy job may have reserved the same cached MB
      // before this spawn. Its pool already debits itself, so only agent
      // admission applies this additional reservation.
      memory = { ...memory, freeMB: memory.freeMB - (heavyCommandMemoryReservation?.() ?? 0) };
    }
    const verdict = evaluatePaneAdmission({
      liveAgentPanes,
      limits,
      memory,
      idleCandidates,
      automaticWorker: request.automaticWorker,
    });
    if (verdict.ok) {
      notePaneSpawnAdmitted(now);
    }
    return verdict;
  } catch (error) {
    notePaneSpawnAdmitted(now);
    return {
      ok: true,
      warning: `gate de admissão indisponível, admitindo: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * F-1270: admissão do caminho MCP (`nexus_pane_spawn` → `spawnPaneAndMaybePrompt`).
 * O caminho do renderer (`spawnAgentSession`) já chama `admitAgentSpawnSync`; o
 * caminho MCP só conferia a LICENÇA (`assertLicensedAgentCapacity`), que é
 * ilimitada no Pro, então o `nexus_pane_spawn` devolvia `ok:true` com o teto de
 * panes esgotado e a recusa real ficava presa no renderer. Aqui o MCP recusa na
 * hora, com a MESMA contagem do renderer: worker de missão usa a reserva de
 * licença (`licensedAgentPanes`), humano usa os panes vivos (`liveAgentPanes`).
 */
export interface ToolSpawnAdmissionRequest {
  readonly role?: 'orchestrator' | 'worker';
  readonly missionId?: string;
  readonly operatorOpened?: boolean;
  readonly liveAgentPanes: number;
  readonly licensedAgentPanes: number;
  readonly now?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export function admitToolSpawnSync(request: ToolSpawnAdmissionRequest): PaneAdmissionVerdict {
  const automaticWorker =
    request.role === 'worker' &&
    Boolean(request.missionId) &&
    request.operatorOpened !== true;
  const liveAgentPanes = automaticWorker ? request.licensedAgentPanes : request.liveAgentPanes;
  return admitAgentSpawnSync(
    liveAgentPanes,
    request.now ?? Date.now(),
    request.env ?? process.env,
    { automaticWorker },
  );
}
