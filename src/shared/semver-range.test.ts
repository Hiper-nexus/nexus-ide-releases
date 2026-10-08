// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: só os casos de
// satisfiesSemverRange de packages/shared/src/semver.test.ts (sem o teste de
// stringificação para SSH) + faixas reais das políticas de CLI do Nexus.
import { describe, expect, it } from 'vitest';
import { satisfiesSemverRange } from './semver-range';

describe('satisfiesSemverRange', () => {
  it('matches supported range groups', () => {
    const range = '^22.16 || ^23.11 || >=24.10';
    expect(satisfiesSemverRange('22.16.0', range)).toBe(true);
    expect(satisfiesSemverRange('23.11.1', range)).toBe(true);
    expect(satisfiesSemverRange('24.10.0', range)).toBe(true);
    expect(satisfiesSemverRange('22.15.9', range)).toBe(false);
    expect(satisfiesSemverRange('23.10.9', range)).toBe(false);
    expect(satisfiesSemverRange('24.9.9', range)).toBe(false);
  });

  it('treats missing minor/patch as zero', () => {
    expect(satisfiesSemverRange('24.9.0', '>=24.0 <24.10')).toBe(true);
    expect(satisfiesSemverRange('24.10.0', '>=24.0 <24.10')).toBe(false);
  });

  it('honors caret range upper bounds for zero-major versions', () => {
    expect(satisfiesSemverRange('0.2.3', '^0.2.3')).toBe(true);
    expect(satisfiesSemverRange('0.2.9', '^0.2.3')).toBe(true);
    expect(satisfiesSemverRange('0.3.0', '^0.2.3')).toBe(false);
    expect(satisfiesSemverRange('0.0.3', '^0.0.3')).toBe(true);
    expect(satisfiesSemverRange('0.0.4', '^0.0.3')).toBe(false);
  });

  it('rejects invalid versions and unsupported range syntax', () => {
    expect(satisfiesSemverRange('not-a-version', '>=24.0')).toBe(false);
    expect(satisfiesSemverRange('24.10.0', '~24.10')).toBe(false);
    expect(satisfiesSemverRange('24.10.0', '')).toBe(false);
  });

  it('closes both ends of a bounded CLI range', () => {
    const unsupported = '>=0.149.0 <0.156.0';
    expect(satisfiesSemverRange('0.148.9', unsupported)).toBe(false);
    expect(satisfiesSemverRange('0.149.0', unsupported)).toBe(true);
    expect(satisfiesSemverRange('v0.155.3', unsupported)).toBe(true);
    expect(satisfiesSemverRange('0.156.0', unsupported)).toBe(false);
    expect(satisfiesSemverRange('2.1.283', '=2.1.283')).toBe(true);
    expect(satisfiesSemverRange('2.1.283', '<=2.1.282')).toBe(false);
  });
});
