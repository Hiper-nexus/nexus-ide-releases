import { describe, expect, it } from 'vitest';
import {
  MISSION_REPLAY_MAX_ENCODED_BYTES,
  MISSION_REPLAY_MAX_EVENTS,
  decideMissionEventReplay,
  isMissionReplayRawPayloadSafe,
  missionReplayEncodedBytes,
} from './mission-event-replay-budget';

describe('ORC-10 decideMissionEventReplay', () => {
  it('tetos portados: 128 eventos e 1 MiB', () => {
    expect(MISSION_REPLAY_MAX_EVENTS).toBe(128);
    expect(MISSION_REPLAY_MAX_ENCODED_BYTES).toBe(1_048_576);
    expect(isMissionReplayRawPayloadSafe(1_048_576)).toBe(true);
    expect(isMissionReplayRawPayloadSafe(1_048_577)).toBe(false);
  });

  it('dentro do teto reaplica o intervalo depois do cursor', () => {
    expect(decideMissionEventReplay({
      afterSequence: 2, highWater: 130, replayEventCount: 128, replayEncodedBytes: 1_048_576,
    })).toEqual({ mode: 'replay', afterSequence: 2, throughSequence: 130 });
  });

  it('acima de eventos, de bytes ou com cursor velho vira snapshot', () => {
    const base = { afterSequence: 0, highWater: 200, replayEventCount: 10, replayEncodedBytes: 10 };
    expect(decideMissionEventReplay({ ...base, replayEventCount: 129 })).toEqual({ mode: 'snapshot' });
    expect(decideMissionEventReplay({ ...base, replayEncodedBytes: 1_048_577 })).toEqual({ mode: 'snapshot' });
    expect(decideMissionEventReplay({ ...base, afterSequence: 201 })).toEqual({ mode: 'snapshot' });
  });

  it('conta bytes UTF-8 do JSON de cada item', () => {
    expect(missionReplayEncodedBytes([{ a: 'é' }, 'x'])).toBe(
      Buffer.byteLength('{"a":"é"}') + Buffer.byteLength('"x"'),
    );
  });
});
