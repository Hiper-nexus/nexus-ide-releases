import { describe, expect, it } from 'vitest';
import {
  FUNCTIONAL_SMOKE_MIN_ADAPTERS,
  FUNCTIONAL_SMOKE_MIN_TOOLS,
  FUNCTIONAL_SMOKE_REQUIRED_PROBES,
  parseFunctionalSmokeResult,
} from './smoke-types';

describe('parseFunctionalSmokeResult', () => {
  it('accepts only a complete bounded success report', () => {
    expect(
      parseFunctionalSmokeResult({
        ok: true,
        probes: [...FUNCTIONAL_SMOKE_REQUIRED_PROBES],
        adapterCount: FUNCTIONAL_SMOKE_MIN_ADAPTERS,
        toolCount: FUNCTIONAL_SMOKE_MIN_TOOLS,
      }),
    ).toEqual({
      ok: true,
      probes: [...FUNCTIONAL_SMOKE_REQUIRED_PROBES],
      adapterCount: FUNCTIONAL_SMOKE_MIN_ADAPTERS,
      toolCount: FUNCTIONAL_SMOKE_MIN_TOOLS,
    });
  });

  it('rejects incomplete, duplicate, or undersized success evidence', () => {
    expect(
      parseFunctionalSmokeResult({
        ok: true,
        probes: FUNCTIONAL_SMOKE_REQUIRED_PROBES.slice(1),
        adapterCount: FUNCTIONAL_SMOKE_MIN_ADAPTERS,
        toolCount: FUNCTIONAL_SMOKE_MIN_TOOLS,
      }),
    ).toBeNull();
    expect(
      parseFunctionalSmokeResult({
        ok: true,
        probes: [
          ...FUNCTIONAL_SMOKE_REQUIRED_PROBES.slice(0, -1),
          FUNCTIONAL_SMOKE_REQUIRED_PROBES[0],
        ],
        adapterCount: FUNCTIONAL_SMOKE_MIN_ADAPTERS,
        toolCount: FUNCTIONAL_SMOKE_MIN_TOOLS,
      }),
    ).toBeNull();
    expect(
      parseFunctionalSmokeResult({
        ok: true,
        probes: FUNCTIONAL_SMOKE_REQUIRED_PROBES,
        adapterCount: 0,
        toolCount: 0,
      }),
    ).toBeNull();
  });

  it('accepts a failure only when its identifier is from the closed probe set', () => {
    expect(
      parseFunctionalSmokeResult({
        ok: false,
        probes: ['workspace-open'],
        failedProbe: 'adapter-registry',
      }),
    ).toEqual({
      ok: false,
      probes: ['workspace-open'],
      failedProbe: 'adapter-registry',
    });
    expect(
      parseFunctionalSmokeResult({
        ok: false,
        probes: [],
        failedProbe: 'secret provider output',
      }),
    ).toBeNull();
  });

  it('rejects extra fields so renderer input cannot smuggle log text', () => {
    expect(
      parseFunctionalSmokeResult({
        ok: false,
        probes: [],
        failedProbe: 'workspace-open',
        error: 'sensitive detail',
      }),
    ).toBeNull();
  });
});
