import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/**
 * Cron — squads/agentes agendados. Tick de 60s: jobs vencidos disparam o brief
 * no workspace (via agentInvoke ou squadSpawn), skip-if-stale para não fazer
 * catch-up em rajada quando o laptop esteve fechado. Parser de 5 campos em TS
 * puro (sem dep). A borda (fire real, IO) fica em cron-store/init; a lógica de
 * tempo é pura e testada.
 */

export interface CronJob {
  id: string;
  name: string;
  /** Expressão cron de 5 campos: minuto hora dom mês dow. */
  schedule: string;
  /** O que rodar (prompt para o agente/squad). */
  brief: string;
  status: 'active' | 'paused';
  /** Shared is fail-closed behind a remote lease; local must be explicit. */
  executionMode?: 'shared' | 'local';
  /** Remote, project-portable identity. Required for shared execution. */
  portableScheduleId?: string;
  /** Optimistic definition version accepted by the remote authority. */
  definitionVersion?: number;
  /** Hash of the exact portable definition represented by this local job. */
  definitionHash?: string;
  /** Canonical project root used to rebuild the immutable execution scope. */
  workspacePath?: string;
  /** Optional canonical working directory inside workspacePath. */
  workingDirectory?: string;
  projectId?: string;
  checkoutId?: string;
  /** Um dos dois: agente do squad OU squad inteiro. */
  agentName?: string;
  squadId?: string;
  createdAt: number;
  updatedAt: number;
  nextFireAt?: number;
  lastFiredAt?: number;
  lastError?: string;
}

export interface CronFields {
  minute: number[];
  hour: number[];
  dom: number[] | '*';
  month: number[];
  dow: number[] | '*';
}

export const CRON_TICK_MS = 60_000;
export const CRON_STALE_MS = 5 * 60_000;

const RANGES: Record<keyof CronFields, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6],
};

function expandField(raw: string, [min, max]: [number, number]): number[] {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`step inválido em "${part}"`);
    }
    let lo = min;
    let hi = max;
    if (rangePart !== '*') {
      const [a, b] = rangePart.split('-');
      lo = Number(a);
      hi = b !== undefined ? Number(b) : lo;
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
        throw new Error(`valor não-inteiro em "${part}"`);
      }
      if (lo < min || hi > max || lo > hi) {
        throw new Error(`valor fora da faixa [${min},${max}] em "${part}"`);
      }
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

export function parseCronExpr(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron precisa de 5 campos, veio ${parts.length}: "${expr}"`);
  }
  const [min, hour, dom, month, dow] = parts;
  return {
    minute: expandField(min, RANGES.minute),
    hour: expandField(hour, RANGES.hour),
    dom: dom === '*' ? '*' : expandField(dom, RANGES.dom),
    month: expandField(month, RANGES.month),
    dow: dow === '*' ? '*' : expandField(dow, RANGES.dow),
  };
}

export function matchesCron(fields: CronFields, at: Date): boolean {
  if (!fields.minute.includes(at.getMinutes())) return false;
  if (!fields.hour.includes(at.getHours())) return false;
  if (!fields.month.includes(at.getMonth() + 1)) return false;
  // DOM/DOW: cron clássico — se AMBOS restritos, casa quando QUALQUER um bate.
  const domOk = fields.dom === '*' || fields.dom.includes(at.getDate());
  const dowOk = fields.dow === '*' || fields.dow.includes(at.getDay());
  if (fields.dom !== '*' && fields.dow !== '*') return domOk || dowOk;
  return domOk && dowOk;
}

/** Próximo minuto (a partir de `from`, exclusivo) que casa; até 1 ano à frente. */
export function nextCronAfter(fields: CronFields, from: Date): Date | null {
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i += 1) {
    if (matchesCron(fields, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

export interface FireDecision {
  fire: boolean;
  stale: boolean;
}

/**
 * Decide se o job dispara agora: precisa estar ativo, vencido (nextFireAt no
 * passado) e dentro da janela de stale — atraso além do teto vira SKIP
 * (evita catch-up em rajada após laptop fechado).
 */
export function shouldFire(
  job: CronJob,
  now: number,
  staleMs: number,
): FireDecision {
  if (job.status !== 'active' || job.nextFireAt == null) {
    return { fire: false, stale: false };
  }
  if (now < job.nextFireAt) return { fire: false, stale: false };
  if (now - job.nextFireAt > staleMs) return { fire: false, stale: true };
  return { fire: true, stale: false };
}

// ── Store (crons.json) ───────────────────────────────────────────────────────

function cronFilePath(): string {
  return path.join(os.homedir(), '.nexus', 'crons.json');
}

const cronJobSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(120),
    schedule: z.string().min(1).max(512),
    brief: z.string().max(1_048_576),
    status: z.enum(['active', 'paused']),
    executionMode: z.enum(['shared', 'local']).optional(),
    portableScheduleId: z.string().uuid().optional(),
    definitionVersion: z.number().int().positive().optional(),
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    workspacePath: z.string().min(1).max(4_096).optional(),
    workingDirectory: z.string().min(1).max(4_096).optional(),
    projectId: z.string().min(1).max(128).optional(),
    checkoutId: z.string().min(1).max(128).optional(),
    agentName: z.string().min(1).max(256).optional(),
    squadId: z.string().min(1).max(256).optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    nextFireAt: z.number().int().nonnegative().optional(),
    lastFiredAt: z.number().int().nonnegative().optional(),
    lastError: z.string().max(4_096).optional(),
  })
  .strict();

const cronJobsSchema = z.array(cronJobSchema).max(10_000);

export function parseCronJobs(raw: unknown): CronJob[] {
  return cronJobsSchema.parse(raw);
}

export function loadCronJobs(): CronJob[] {
  try {
    return parseCronJobs(JSON.parse(fs.readFileSync(cronFilePath(), 'utf8')));
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return [];
    }
    throw new Error('cron job store is invalid; refusing an empty fallback', {
      cause: error,
    });
  }
}

export function saveCronJobs(jobs: CronJob[]): void {
  const validated = parseCronJobs(jobs);
  const file = cronFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(validated, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export interface CreateCronInput {
  name: string;
  schedule: string;
  brief: string;
  executionMode?: 'shared' | 'local';
  workspacePath?: string;
  workingDirectory?: string;
  projectId?: string;
  checkoutId?: string;
  agentName?: string;
  squadId?: string;
}

/** Cria um job (valida a expressão e computa o primeiro nextFireAt). */
export function createCronJob(
  input: CreateCronInput,
  now: number,
  idFactory: () => string,
): CronJob {
  const fields = parseCronExpr(input.schedule); // lança se inválida
  const next = nextCronAfter(fields, new Date(now));
  return {
    id: idFactory(),
    name: input.name.slice(0, 120),
    schedule: input.schedule,
    brief: input.brief,
    status: 'active',
    executionMode: input.executionMode ?? 'shared',
    workspacePath: input.workspacePath,
    workingDirectory: input.workingDirectory,
    projectId: input.projectId,
    checkoutId: input.checkoutId,
    agentName: input.agentName,
    squadId: input.squadId,
    createdAt: now,
    updatedAt: now,
    nextFireAt: next?.getTime(),
  };
}
