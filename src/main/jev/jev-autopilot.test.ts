import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  getOrchSettings: vi.fn(() => ({ jevAutopilot: true })),
}));

vi.mock('../persistence/settings-store', () => ({
  getOrchSettings: settings.getOrchSettings,
}));

import { isJevAutopilotEnabled, isJevSurfaceEnabled } from './jev-autopilot';

describe('isJevAutopilotEnabled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NEXUS_JEV_AUTOPILOT;
    settings.getOrchSettings.mockReturnValue({ jevAutopilot: true } as never);
  });

  it('ligado por padrão', () => {
    settings.getOrchSettings.mockReturnValue({} as never);
    expect(isJevAutopilotEnabled()).toBe(true);
  });

  it('orch.jevAutopilot === false desliga', () => {
    settings.getOrchSettings.mockReturnValue({ jevAutopilot: false } as never);
    expect(isJevAutopilotEnabled()).toBe(false);
  });

  it('NEXUS_JEV_AUTOPILOT=0 desliga mesmo com setting ligado', () => {
    process.env.NEXUS_JEV_AUTOPILOT = '0';
    expect(isJevAutopilotEnabled()).toBe(false);
  });
});

describe('isJevSurfaceEnabled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NEXUS_JEV_AUTOPILOT;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('NEXUS_JEV_SURFACE_')) delete process.env[key];
    }
    settings.getOrchSettings.mockReturnValue({
      jevAutopilot: true,
      jevSurfaces: {},
    } as never);
  });

  it('ligado por padrão para todas as superfícies', () => {
    for (const surface of [
      'handoffReview',
      'intake',
      'paneState',
      'terminalTriage',
      'rank',
    ] as const) {
      expect(isJevSurfaceEnabled(surface)).toBe(true);
    }
  });

  it('mestre desligado desliga qualquer superfície', () => {
    settings.getOrchSettings.mockReturnValue({
      jevAutopilot: false,
      jevSurfaces: { intake: true },
    } as never);
    expect(isJevSurfaceEnabled('intake')).toBe(false);
  });

  it('jevSurfaces.<surface> === false desliga só aquela', () => {
    settings.getOrchSettings.mockReturnValue({
      jevAutopilot: true,
      jevSurfaces: { intake: false },
    } as never);
    expect(isJevSurfaceEnabled('intake')).toBe(false);
    expect(isJevSurfaceEnabled('rank')).toBe(true);
  });

  it('NEXUS_JEV_SURFACE_<UPPER>=0 desliga mesmo com setting ligado', () => {
    process.env.NEXUS_JEV_SURFACE_INTAKE = '0';
    expect(isJevSurfaceEnabled('intake')).toBe(false);
    expect(isJevSurfaceEnabled('terminalTriage')).toBe(true);
  });

  it('jevSurfaces ausente (settings antigo) mantém tudo ligado', () => {
    settings.getOrchSettings.mockReturnValue({ jevAutopilot: true } as never);
    expect(isJevSurfaceEnabled('handoffReview')).toBe(true);
  });
});
