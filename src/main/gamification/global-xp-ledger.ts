/**
 * XP global do operador. O perfil é da pessoa, não da pasta: o ledger soma o
 * poder de cada projeto já aberto nesta máquina, sem ler o banco de nenhum
 * outro projeto — cada serviço de escopo só informa o PRÓPRIO valor (absoluto,
 * idempotente). Guarda rótulo curto, poder e XP de hoje; nunca caminho,
 * conta, token ou conteúdo.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type {
  GamificationGlobalProject,
  GamificationGlobalSummary,
} from '../../shared/gamification-types';
import { writeJsonAtomic } from '../util/atomic-write';
import { nextTierAt, tierForPower } from './xp-rules';

export const GLOBAL_XP_MAX_PROJECTS = 500;
const TOP_PROJECTS = 8;
const PERSIST_DELAY_MS = 2_000;
const MAX_LABEL = 48;

const entrySchema = z.object({
  label: z.string().max(MAX_LABEL),
  power: z.number().finite().min(0),
  todayXp: z.number().finite().min(0),
  day: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
});
const fileSchema = z.object({
  version: z.literal(1),
  projects: z.record(z.string().min(1).max(64), entrySchema),
});
type Entry = z.infer<typeof entrySchema>;

export interface GlobalXpLedgerOptions {
  file: string;
  now?: () => number;
}

export function globalProjectKey(parts: {
  installationId: string;
  projectId: string;
  checkoutId: string;
}): string {
  return createHash('sha256')
    .update(`${parts.installationId}\0${parts.projectId}\0${parts.checkoutId}`)
    .digest('hex')
    .slice(0, 32);
}

export function globalProjectLabel(rootRealPath: string): string {
  const base = path.basename(rootRealPath).replace(/[\u0000-\u001f\u007f]/g, '');
  return (base || 'projeto').slice(0, MAX_LABEL);
}

function dayOf(ms: number): number {
  const d = new Date(ms);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000);
}

export class GlobalXpLedger {
  readonly #file: string;
  readonly #now: () => number;
  #projects: Map<string, Entry> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: GlobalXpLedgerOptions) {
    this.#file = options.file;
    this.#now = options.now ?? Date.now;
  }

  #load(): Map<string, Entry> {
    if (this.#projects) return this.#projects;
    const map = new Map<string, Entry>();
    try {
      const parsed = fileSchema.safeParse(JSON.parse(fs.readFileSync(this.#file, 'utf8')));
      if (parsed.success) {
        for (const [key, entry] of Object.entries(parsed.data.projects)) map.set(key, entry);
      }
    } catch {
      // Ausente ou corrompido: recomeça vazio; cada projeto reaparece ao abrir.
    }
    this.#projects = map;
    return map;
  }

  /** Informa o valor ABSOLUTO do projeto. Só agenda gravação se algo mudou. */
  record(key: string, label: string, power: number, todayXp: number): void {
    if (!key || !Number.isFinite(power) || power < 0) return;
    const projects = this.#load();
    const now = this.#now();
    const today = Math.max(0, Number.isFinite(todayXp) ? todayXp : 0);
    const day = dayOf(now);
    const safeLabel = label.slice(0, MAX_LABEL);
    const prev = projects.get(key);
    if (
      prev &&
      prev.power === power &&
      prev.todayXp === today &&
      prev.day === day &&
      prev.label === safeLabel
    ) {
      return;
    }
    projects.set(key, { label: safeLabel, power, todayXp: today, day, updatedAt: now });
    if (projects.size > GLOBAL_XP_MAX_PROJECTS) {
      const oldest = [...projects.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (oldest) projects.delete(oldest[0]);
    }
    this.#schedulePersist();
  }

  summary(currentKey?: string): GamificationGlobalSummary {
    const projects = this.#load();
    const today = dayOf(this.#now());
    let power = 0;
    let todayXp = 0;
    for (const entry of projects.values()) {
      power += entry.power;
      if (entry.day === today) todayXp += entry.todayXp;
    }
    const list: GamificationGlobalProject[] = [...projects.entries()]
      .map(([key, entry]) => ({
        label: entry.label,
        power: entry.power,
        current: key === currentKey,
      }))
      .sort((a, b) => b.power - a.power);
    return {
      powerLevel: power,
      tier: tierForPower(power),
      nextTierAt: nextTierAt(power),
      todayXp,
      projectCount: projects.size,
      projects: list.slice(0, TOP_PROJECTS),
    };
  }

  flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (!this.#projects) return;
    try {
      writeJsonAtomic(this.#file, {
        version: 1,
        projects: Object.fromEntries(this.#projects),
      });
    } catch (error) {
      console.warn('[gamification] global xp persist failed:', error);
    }
  }

  dispose(): void {
    this.flush();
  }

  #schedulePersist(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, PERSIST_DELAY_MS);
    this.#timer.unref?.();
  }
}
