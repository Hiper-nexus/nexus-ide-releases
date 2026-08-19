import { describe, expect, it } from 'vitest';
import {
  aggregateMissionTelemetry,
  embedTelemetryArtifact,
  extractHandoffTelemetry,
  formatMissionTelemetry,
  sanitizeHandoffTelemetry,
} from './handoff-telemetry';

describe('telemetria autorrelatada por handoff (overclick, 19/08)', () => {
  it('saneia números reais e descarta lixo', () => {
    expect(
      sanitizeHandoffTelemetry({
        durationMs: 34 * 60_000,
        tokensTotal: 1_200_000,
        estimated: true,
      }),
    ).toEqual({ durationMs: 2_040_000, tokensTotal: 1_200_000, estimated: true });
    expect(sanitizeHandoffTelemetry(null)).toBeNull();
    expect(sanitizeHandoffTelemetry('34 min')).toBeNull();
    expect(sanitizeHandoffTelemetry({ durationMs: -5 })).toBeNull();
    expect(sanitizeHandoffTelemetry({ durationMs: Infinity })).toBeNull();
    // Zero confiante não existe: sem dado aproveitável → null, nunca {0}.
    expect(sanitizeHandoffTelemetry({ durationMs: 0, tokensTotal: 0 })).toBeNull();
  });

  it('tokensByModel soma o total quando o agente não informou tokensTotal', () => {
    const sane = sanitizeHandoffTelemetry({
      tokensByModel: { 'gpt-5.6': 800_000, sonnet: 400_000 },
    });
    expect(sane?.tokensTotal).toBe(1_200_000);
    expect(sane?.tokensByModel).toEqual({ 'gpt-5.6': 800_000, sonnet: 400_000 });
  });

  it('teto físico: duração >24h e tokens absurdos são descartados', () => {
    expect(sanitizeHandoffTelemetry({ durationMs: 25 * 60 * 60 * 1000 })).toBeNull();
    expect(sanitizeHandoffTelemetry({ tokensTotal: 1e12 })).toBeNull();
  });

  it('round-trip: embed em artifacts → extract do handoff persistido', () => {
    const telemetry = { durationMs: 60_000, tokensTotal: 5_000 };
    const handoff = {
      artifacts: [
        'texto solto',
        { outraCoisa: 1 },
        embedTelemetryArtifact(telemetry),
      ],
    };
    expect(extractHandoffTelemetry(handoff)).toEqual(telemetry);
    expect(extractHandoffTelemetry({ artifacts: [] })).toBeNull();
  });

  it('agrega a missão declarando cobertura — ausência nunca vira zero mudo', () => {
    const withTelemetry = {
      artifacts: [embedTelemetryArtifact({ durationMs: 120_000, tokensTotal: 10_000 })],
    };
    const silent = { artifacts: [] };
    const aggregate = aggregateMissionTelemetry([withTelemetry, silent, withTelemetry]);
    expect(aggregate).toEqual({
      totalDurationMs: 240_000,
      totalTokens: 20_000,
      reported: 2,
      total: 3,
      estimated: false,
    });
    expect(aggregateMissionTelemetry([silent])).toBeNull();
  });

  it('formata "Xmin · Yk tokens · autorrelato N/M" com ~ para estimativas', () => {
    expect(
      formatMissionTelemetry({
        totalDurationMs: 34 * 60_000,
        totalTokens: 1_200_000,
        reported: 5,
        total: 7,
        estimated: false,
      }),
    ).toBe('34 min · 1.2M tokens · autorrelato 5/7');
    expect(
      formatMissionTelemetry({
        totalDurationMs: 90_000,
        totalTokens: 5_000,
        reported: 1,
        total: 1,
        estimated: true,
      }),
    ).toBe('~2 min · 5k tokens · autorrelato 1/1');
  });
});
