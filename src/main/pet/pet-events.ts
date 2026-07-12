import type { PetEvent } from '../../shared/pet-types';

/**
 * Detecção de TRANSIÇÕES — o pet reage a mudanças, não a estados. Funções
 * puras (sem Electron) para o diff de missões por escopo e o diff de estado
 * de sessão de agente; a fiação com taps/broadcast fica em pet-window.ts.
 */

interface MissionLike {
  id: string;
  title: string;
  status: string;
}

export class MissionTransitionTracker {
  /** status anterior por `scope missionId`. */
  private last = new Map<string, string>();

  /**
   * Recebe a lista corrente de missões de um escopo e devolve os eventos de
   * transição relevantes (→done, →failed). A primeira leva de um escopo só
   * semeia o estado — o pet não comemora missão que já estava concluída.
   */
  ingest(scope: string, missions: readonly MissionLike[], at: number): PetEvent[] {
    const events: PetEvent[] = [];
    const prefix = `${scope} `;
    const seenScope = [...this.last.keys()].some((key) => key.startsWith(prefix));
    const liveKeys = new Set<string>();
    for (const mission of missions) {
      const key = `${prefix}${mission.id}`;
      liveKeys.add(key);
      const before = this.last.get(key);
      this.last.set(key, mission.status);
      if (!seenScope || before === mission.status || before === undefined) {
        continue;
      }
      if (mission.status === 'done') {
        events.push({ kind: 'mission-done', title: mission.title, at });
      } else if (mission.status === 'failed') {
        events.push({ kind: 'mission-failed', title: mission.title, at });
      } else if (mission.status === 'blocked') {
        // O aviso que mais importa: a missão parou esperando um humano.
        events.push({ kind: 'mission-blocked', title: mission.title, at });
      }
    }
    // Poda: missões removidas do escopo saem do mapa — o tracker fica
    // limitado ao nº de missões vivas, não ao histórico do processo.
    for (const key of this.last.keys()) {
      if (key.startsWith(prefix) && !liveKeys.has(key)) this.last.delete(key);
    }
    return events;
  }

  /** Semeia o escopo com a lista corrente SEM emitir eventos (hidratação). */
  seed(scope: string, missions: readonly MissionLike[]): void {
    for (const mission of missions) {
      this.last.set(`${scope} ${mission.id}`, mission.status);
    }
  }
}

/**
 * Atenção por AGENTE via hooks explícitos (working/blocked/waiting/done):
 * entrar em waiting/blocked = "um agente precisa de você". Diferente do
 * tracker de missões, a primeira observação já conta — hooks só disparam em
 * eventos reais, nunca em replay.
 */
export class AgentAttentionTracker {
  private last = new Map<string, string>();

  ingest(sessionId: string, state: string, at: number): PetEvent | null {
    const before = this.last.get(sessionId);
    this.last.set(sessionId, state);
    if (before === state) return null;
    if (state === 'waiting' || state === 'blocked') {
      return { kind: 'agent-waiting', title: sessionId, at };
    }
    return null;
  }

  forget(sessionId: string): void {
    this.last.delete(sessionId);
  }
}

export class AgentTransitionTracker {
  private last = new Map<string, string>();

  /**
   * `busy → exited` = agente morreu trabalhando (o evento mais crítico);
   * `idle/spawning → exited` também avisa. `busy → idle` vira um evento
   * leve (o pet celebra sem balão). Estados repetidos não gera nada.
   */
  ingest(sessionId: string, state: string, at: number): PetEvent | null {
    const before = this.last.get(sessionId);
    this.last.set(sessionId, state);
    if (before === state) return null;
    if (state === 'exited' && before !== undefined) {
      return { kind: 'agent-exited', title: sessionId, at };
    }
    if (state === 'idle' && before === 'busy') {
      return { kind: 'agent-idle', title: sessionId, at };
    }
    return null;
  }

  forget(sessionId: string): void {
    this.last.delete(sessionId);
  }
}
