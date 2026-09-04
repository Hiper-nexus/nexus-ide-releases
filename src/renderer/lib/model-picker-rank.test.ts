import { describe, expect, it } from 'vitest';
import type { AdapterInfo } from '../../shared/adapter-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import type { ProviderQuotaEntry } from '../../shared/quota-types';
import {
  authViewForModel,
  costRankForModel,
  rankModelOptions,
  worstQuotaFor,
} from './model-picker-rank';

function adapter(overrides: Partial<AdapterInfo> = {}): AdapterInfo {
  return {
    id: 'claude',
    kind: 'cli-pty',
    label: 'Claude',
    icon: '◆',
    models: { list: ['opus', 'sonnet'], default: 'sonnet' },
    installed: true,
    installCommand: 'npm i -g claude',
    idleTimeoutMs: 800,
    orchestratorCapable: true,
    ...overrides,
  };
}

function provider(overrides: Partial<ProviderSettingsInfo> = {}): ProviderSettingsInfo {
  return {
    adapterId: 'claude',
    label: 'Claude',
    icon: '◆',
    kind: 'cli-pty',
    enabled: true,
    installed: true,
    canAutoInstall: false,
    binPath: '/usr/local/bin/claude',
    detectedBin: '/usr/local/bin/claude',
    defaultModel: 'sonnet',
    models: ['opus', 'sonnet'],
    extraArgs: [],
    keyEnvVar: null,
    hasKey: false,
    keyMasked: null,
    authMethod: 'oauth',
    authStrategy: 'subscription',
    upstream: 'anthropic',
    routable: true,
    upstreams: [],
    permissionMode: '',
    permissionModes: [],
    effort: '',
    efforts: [],
    verbose: false,
    supportsVerbose: false,
    customModels: [],
    secureStorageAvailable: true,
    ...overrides,
  };
}

function quotaEntry(
  adapterId: string,
  ratios: (number | null)[],
): ProviderQuotaEntry {
  return {
    id: adapterId,
    adapterId,
    label: adapterId,
    installed: true,
    onCooldown: false,
    windows: ratios.map((usedRatio, i) => ({
      kind: 'hours' as const,
      label: `${i}h`,
      usedRatio,
      source: 'provider-api' as const,
      confidence: 'high' as const,
    })),
    updatedAt: 0,
  };
}

describe('model-picker-rank', () => {
  it('sessão pronta vence quota alta; login-needed vai para o fim com motivo', () => {
    const options = rankModelOptions({
      adapters: [
        adapter(),
        adapter({ id: 'codex', label: 'Codex', icon: '⬡' }),
      ],
      providers: [
        provider(),
        provider({
          adapterId: 'codex',
          label: 'Codex',
          icon: '⬡',
          authStrategy: 'login-needed',
          authReadyModels: [],
          loginCommand: 'codex login',
        }),
      ],
      quotaEntries: [quotaEntry('claude', [0.9]), quotaEntry('codex', [0.1])],
    });
    expect(options[0]?.adapterId).toBe('claude');
    expect(options[0]?.ready).toBe(true);
    const codex = options.find((o) => o.adapterId === 'codex');
    expect(codex?.ready).toBe(false);
    expect(codex?.reason).toContain('codex login');
    // Mesmo com quota alta, sessão pronta vem antes de login-needed.
    expect(
      options.findIndex((o) => o.adapterId === 'claude'),
    ).toBeLessThan(options.findIndex((o) => o.adapterId === 'codex'));
  });

  it('entre prontos, desempata por custo e depois por quota', () => {
    const cheap = adapter({
      id: 'opencode',
      label: 'OpenCode',
      icon: '○',
      models: {
        list: ['cheap-model'],
        default: 'cheap-model',
        info: { 'cheap-model': { id: 'cheap-model', costTier: 'low' } },
      },
    });
    const pricey = adapter({
      models: {
        list: ['opus'],
        default: 'opus',
        info: { opus: { id: 'opus', costTier: 'high' } },
      },
    });
    const options = rankModelOptions({
      adapters: [pricey, cheap],
      providers: [
        provider(),
        provider({ adapterId: 'opencode', authStrategy: 'subscription' }),
      ],
      quotaEntries: [],
    });
    expect(options[0]).toMatchObject({ adapterId: 'opencode', model: 'cheap-model' });
  });

  it('provedor ausente = verificando (null), nunca pronto nem bloqueado', () => {
    expect(authViewForModel(undefined, 'x')).toEqual({
      ready: null,
      reason: 'verificando sessão…',
    });
  });

  it('api-only nunca vence mesmo com sessão pronta', () => {
    const blocked = adapter({
      models: {
        list: ['api-x'],
        default: 'api-x',
        info: { 'api-x': { id: 'api-x', availability: 'api-only' } },
      },
    });
    expect(costRankForModel(blocked, 'api-x')).toBe(Number.POSITIVE_INFINITY);
  });

  it('pior janela agrega todas as janelas; cooldown = 1', () => {
    expect(worstQuotaFor([quotaEntry('claude', [0.2, 0.7])], 'claude')).toBe(0.7);
    expect(worstQuotaFor([quotaEntry('claude', [null])], 'claude')).toBeNull();
    const cooling: ProviderQuotaEntry = {
      ...quotaEntry('claude', [0.1]),
      onCooldown: true,
    };
    expect(worstQuotaFor([cooling], 'claude')).toBe(1);
  });
});
