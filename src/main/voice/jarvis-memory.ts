import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Memória persistente da JARVIS — fatos duráveis entre sessões, para a
 * conversa não recomeçar do zero a cada boot (hoje o histórico vive 4 min no
 * renderer e morre com a janela).
 *
 * Modelo: 1 fato = 1 key (slug estável). Regravar a mesma key SUPERSEDE o
 * conteúdo anterior (vai para o histórico do fato, sem duplicar). `forget` é
 * SOFT-DELETE — o fato some do prompt mas a cadeia sobrevive, e redizer o
 * fato o ressuscita. Arquivo JSON em ~/.nexus/jarvis-memory.json (sem
 * segredos — são preferências e fatos ditos em voz alta pelo usuário).
 */

export interface JarvisFact {
  content: string;
  updatedAt: number;
  deleted?: boolean;
  history: Array<{ content: string; at: number }>;
}

interface MemoryState {
  facts: Record<string, JarvisFact>;
}

const HISTORY_CAP = 10;
const MAX_FACTS = 200;
export const FACTS_BLOCK_MAX_CHARS = 700;

/** Slug estável de key: minúsculas, sem acento, alfanumérico com hífens. */
export function slugifyMemoryKey(key: string): string {
  return key
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export class JarvisMemory {
  private state: MemoryState | null = null;

  constructor(
    private filePath: string = path.join(os.homedir(), '.nexus', 'jarvis-memory.json'),
    private nowFn: () => number = Date.now,
  ) {}

  /** Grava/atualiza um fato. Mesmo conteúdo ativo = no-op. */
  remember(key: string, content: string): void {
    const fact = content.trim();
    if (!fact) return;
    let slug = slugifyMemoryKey(key);
    if (!slug) slug = slugifyMemoryKey(fact).slice(0, 32);
    if (!slug) return;

    const state = this.load();
    const existing = state.facts[slug];
    if (existing && !existing.deleted && existing.content === fact) return;

    if (existing) {
      existing.history.push({ content: existing.content, at: existing.updatedAt });
      if (existing.history.length > HISTORY_CAP) {
        existing.history = existing.history.slice(-HISTORY_CAP);
      }
      existing.content = fact;
      existing.updatedAt = this.nowFn();
      delete existing.deleted;
    } else {
      state.facts[slug] = { content: fact, updatedAt: this.nowFn(), history: [] };
      this.evictIfNeeded(state);
    }
    this.save(state);
  }

  /** Soft-delete: o fato sai do prompt mas a cadeia fica para auditoria. */
  forget(key: string): boolean {
    const slug = slugifyMemoryKey(key);
    const state = this.load();
    const fact = state.facts[slug];
    if (!fact || fact.deleted) return false;
    fact.deleted = true;
    fact.updatedAt = this.nowFn();
    this.save(state);
    return true;
  }

  /** Fatos ativos, mais recentes primeiro. */
  list(): Array<{ key: string; content: string; updatedAt: number }> {
    const state = this.load();
    return Object.entries(state.facts)
      .filter(([, f]) => !f.deleted)
      .map(([key, f]) => ({ key, content: f.content, updatedAt: f.updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Bloco de fatos para injetar no system prompt do cérebro, com cap de chars
   * (fatos mais recentes têm prioridade). Vazio quando não há nada lembrado.
   */
  factsBlock(maxChars: number = FACTS_BLOCK_MAX_CHARS): string {
    const lines: string[] = [];
    let used = 0;
    for (const fact of this.list()) {
      const line = `- ${fact.key}: ${fact.content}`;
      if (used + line.length + 1 > maxChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    return lines.join('\n');
  }

  // ── persistência ────────────────────────────────────────────────────────────

  private load(): MemoryState {
    if (this.state) return this.state;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<MemoryState>;
      this.state =
        parsed && typeof parsed.facts === 'object' && parsed.facts !== null
          ? { facts: parsed.facts as Record<string, JarvisFact> }
          : { facts: {} };
    } catch {
      this.state = { facts: {} };
    }
    return this.state;
  }

  private save(state: MemoryState): void {
    this.state = state;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Best-effort: memória é conveniência, nunca pode derrubar o turno de voz.
    }
  }

  private evictIfNeeded(state: MemoryState): void {
    const keys = Object.keys(state.facts);
    if (keys.length <= MAX_FACTS) return;
    // Derruba primeiro os deletados mais antigos, depois os ativos mais antigos.
    const byAge = keys.sort((a, b) => {
      const fa = state.facts[a];
      const fb = state.facts[b];
      if (!!fa.deleted !== !!fb.deleted) return fa.deleted ? -1 : 1;
      return fa.updatedAt - fb.updatedAt;
    });
    for (const key of byAge.slice(0, keys.length - MAX_FACTS)) {
      delete state.facts[key];
    }
  }
}

/** Singleton do processo main. */
export const jarvisMemory = new JarvisMemory();
