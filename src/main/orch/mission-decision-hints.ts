/**
 * F-1166: dicas consultivas do motor de decisão por missão (kickoff, triagem
 * de revisão, recuperação, conclusão). Ficam FORA da linha da missão no
 * SQLite: nenhuma migração, e missão antiga simplesmente não tem dica.
 * Memória do processo + um JSON por missão em userData, gravado de forma
 * assíncrona. A chave é o missionId, conferido na leitura: a dica de uma
 * missão nunca aparece em outra. Nada aqui lança.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type {
  Mission, MissionCompletionHint, MissionDecisionHints, MissionKickoffHint, MissionRecoveryHint, MissionReviewTriageHint,
} from '../../shared/orch-types';

const MAX_REVIEW_TRIAGE = 30;
const MAX_RECOVERY = 20;
const MAX_FILE_BYTES = 256 * 1024;
const FILE_VERSION = 1;

const receiptShape = {
  at: z.number().finite(),
  model: z.string().min(1).max(200),
  route: z.looseObject({ provider: z.enum(['jev', 'clef', 'luna']), model: z.string(), policyVersion: z.string(),
    evidence: z.string(), reason: z.string() }).optional(),
  usd: z.number().finite().nullable(),
  budgetChargedUsd: z.number().finite().min(0).optional(),
  probabilities: z.record(z.string(), z.number().finite()),
};
const hintsSchema = z.object({
  kickoff: z.object({ ...receiptShape, origin: z.enum(['conventional', 'pane']), complexity: z.number().finite(),
    complexityLevel: z.enum(['trivial', 'small', 'medium', 'large']), workers: z.number().int().min(0),
    maxWorkers: z.number().int().min(0), lane: z.enum(['standard', 'consult', 'plan', 'ops']), laneConfidence: z.number().finite() }).optional(),
  reviewTriage: z.array(z.object({ ...receiptShape, handoffId: z.string().min(1), regressionRisk: z.number().finite(),
    recommendIndependentReview: z.boolean() })).max(MAX_REVIEW_TRIAGE).optional(),
  recovery: z.array(z.object({ ...receiptShape,
    triggerClass: z.enum(['rate-limit', 'quota', 'auth', 'transient', 'model-rejected', 'unknown']), paneId: z.string().optional(),
    adapterId: z.string().optional(), advice: z.enum(['retry-same-cli', 'switch-cli', 'escalate-orchestrator']),
    confidence: z.number().finite() })).max(MAX_RECOVERY).optional(),
  completion: z.object({ ...receiptShape, coverage: z.number().finite(), warning: z.boolean(),
    handoffCount: z.number().int().min(0), signature: z.string().max(128), consultations: z.number().int().min(0),
    missing: z.string().max(400).optional(),
    finalAudit: z.object({ at: z.number().finite(), reused: z.boolean() }).optional() }).optional(),
  finalizedAt: z.number().finite().optional(),
});
const fileSchema = z.object({ version: z.literal(FILE_VERSION), missionId: z.string().min(1), hints: hintsSchema });

/** `null` = já sabemos que não há dica (sem reler o disco a cada mission_get/whoami). */
const memory = new Map<string, MissionDecisionHints | null>();
const MAX_MEMORY_MISSIONS = 300;
/** Missão concluída há mais que isto: o JSON sai no boot (a auditoria final já teve tempo de ser lida). */
export const FINALIZED_HINTS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Arquivo sem gravação há mais que isto (missão removida/abandonada): sai no boot. */
export const ORPHAN_HINTS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const writes = new Map<string, Promise<void>>();
let injectedDir: string | undefined;

/** Para testes: fixa o diretório; `undefined` volta ao userData. */
export function configureMissionDecisionHints(dir?: string): void {
  injectedDir = dir;
  memory.clear();
  writes.clear();
}

function hintsDir(): string | null {
  if (injectedDir) return injectedDir;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- fora do Electron (vitest) `app` não existe
    const electron = require('electron') as { app?: { getPath(name: 'userData'): string } };
    if (typeof electron?.app?.getPath !== 'function') return null;
    return path.join(electron.app.getPath('userData'), 'decision-models', 'mission-hints');
  } catch {
    return null;
  }
}

function fileFor(dir: string, missionId: string): string {
  return path.join(dir, `${createHash('sha256').update(missionId).digest('hex').slice(0, 40)}.json`);
}

function load(missionId: string): MissionDecisionHints | undefined {
  const dir = hintsDir();
  if (!dir) return undefined;
  try {
    const file = fileFor(dir, missionId);
    if (fs.statSync(file).size > MAX_FILE_BYTES) return undefined;
    const parsed = fileSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    // Colisão de hash ou arquivo trocado: a dica de outra missão nunca vaza.
    if (!parsed.success || parsed.data.missionId !== missionId) return undefined;
    return parsed.data.hints as MissionDecisionHints;
  } catch {
    return undefined;
  }
}

function persist(missionId: string, hints: MissionDecisionHints): Promise<void> {
  const dir = hintsDir();
  if (!dir) return Promise.resolve();
  const previous = writes.get(missionId) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const file = fileFor(dir, missionId);
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify({ version: FILE_VERSION, missionId, hints }));
      await fs.promises.rename(tmp, file);
    } catch (error) {
      console.warn(`[mission-hints] write failed (${error instanceof Error ? error.name : 'unknown'})`);
    }
  });
  writes.set(missionId, next);
  return next;
}

