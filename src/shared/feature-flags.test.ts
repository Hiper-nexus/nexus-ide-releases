import { describe, expect, it } from 'vitest';
import {
  BUILTIN_FEATURE_FLAGS,
  channelAllowsFlag,
  featureFlagDefinitionSchema,
  resolveFeatureFlag,
} from './feature-flags';

describe('feature flags', () => {
  it('parses builtin definitions', () => {
    for (const flag of BUILTIN_FEATURE_FLAGS) {
      expect(() => featureFlagDefinitionSchema.parse(flag)).not.toThrow();
    }
  });

  it('channel policy is fail-closed for lower channels', () => {
    expect(channelAllowsFlag('dev', 'stable')).toBe(false);
    expect(channelAllowsFlag('stable', 'dev')).toBe(true);
    expect(channelAllowsFlag('preview', 'preview')).toBe(true);
    expect(channelAllowsFlag('dogfood', 'preview')).toBe(false);
  });

  it('kill switch wins over override', () => {
    const def = featureFlagDefinitionSchema.parse({
      id: 'feature.test.kill',
      owner: 'test',
      description: 'kill switch fixture',
      channel: 'dev',
      createdAt: '2026-07-13',
      removeAfter: '2026-12-31',
      killSwitch: true,
      telemetry: false,
      defaultEnabled: true,
    });
    expect(
      resolveFeatureFlag(def, { runtimeChannel: 'dev', override: true }),
    ).toMatchObject({ enabled: false, reason: 'kill-switch' });
  });

  it('unknown flags fail closed', () => {
    expect(
      resolveFeatureFlag(undefined, { runtimeChannel: 'stable' }),
    ).toMatchObject({ enabled: false, reason: 'unknown-flag' });
  });

  it('pins the default-on/off contract per flag (flips are reviewed decisions)', () => {
    // Fase de operador único: superfícies prontas nascem ON (descoberta em uso
    // real); ficam OFF só as com efeito fora do workspace, dependência de infra
    // externa ou sem consumidor. Mudar este conjunto exige decisão revisada.
    const DEFAULT_OFF = new Set([
      'feature.remote.relayTransport', // exige relay hospedado + URL explícita
      'feature.autonomy.profiles', // sem consumidor no produto ainda
      // Warm-up abre reviewer/QA cedo; o review real ainda spawna outra PTY e
      // o E2E real-mission aborta. Opt-in Labs até reutilizar a sessão.
      'feature.mission.warmupAdvisories',
    ]);
    for (const flag of BUILTIN_FEATURE_FLAGS) {
      expect(
        flag.defaultEnabled,
        `defaultEnabled inesperado para ${flag.id}`,
      ).toBe(!DEFAULT_OFF.has(flag.id));
      expect(flag.channel).toBe('dev');
    }
  });
});
