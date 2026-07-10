import { randomUUID } from 'node:crypto';
import {
  CRON_STALE_MS,
  CRON_TICK_MS,
  loadCronJobs,
  nextCronAfter,
  parseCronExpr,
  saveCronJobs,
  shouldFire,
  type CronJob,
} from './cron-loop';
import { getSquad, findAgent } from './squad-store';
import { spawnPaneAndMaybePrompt } from './tool-util';
import { createMission } from './mission-store';
import { resolveWorkspaceCwd } from './workspace-path';

/**
 * Runtime do cron: tick de 60s no main. Jobs vencidos disparam o brief num
 * pane novo (agente do squad ou orquestrador do squad), skip-if-stale, e
 * reavançam nextFireAt. IO/spawn injetáveis → testável; a instância default
 * usa os stores reais.
 */

export interface CronRuntimeDeps {
  load(): CronJob[];
  save(jobs: CronJob[]): void;
  fire(job: CronJob): Promise<void>;
  now(): number;
}

/** Dispara um job: cria missão + spawna o alvo com o brief. */
export async function fireCronJob(job: CronJob): Promise<void> {
  // Revalida também jobs legados ou alterados no disco. Sem workspace aberto,
  // ou se o caminho escapar do workspace ativo, falha antes de criar missão.
  const workspacePath = resolveWorkspaceCwd(job.workspacePath);
  const mission = createMission({
    title: `⏰ ${job.name}`,
    description: job.brief,
  });
  if (job.squadId) {
    const squad = getSquad(job.squadId);
    if (!squad) throw new Error(`squad ${job.squadId} não existe`);
    const orch =
      squad.agents.find((a) => a.category === 'orchestrator') ?? squad.agents[0];
    if (!orch) throw new Error(`squad ${job.squadId} sem agentes`);
    await spawnPaneAndMaybePrompt({
      adapterId: orch.cli,
      model: orch.model,
      cwd: workspacePath,
      title: `${squad.name} (cron)`,
      missionId: mission.id,
      agentName: orch.agentName,
      allowedTools: orch.allowedTools ?? null,
      allowedSkills: orch.allowedSkills ?? null,
      role: 'orchestrator',
      prompt: `${squad.orchestratorInstructions ?? ''}\n\nMISSÃO AGENDADA: ${job.brief}`,
    });
    return;
  }
  if (job.agentName) {
    const found = findAgent(job.agentName);
    if (!found) throw new Error(`agente ${job.agentName} não encontrado`);
    const { agent } = found;
    await spawnPaneAndMaybePrompt({
      adapterId: agent.cli,
      model: agent.model,
      cwd: workspacePath,
      title: `${agent.agentName} (cron)`,
      missionId: mission.id,
      agentName: agent.agentName,
      allowedTools: agent.allowedTools ?? null,
      allowedSkills: agent.allowedSkills ?? null,
      role: agent.category === 'orchestrator' ? 'orchestrator' : 'worker',
      prompt: job.brief,
    });
    return;
  }
  throw new Error('job sem agentName nem squadId');
}

export const defaultCronDeps: CronRuntimeDeps = {
  load: loadCronJobs,
  save: saveCronJobs,
  fire: fireCronJob,
  now: Date.now,
};

/**
 * Processa um tick: dispara os jobs vencidos, marca stale-skips, e reavança
 * nextFireAt de todos. Puro em relação ao tempo (recebe `now`/deps). Retorna
 * quantos dispararam.
 */
export async function runCronTick(deps: CronRuntimeDeps): Promise<number> {
  const jobs = deps.load();
  const now = deps.now();
  let fired = 0;
  let changed = false;

  for (const job of jobs) {
    if (job.status !== 'active') continue;
    let fields;
    try {
      fields = parseCronExpr(job.schedule);
    } catch (err) {
      job.lastError = err instanceof Error ? err.message : String(err);
      changed = true;
      continue;
    }
    const decision = shouldFire(job, now, CRON_STALE_MS);
    if (decision.fire) {
      try {
        await deps.fire(job);
        job.lastFiredAt = now;
        job.lastError = undefined;
        fired += 1;
      } catch (err) {
        job.lastError = err instanceof Error ? err.message : String(err);
      }
      changed = true;
    } else if (decision.stale) {
      console.warn(`[cron] job "${job.name}" pulado (atraso > stale)`);
      changed = true;
    }
    // Reavança para o próximo horário futuro (mesmo após skip/fire).
    if (job.nextFireAt != null && now >= job.nextFireAt) {
      const next = nextCronAfter(fields, new Date(now));
      job.nextFireAt = next?.getTime();
      job.updatedAt = now;
      changed = true;
    }
  }

  if (changed) deps.save(jobs);
  return fired;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Inicia o loop de tick (idempotente). */
export function startCronLoop(deps: CronRuntimeDeps = defaultCronDeps): void {
  if (timer) return;
  timer = setInterval(() => {
    void runCronTick(deps).catch((err) =>
      console.warn('[cron] tick falhou:', err),
    );
  }, CRON_TICK_MS);
  timer.unref?.();
}

export function stopCronLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ── CRUD helpers para as MCP tools / IPC ─────────────────────────────────────

export function listCronJobs(): CronJob[] {
  return loadCronJobs();
}

export function addCronJob(input: {
  name: string;
  schedule: string;
  brief: string;
  workspacePath?: string;
  agentName?: string;
  squadId?: string;
}): CronJob {
  const fields = parseCronExpr(input.schedule); // valida
  // O job fica preso ao workspace ativo canônico. Nunca deixe o PTY cair para
  // HOME quando o chamador omite ou fornece um caminho inválido.
  const workspacePath = resolveWorkspaceCwd(input.workspacePath);
  const now = Date.now();
  const job: CronJob = {
    id: `cron-${randomUUID().slice(0, 8)}`,
    name: input.name.slice(0, 120),
    schedule: input.schedule,
    brief: input.brief,
    status: 'active',
    workspacePath,
    agentName: input.agentName,
    squadId: input.squadId,
    createdAt: now,
    updatedAt: now,
    nextFireAt: nextCronAfter(fields, new Date(now))?.getTime(),
  };
  const jobs = loadCronJobs();
  jobs.push(job);
  saveCronJobs(jobs);
  return job;
}

export function deleteCronJob(id: string): boolean {
  const jobs = loadCronJobs();
  const next = jobs.filter((j) => j.id !== id);
  if (next.length === jobs.length) return false;
  saveCronJobs(next);
  return true;
}
