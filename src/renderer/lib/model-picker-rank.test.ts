import { describe, expect, it } from 'vitest';
import type { AdapterInfo } from '../../shared/adapter-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import type { ProviderQuotaEntry } from '../../shared/quota-types';
import {
  authViewForModel,
  compareCost,
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
        provider({ models: ['opus'] }),
        provider({ adapterId: 'opencode', authStrategy: 'subscription', models: ['cheap-model'] }),
      ],
      quotaEntries: [],
    });
    expect(options[0]).toMatchObject({ adapterId: 'opencode', model: 'cheap-model' });
  });

  it('oferece só o que o provider serve no endpoint escolhido (F-1576)', () => {
    // O manifesto do Claude traz o DeepSeek Flash (custo free, viria em 1º);
    // com o Claude na Anthropic, a lista do provider já sai sem ele.
    const claude = adapter({
      models: {
        list: ['claude-opus-5-5', 'claude-sonnet-5-5', 'deepseek-flash'],
        default: 'claude-sonnet-5-5',
        info: { 'deepseek-flash': { id: 'deepseek-flash', costTier: 'free' } },
      },
    });
    const options = rankModelOptions({
      adapters: [claude],
      providers: [provider({ models: ['claude-opus-5-5', 'claude-sonnet-5-5'] })],
      quotaEntries: [],
    });
    expect(options.map((option) => option.model)).not.toContain('deepseek-flash');
    expect(options).toHaveLength(2);
  });

  it('sem lista no provider, cai no manifesto do adapter', () => {
    const options = rankModelOptions({
      adapters: [adapter()],
      providers: [provider({ models: [] })],
      quotaEntries: [],
    });
    expect(options.map((option) => option.model).sort()).toEqual(['opus', 'sonnet']);
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

  it('compareCost nunca retorna NaN (dois bloqueados desempatam adiante)', () => {
    expect(compareCost(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(0);
    expect(compareCost(Number.POSITIVE_INFINITY, 3)).toBeGreaterThan(0);
    expect(compareCost(1, Number.POSITIVE_INFINITY)).toBeLessThan(0);
    expect(compareCost(1, 3)).toBeLessThan(0);
  });

  it('dois modelos api-only ordenam pelo desempate seguinte, determinístico', () => {
    const blocked = (id: string, label: string) =>
      adapter({
        id,
        label,
        models: {
          list: [`${id}-x`],
          default: `${id}-x`,
          info: { [`${id}-x`]: { id: `${id}-x`, availability: 'api-only' } },
        },
      });
    const first = rankModelOptions({
      adapters: [blocked('b', 'Beta'), blocked('a', 'Alfa')],
      providers: [
        provider({ adapterId: 'b', models: ['b-x'] }),
        provider({ adapterId: 'a', label: 'Alfa', models: ['a-x'] }),
      ],
      quotaEntries: [],
    });
    const second = rankModelOptions({
      adapters: [blocked('a', 'Alfa'), blocked('b', 'Beta')],
      providers: [
        provider({ adapterId: 'a', label: 'Alfa', models: ['a-x'] }),
        provider({ adapterId: 'b', models: ['b-x'] }),
      ],
      quotaEntries: [],
    });
    // Ordem independe da entrada: Alfa antes de Beta (label).
    expect(first.map((o) => o.adapterId)).toEqual(['a', 'b']);
    expect(second.map((o) => o.adapterId)).toEqual(['a', 'b']);
  });

  it('authReadyModels com espaço em branco ainda casa o modelo', () => {
    const view = authViewForModel(
      provider({
        authStrategy: 'login-needed',
        authReadyModels: ['  gpt-x  '],
      }),
      'gpt-x',
    );
    expect(view).toEqual({ ready: true });
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

  it('compareCost desempatador lida com valores infinitos sem gerar NaN', () => {
    expect(compareCost(1, 2)).toBeLessThan(0);
    expect(compareCost(2, 1)).toBeGreaterThan(0);
    expect(compareCost(1, 1)).toBe(0);
    expect(compareCost(1, Infinity)).toBe(-1);
    expect(compareCost(Infinity, 1)).toBe(1);
    expect(compareCost(Infinity, Infinity)).toBe(0);
  });
});
