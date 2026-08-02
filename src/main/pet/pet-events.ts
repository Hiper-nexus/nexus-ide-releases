import type { PetEvent, PetEventCause } from '../../shared/pet-types';
import type { MissionIntentContract } from '../../shared/mission-intent';
import { hasAutomaticTechnicalRecovery } from '../../shared/mission-recovery-policy';
import { missionBlockCause } from '../../shared/mission-block-cause';

/**
 * Detecção de TRANSIÇÕES — o pet reage a mudanças, não a estados. Funções
 * puras (sem Electron) para o diff de missões por escopo e o diff de estado
 * de sessão de agente; a fiação com taps/broadcast fica em pet-window.ts.
 */

interface MissionLike {
  id: string;
  title: string;
  description?: string;
  status: string;
  intentState?: string;
  intentVersion?: number | null;
  intentContract?: MissionIntentContract | null;
}

function missionAttentionState(mission: MissionLike): string {
  if (mission.status === 'blocked') {
    const hasAutomaticRecovery = hasAutomaticTechnicalRecovery({
      ...mission,
      description: mission.description ?? '',
    });
    if (mission.intentState === 'blocked_technical') {
      return hasAutomaticRecovery
        ? 'blocked:technical:recovering'
        : 'blocked:technical:exhausted';
    }
    return hasAutomaticRecovery ? 'blocked:technical:recovering' : 'blocked:user';
  }
  return mission.status;
}

/**
 * A razão do bloqueio já está gravada na descrição da missão (espelho do
 * `task_dispatch_queue.last_error`). Aqui ela só é NOMEADA e embarcada no
 * evento: a janela do pet não acessa lojas, então sem isto o motivo morria no
 * main e o operador via apenas "Bloqueado".
 */
function causeFor(mission: MissionLike): PetEventCause {
  const cause = missionBlockCause({
    status: mission.status,
    intentState: mission.intentState ?? null,
    description: mission.description ?? '',
  });
  return {
    code: cause.code,
    headline: cause.headline,
    action: cause.action,
  };
}

export class MissionTransitionTracker {
  /** status + intenção anterior por `scope missionId`. */
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
      const current = missionAttentionState(mission);
      this.last.set(key, current);
      if (!seenScope || before === current || before === undefined) {
        continue;
      }
      if (mission.status === 'done') {
        events.push({
          kind: 'mission-done',
          title: mission.title,
          at,
          missionId: mission.id,
        });
      } else if (mission.status === 'failed') {
        events.push({
          kind: 'mission-failed',
          title: mission.title,
          at,
          missionId: mission.id,
        });
      } else if (mission.status === 'blocked') {
        const hasAutomaticRecovery = hasAutomaticTechnicalRecovery({
          ...mission,
          description: mission.description ?? '',
        });
        if (mission.intentState === 'blocked_technical') {
          if (!hasAutomaticRecovery) {
            events.push({
              kind: 'mission-technical-failure',
              title: mission.title,
              at,
              missionId: mission.id,
              cause: causeFor(mission),
            });
          }
          continue;
        }
        if (hasAutomaticRecovery) continue;
        // O aviso que mais importa: a missão parou e alguém precisa agir. O
        // título fica sendo o da missão; o PORQUÊ viaja em `cause` para o
        // balão/toast poderem dizer o que aconteceu e o que fazer.
        const handoffDeliveryFailed = mission.description?.includes(
          '<!-- nexus:handoff-delivery-failed:',
        );
        events.push({
          kind: 'mission-blocked',
          title: handoffDeliveryFailed
            ? `Handoff não entregue — ${mission.title}`
            : mission.title,
          at,
          missionId: mission.id,
          cause: causeFor(mission),
        });
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
      this.last.set(`${scope} ${mission.id}`, missionAttentionState(mission));
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
