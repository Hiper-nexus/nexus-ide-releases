import { describe, expect, it } from 'vitest';

import type { ProviderQuotaEntry, QuotaWindow } from '../../shared/quota-types';
import {
  PULSE_HORIZON_MS,
  buildPulseMarkers,
  buildPulseTicks,
} from './quota-pulse';

const NOW = 1_800_000_000_000;

function entry(
  id: string,
  windows: QuotaWindow[],
  adapterId = id.split(':')[0],
): ProviderQuotaEntry {
  return {
    id,
    adapterId,
    label: id,
    installed: true,
    onCooldown: false,
    windows,
    updatedAt: NOW,
  };
}

function win(
  label: string,
  usedRatio: number | null,
  resetsAt?: number,
): QuotaWindow {
  return {
    kind: 'hours',
    label,
    usedRatio,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    source: 'provider-api',
    confidence: 'high',
  };
}

describe('buildPulseMarkers', () => {
  it('uma marca por conta: a janela decisiva com reset conhecido', () => {
    const markers = buildPulseMarkers(
      [
        entry('claude:a', [
          win('5h', 0.9, NOW + 40 * 60_000),
          win('Semana', 0.2, NOW + 5 * 24 * 3600_000),
        ]),
        entry('codex:b', [win('5h', 0.1, NOW + 3 * 3600_000)]),
      ],
      NOW,
    );
    expect(markers).toHaveLength(2);
    // ordenado por posição no horizonte: 40min < 3h
    expect(markers[0]?.entryId).toBe('claude:a');
    expect(markers[0]?.windowLabel).toBe('5h');
    expect(markers[0]?.tone).toBe('danger');
    expect(markers[1]?.entryId).toBe('codex:b');
    expect(markers[1]?.tone).toBe('ok');
  });

  it('conta sem reset conhecido não ganha marca (nada inventado)', () => {
    const markers = buildPulseMarkers([entry('opencode:x', [win('5h', 0.5)])], NOW);
    expect(markers).toHaveLength(0);
  });

  it('reset além do horizonte clamp em position 1 com beyondHorizon', () => {
    const markers = buildPulseMarkers(
      [entry('claude:a', [win('Semana', 0.3, NOW + PULSE_HORIZON_MS + 86_400_000)])],
      NOW,
    );
    expect(markers[0]?.position).toBe(1);
    expect(markers[0]?.beyondHorizon).toBe(true);
  });

  it('escolhe a janela de maior uso efetivo, não a de reset mais próximo', () => {
    const markers = buildPulseMarkers(
      [
        entry('claude:a', [
          win('5h', 0.1, NOW + 30 * 60_000),
          win('Semana', 0.85, NOW + 2 * 24 * 3600_000),
        ]),
      ],
      NOW,
    );
    expect(markers[0]?.windowLabel).toBe('Semana');
  });
});

describe('buildPulseTicks', () => {
  it('eixo ordenado com teto em position 1', () => {
    const ticks = buildPulseTicks();
    expect(ticks[0]?.label).toBe('1h');
    expect(ticks[0]?.position).toBeCloseTo(60 * 60_000 / PULSE_HORIZON_MS, 6);
    expect(ticks.at(-1)?.label).toBe('7d');
    expect(ticks.at(-1)?.position).toBe(1);
    const positions = ticks.map((t) => t.position);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
