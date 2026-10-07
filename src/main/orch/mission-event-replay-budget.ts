// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: tetos e decisão de ThreadStream.ts
// aplicados ao replay por cursor do journal de eventos de missão (sequência por missão em vez
// de thread); o snapshot é a cauda limitada do próprio journal, não uma projeção de thread.

/**
 * ORC-10 — teto do replay do journal de eventos de missão para consumidores
 * fora do Main (IPC do renderer). Um reconnect com cursor velho não puxa
 * histórico ilimitado: acima do teto de eventos ou de bytes, o consumidor
 * recebe um snapshot (os eventos mais recentes, também limitados) e o cursor
 * de onde continuar. Abaixo do teto o replay é o de sempre.
 *
 * Leituras internas do Main (ex.: varredura de degradação persistida) seguem
 * no `replay` sem teto — elas paginam de propósito.
 */

/** Máximo de eventos reaplicados num replay por cursor. */
export const MISSION_REPLAY_MAX_EVENTS = 128;

/** Máximo de JSON codificado dos eventos de um replay. */
export const MISSION_REPLAY_MAX_ENCODED_BYTES = 1_048_576;

/**
 * Máximo agregado de payload persistido lido antes de decodificar. Objetos
 * decodificados custam mais que o JSON guardado: a checagem vem antes.
 */
export const MISSION_REPLAY_MAX_RAW_PAYLOAD_BYTES = 1_048_576;

/** Eventos mais recentes entregues no lugar do replay (mesma janela da UI). */
export const MISSION_REPLAY_SNAPSHOT_EVENTS = 50;

/** Checagem de recurso aplicada antes de decodificar os payloads do replay. */
export function isMissionReplayRawPayloadSafe(rawPayloadBytes: number): boolean {
  return rawPayloadBytes <= MISSION_REPLAY_MAX_RAW_PAYLOAD_BYTES;
}

/** Custo codificado dos eventos como saem pelo IPC. */
export function missionReplayEncodedBytes(items: ReadonlyArray<unknown>): number {
  let total = 0;
  for (const item of items) {
    const encoded = JSON.stringify(item);
    total += Buffer.byteLength(encoded ?? '', 'utf8');
  }
  return total;
}

export type MissionReplayPlan =
  | {
      readonly mode: 'replay';
      readonly afterSequence: number;
      readonly throughSequence: number;
    }
  | { readonly mode: 'snapshot' };

/**
 * Replay do intervalo depois do cursor ou snapshot novo? Cursor acima da
 * maior sequência é velho ou inválido. O teto de eventos limita o retrabalho
 * do consumidor; o de bytes limita poucos eventos grandes. Qualquer excesso
 * sai mais barato como um snapshot atual.
 */
export function decideMissionEventReplay(input: {
  readonly afterSequence: number;
  readonly highWater: number;
  readonly replayEventCount: number;
  readonly replayEncodedBytes: number;
}): MissionReplayPlan {
  if (
    input.afterSequence > input.highWater ||
    input.replayEventCount > MISSION_REPLAY_MAX_EVENTS ||
    input.replayEncodedBytes > MISSION_REPLAY_MAX_ENCODED_BYTES
  ) {
    return { mode: 'snapshot' };
  }
  return {
    mode: 'replay',
    afterSequence: input.afterSequence,
    throughSequence: input.highWater,
  };
}
