import { describe, expect, it } from 'vitest';
import {
  BUILTIN_FEATURE_FLAGS,
  FEATURE_FLAG_IDS,
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

  it('keeps project overview ON and persistent session OFF by default on dev', () => {
    const overview = BUILTIN_FEATURE_FLAGS.find(
      (f) => f.id === FEATURE_FLAG_IDS.uiProjectOverview,
    );
    expect(overview).toBeDefined();
    expect(
      resolveFeatureFlag(overview, { runtimeChannel: 'dev' }).enabled,
    ).toBe(true);

    const persistent = BUILTIN_FEATURE_FLAGS.find(
      (f) => f.id === FEATURE_FLAG_IDS.ptyPersistentSession,
    );
    expect(persistent).toBeDefined();
    expect(
      resolveFeatureFlag(persistent, { runtimeChannel: 'dev' }).enabled,
    ).toBe(false);
  });

  it('pins the default-on/off contract per flag (flips are reviewed decisions)', () => {
    // Fase de operador único: superfícies prontas nascem ON (descoberta em uso
    // real); ficam OFF só as com efeito fora do workspace, dependência de infra
    // externa ou sem consumidor. Mudar este conjunto exige decisão revisada.
    const DEFAULT_OFF = new Set([
      'feature.remote.relayTransport', // exige relay hospedado + URL explícita
      'feature.autonomy.profiles', // sem consumidor no produto ainda
      // tmux attach fura advisory Seatbelt/Bubblewrap — fail-closed até
      // o wrap sandboxed existir (H2 senior review 2026-08-11).
      'feature.pty.persistentSession',
      // Warm-up e worker TTL são DEFAULT-ON (paridade Bridge multi-pane +
      // Overclock close→wake). E2E real-mission opt-out via override de flag.
      // Enforcement global (nudge 20s + handoff sintético 45s) é DEFAULT-OFF:
      // a Via Rápida supervisiona os workers e completa por observação — o
      // enforcement brigava com essa conclusão (B1, dossiê 2026-08-11).
      'feature.mission.workerHandoffEnforcement',
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
