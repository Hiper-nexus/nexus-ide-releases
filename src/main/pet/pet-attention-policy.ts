/**
 * Anti-spam do companion: com dezenas de panes, o pet NÃO deve buzinar a cada
 * tick. Só reage a transições (já filtradas pelos trackers) e ainda aplica:
 *  - cooldown por item (mesma missão/agente não repete em X s)
 *  - janela de digest (vários urgentes em 2s → um único aviso agregado)
 *  - teto de toasts de atenção na janela principal
 *
 * Puro e testável — sem Electron.
 */

import type { PetEvent, PetEventKind } from '../../shared/pet-types';
import { isPetUrgentEvent } from '../../shared/pet-types';

export const ITEM_COOLDOWN_MS = 90_000;
export const DIGEST_WINDOW_MS = 2_000;
/** Toasts de intervenção: no máximo 1 a cada este intervalo. */
export const ATTENTION_TOAST_COOLDOWN_MS = 25_000;
/** Done/exited em massa: no máximo N por minuto por kind. */
export const NOISE_KIND_LIMIT = 3;
export const NOISE_KIND_WINDOW_MS = 60_000;

export interface AttentionDecision {
  /** Entregar ao pet (balão/fila). */
  deliverPet: boolean;
  /** Espelhar na janela principal (toast). */
  mirrorMain: boolean;
  /** Evento efetivo (pode ser digest agregado). */
  event: PetEvent;
}

export interface AttentionPolicyState {
  /** kind:title → last emit ms */
  lastByKey: Map<string, number>;
  /** kind → timestamps recentes (para teto de ruído) */
  noiseByKind: Map<string, number[]>;
  lastAttentionToastAt: number;
  /** Buffer de urgentes na janela de digest. */
  digestBuffer: PetEvent[];
  digestDeadline: number | null;
}

export function createAttentionPolicyState(): AttentionPolicyState {
  return {
    lastByKey: new Map(),
    noiseByKind: new Map(),
    lastAttentionToastAt: 0,
    digestBuffer: [],
    digestDeadline: null,
  };
}

function itemKey(event: PetEvent): string {
  return `${event.kind}:${event.title}`;
}

function pruneNoise(timestamps: number[], now: number): number[] {
  return timestamps.filter((t) => now - t < NOISE_KIND_WINDOW_MS);
}

/**
 * Decide se o evento sai agora, entra no digest, ou é engolido.
 * `flushDigest` = true quando o timer da janela de digest dispara.
 */
export function admitPetEvent(
  state: AttentionPolicyState,
  event: PetEvent,
  now: number,
  opts?: { flushDigest?: boolean },
): {
  state: AttentionPolicyState;
  immediate: AttentionDecision | null;
  /** Se true, o caller deve agendar flush em DIGEST_WINDOW_MS (se ainda não). */
  scheduleDigest: boolean;
  /** Decisões liberadas pelo flush do digest (uma humana e/ou uma técnica). */
  flushed: AttentionDecision[];
} {
  const next: AttentionPolicyState = {
    lastByKey: new Map(state.lastByKey),
    noiseByKind: new Map(
      [...state.noiseByKind.entries()].map(([k, v]) => [k, [...v]]),
    ),
    lastAttentionToastAt: state.lastAttentionToastAt,
    digestBuffer: [...state.digestBuffer],
    digestDeadline: state.digestDeadline,
  };

  const lateFlush: AttentionDecision[] = [];
  // Timer de digest atrasado (teste ou event loop) — fecha a janela antiga.
  if (
    !opts?.flushDigest &&
    next.digestDeadline !== null &&
    now >= next.digestDeadline
  ) {
    lateFlush.push(...flushDigestBuffer(next, now));
  }

  if (opts?.flushDigest) {
    const flushed = flushDigestBuffer(next, now);
    return {
      state: next,
      immediate: null,
      scheduleDigest: false,
      flushed: [...lateFlush, ...flushed],
    };
  }

  // agent-idle nunca vira balão/toast — trackers já podem emitir; engole aqui.
  if (event.kind === 'agent-idle') {
    return {
      state: next,
      immediate: null,
      scheduleDigest: false,
      flushed: lateFlush,
    };
  }

  const key = itemKey(event);
  const last = next.lastByKey.get(key);
  if (last !== undefined && now - last < ITEM_COOLDOWN_MS) {
    return {
      state: next,
      immediate: null,
      scheduleDigest: false,
      flushed: lateFlush,
    };
  }

  if (isPetUrgentEvent(event.kind)) {
    next.digestBuffer.push(event);
    next.lastByKey.set(key, now);
    if (next.digestDeadline === null) {
      next.digestDeadline = now + DIGEST_WINDOW_MS;
      return {
        state: next,
        immediate: null,
        scheduleDigest: true,
        flushed: lateFlush,
      };
    }
    // Já há janela aberta — só acumula; flush virá do timer.
    return {
      state: next,
      immediate: null,
      scheduleDigest: false,
      flushed: lateFlush,
    };
  }

  // Ruído de done/exited em frota grande.
  if (event.kind === 'agent-exited' || event.kind === 'mission-done') {
    const recent = pruneNoise(next.noiseByKind.get(event.kind) ?? [], now);
    if (recent.length >= NOISE_KIND_LIMIT) {
      return { state: next, immediate: null, scheduleDigest: false, flushed: [] };
    }
    recent.push(now);
    next.noiseByKind.set(event.kind, recent);
  }

  next.lastByKey.set(key, now);
  const decision = toDecision(next, event, now, /* forceNoMain */ false);
  return {
    state: next,
    immediate: decision,
    scheduleDigest: false,
    flushed: lateFlush,
  };
}