/** Espera as gravações pendentes (testes e desligamento). */
export async function flushMissionDecisionHints(): Promise<void> {
  await Promise.all([...writes.values()]);
}

function remember(missionId: string, hints: MissionDecisionHints | null): void {
  memory.delete(missionId);
  memory.set(missionId, hints);
  if (memory.size > MAX_MEMORY_MISSIONS) memory.delete(memory.keys().next().value!);
}

export function getMissionDecisionHints(missionId: string): MissionDecisionHints | undefined {
  if (memory.has(missionId)) return memory.get(missionId) ?? undefined;
  const loaded = load(missionId);
  remember(missionId, loaded ?? null);
  return loaded;
}

/** Esquece a missão (memória e arquivo). Nunca lança. */
export async function forgetMissionDecisionHints(missionId: string): Promise<void> {
  memory.delete(missionId);
  const dir = hintsDir();
  if (!dir) return;
  await (writes.get(missionId) ?? Promise.resolve());
  writes.delete(missionId);
  try { await fs.promises.rm(fileFor(dir, missionId), { force: true }); } catch { /* fica para o próximo boot */ }
}

/**
 * Boot: apaga o JSON de missões concluídas há mais de 7 dias (a auditoria
 * final já foi lida) e de arquivos sem gravação há mais de 30 dias (missão
 * removida). Assíncrono, fora do caminho quente; nunca lança.
 */
export async function sweepMissionDecisionHints(now = Date.now()): Promise<number> {
  const dir = hintsDir();
  if (!dir) return 0;
  let removed = 0;
  let names: string[] = [];
  try { names = await fs.promises.readdir(dir); } catch { return 0; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const stat = await fs.promises.stat(file);
      let drop = now - stat.mtimeMs > ORPHAN_HINTS_RETENTION_MS || stat.size > MAX_FILE_BYTES;
      let missionId: string | undefined;
      if (!drop) {
        const parsed = fileSchema.safeParse(JSON.parse(await fs.promises.readFile(file, 'utf8')));
        if (!parsed.success) drop = true;
        else {
          missionId = parsed.data.missionId;
          const finalizedAt = parsed.data.hints.finalizedAt;
          drop = finalizedAt !== undefined && now - finalizedAt > FINALIZED_HINTS_RETENTION_MS;
        }
      }
      if (!drop) continue;
      await fs.promises.rm(file, { force: true });
      if (missionId) memory.delete(missionId);
      removed += 1;
    } catch { /* arquivo some ou está ilegível: segue */ }
  }
  return removed;
}

export function startMissionDecisionHintsSweep(delayMs = 5_000): () => void {
  const timer = setTimeout(() => { void sweepMissionDecisionHints().catch(() => 0); }, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

function update(missionId: string, change: (current: MissionDecisionHints) => MissionDecisionHints): void {
  try {
    const next = change(getMissionDecisionHints(missionId) ?? {});
    remember(missionId, next);
    void persist(missionId, next);
  } catch (error) {
    console.warn(`[mission-hints] update failed (${error instanceof Error ? error.name : 'unknown'})`);
  }
}

export function recordKickoffHint(missionId: string, hint: MissionKickoffHint): void {
  update(missionId, current => ({ ...current, kickoff: hint }));
}

export function recordReviewTriageHint(missionId: string, hint: MissionReviewTriageHint): void {
  update(missionId, current => ({ ...current, reviewTriage: [
    ...(current.reviewTriage ?? []).filter(row => row.handoffId !== hint.handoffId), hint,
  ].slice(-MAX_REVIEW_TRIAGE) }));
}

export function recordRecoveryHint(missionId: string, hint: MissionRecoveryHint): void {
  update(missionId, current => ({ ...current, recovery: [...(current.recovery ?? []), hint].slice(-MAX_RECOVERY) }));
}

export function recordCompletionHint(missionId: string, hint: MissionCompletionHint): void {
  update(missionId, current => ({ ...current, completion: hint }));
}

/** Auditoria final na conclusão: marca o reaproveitamento e o horário (base da limpeza). */
export function recordMissionFinalized(missionId: string, at: number, reused: boolean | null): void {
  update(missionId, current => ({ ...current, finalizedAt: at,
    ...(current.completion && reused !== null ? { completion: { ...current.completion, finalAudit: { at, reused } } } : {}) }));
}

export function reviewTriageHintFor(missionId: string, handoffId: string): MissionReviewTriageHint | undefined {
  return getMissionDecisionHints(missionId)?.reviewTriage?.find(row => row.handoffId === handoffId);
}

/** Leitura: a missão sai com as dicas dela (ou sem o campo). Nunca falha a leitura. */
export function withMissionDecisionHints<T extends Pick<Mission, 'id'>>(mission: T): T & { decisionHints?: MissionDecisionHints } {
  try {
    const hints = getMissionDecisionHints(mission.id);
    return hints ? { ...mission, decisionHints: hints } : mission;
  } catch {
    return mission;
  }
}