function flushDigestBuffer(
  state: AttentionPolicyState,
  now: number,
): AttentionDecision[] {
  const buffer = state.digestBuffer.splice(0, state.digestBuffer.length);
  state.digestDeadline = null;
  if (buffer.length === 0) return [];

  if (buffer.length === 1) {
    return [toDecision(state, buffer[0]!, now, false)];
  }

  const technical = buffer.filter(
    (e) => e.kind === 'mission-technical-failure',
  );
  const blocked = buffer.filter((e) => e.kind === 'mission-blocked');
  const waiting = buffer.filter((e) => e.kind === 'agent-waiting');
  const decisions: AttentionDecision[] = [];
  const humanParts: string[] = [];
  if (blocked.length > 0) {
    humanParts.push(
      blocked.length === 1
        ? blocked[0]!.title
        : `${blocked.length} missões travadas`,
    );
  }
  if (waiting.length > 0) {
    humanParts.push(
      waiting.length === 1
        ? waiting[0]!.title
        : `${waiting.length} agentes pedem input`,
    );
  }
  if (humanParts.length > 0) {
    // Digest de UMA missão bloqueada continua sendo aquela missão: manter
    // missionId + cause é o que deixa o toast abrir o diagnóstico certo e
    // dizer o porquê. Agregado de várias não tem causa única — e não inventa.
    const soleBlocked =
      blocked.length === 1 && waiting.length === 0 ? blocked[0]! : null;
    decisions.push(
      toDecision(
        state,
        {
          kind:
            blocked.length >= waiting.length
              ? 'mission-blocked'
              : 'agent-waiting',
          title: humanParts.join(' · '),
          at: now,
          ...(soleBlocked?.missionId
            ? { missionId: soleBlocked.missionId }
            : {}),
          ...(soleBlocked?.cause ? { cause: soleBlocked.cause } : {}),
        },
        now,
        false,
      ),
    );
  }
  if (technical.length > 0) {
    decisions.push(
      toDecision(
        state,
        {
          kind: 'mission-technical-failure',
          title:
            technical.length === 1
              ? technical[0]!.title
              : `${technical.length} missões com falha técnica`,
          at: now,
          ...(technical.length === 1 && technical[0]!.missionId
            ? { missionId: technical[0]!.missionId }
            : {}),
          ...(technical.length === 1 && technical[0]!.cause
            ? { cause: technical[0]!.cause }
            : {}),
        },
        now,
        false,
      ),
    );
  }
  return decisions;
}

function toDecision(
  state: AttentionPolicyState,
  event: PetEvent,
  now: number,
  _unused: boolean,
): AttentionDecision {
  const urgent = isPetUrgentEvent(event.kind);
  // A conclusao precisa ser observavel mesmo se o companion estiver
  // desativado: o pet recebe o balao quando ligado e a janela principal
  // recebe o toast de sucesso como fallback. O teto de ruido acima continua
  // impedindo uma frota de inundar a UI.
  let mirrorMain = urgent || event.kind === 'mission-done';
  if (urgent) {
    if (now - state.lastAttentionToastAt < ATTENTION_TOAST_COOLDOWN_MS) {
      mirrorMain = false;
    } else {
      state.lastAttentionToastAt = now;
    }
  }
  return { deliverPet: true, mirrorMain, event };
}

/** Helpers exportados para testes / introspecção. */
export function isNoiseKind(kind: PetEventKind): boolean {
  return kind === 'agent-exited' || kind === 'mission-done';
}
