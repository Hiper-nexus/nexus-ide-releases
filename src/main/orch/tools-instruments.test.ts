import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import type { AgentGateContext } from './gate';

/**
 * Instrument panel tools — read-only consultations. Every source is mocked so
 * the suite proves the projection/redaction/cap contract, never the upstream
 * services. Sources are dynamically imported inside each handler, so these
 * factories fully replace them (no Electron ever loads).
 */

const quotaMocks = vi.hoisted(() => ({ lastSnapshot: vi.fn() }));
const rankingMocks = vi.hoisted(() => ({ getPublicModelRanking: vi.fn() }));
const flagMocks = vi.hoisted(() => ({ isEnabled: vi.fn(() => true) }));
const catalogMocks = vi.hoisted(() => ({ listInstalledCatalogItems: vi.fn() }));
const adapterMocks = vi.hoisted(() => ({ listAdapterInfos: vi.fn() }));
const providerMocks = vi.hoisted(() => ({ listProviderSettings: vi.fn() }));
const enrichMocks = vi.hoisted(() => ({ loadEnrichedCatalog: vi.fn() }));

vi.mock('../quota/quota-service', () => ({
  requireQuotaService: () => ({ lastSnapshot: quotaMocks.lastSnapshot }),
}));

vi.mock('../eval/eval-ipc', () => ({
  getPublicModelRanking: rankingMocks.getPublicModelRanking,
}));

vi.mock('../feature-flags/feature-flag-registry', () => ({
  getFeatureFlagRegistry: () => ({ isEnabled: flagMocks.isEnabled }),
}));

vi.mock('./catalog-installed', () => ({
  listInstalledCatalogItems: catalogMocks.listInstalledCatalogItems,
}));

vi.mock('./harness-enrich', () => ({
  loadEnrichedCatalog: enrichMocks.loadEnrichedCatalog,
}));

vi.mock('../adapters/adapter-registry', () => ({
  listAdapterInfos: adapterMocks.listAdapterInfos,
}));

vi.mock('../persistence/provider-config-store', () => ({
  listProviderSettings: providerMocks.listProviderSettings,
}));

const { buildInstrumentTools } = await import('./tools-instruments');

const roots: string[] = [];

function scopeFor(root: string): ProjectExecutionScope {
  return Object.freeze({
    version: 1 as const,
    installationId: 'install-instruments',
    projectId: 'project-instruments',
    checkoutId: 'checkout-instruments',
    rootRealPath: root,
    identitySource: 'provisional' as const,
  });
}

function ctx(
  overrides: Partial<AgentGateContext> = {},
  root = os.tmpdir(),
): AgentGateContext {
  return {
    token: 'token-test',
    label: 'test',
    role: 'orchestrator',
    sessionId: 'session-1',
    agentName: 'orchestrator',
    scope: scopeFor(root),
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
    ...overrides,
  };
}

function tool(name: string) {
  const found = buildInstrumentTools().find((t) => t.name === name);
  if (!found) throw new Error(`tool not registered: ${name}`);
  return found;
}

function mkRoot(): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-instruments-')),
  );
  roots.push(root);
  return root;
}

beforeEach(() => {
  quotaMocks.lastSnapshot.mockReset().mockReturnValue(null);
  rankingMocks.getPublicModelRanking.mockReset();
  flagMocks.isEnabled.mockReset().mockReturnValue(true);
  catalogMocks.listInstalledCatalogItems.mockReset().mockReturnValue([]);
  adapterMocks.listAdapterInfos.mockReset().mockReturnValue([]);
  providerMocks.listProviderSettings.mockReset().mockReturnValue([]);
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const INSTRUMENT_NAMES = [
  'nexus_quota_status',
  'nexus_model_ranking',
  'nexus_mcp_servers',
  'nexus_skills_inventory',
  // Ingestão de plugin é INSTRUMENTO, não instalação: descobre e relata. Se um
  // dia ela ganhar poder de gravar, o teste abaixo ("no new authority") quebra —
  // que é exatamente o alarme certo.
  'nexus_plugin_inventory',
  'nexus_cli_inventory',
  'nexus_vault_list',
] as const;

describe('buildInstrumentTools', () => {
  it('registers exactly the read-only instruments, in order', () => {
    expect(buildInstrumentTools().map((t) => t.name)).toEqual([
      ...INSTRUMENT_NAMES,
    ]);
  });

  it('classifies every instrument read-only — no confirmation, no new authority', async () => {
    const { effectPolicyForTool, requiresHumanConfirmationForTool } =
      await import('./mcp-effect-policy');
    for (const name of INSTRUMENT_NAMES) {
      expect(effectPolicyForTool(name)).toBe('read-only');
      expect(requiresHumanConfirmationForTool(name)).toBe(false);
    }
  });

  it('declares no tool that forces confirmation and no empty input schema drift', () => {
    for (const tool of buildInstrumentTools()) {
      expect(tool.requiresConfirm).toBeUndefined();
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
    }
  });
});

describe('nexus_quota_status', () => {
  const snapshot = {
    updatedAt: 1_700_000_000_000,
    worstUsedRatio: 0.91,
    highUsageCount: 1,
    unknownCount: 0,
    entries: [
      {
        id: 'claude:acct-1',
        adapterId: 'claude',
        accountId: 'acct-1',
        label: 'Claude Code · retornoja@gmail.com',
        installed: true,
        onCooldown: true,
        cooldownUntil: 1_700_000_100_000,
        updatedAt: 1_700_000_000_000,
        windows: [
          {
            kind: 'weekly',
            label: 'Semanal',
            usedRatio: 0.91,
            resetsAt: 1_700_600_000_000,
            remainingLabel: 'conta de cleofas rocha — 9% restante',
            source: 'provider-api',
            confidence: 'high',
          },
        ],
      },
      {
        id: 'codex',
        adapterId: 'codex',
        label: 'Codex · CLI nativo',
        installed: true,
        onCooldown: false,
        updatedAt: 1_700_000_000_000,
        windows: [
          {
            kind: 'session',
            label: 'Sessão',
            usedRatio: null,
            source: 'unknown',
            confidence: 'low',
          },
        ],
      },
    ],
  };

  it('answers honestly when no snapshot exists yet (no fabricated numbers)', async () => {
    quotaMocks.lastSnapshot.mockReturnValue(null);
    const out = (await tool('nexus_quota_status').handler({}, ctx())) as {
      available: boolean;
      reason: string;
      entries: unknown[];
    };
    expect(out.available).toBe(false);
    expect(out.entries).toEqual([]);
    expect(out.reason).toMatch(/no quota snapshot/i);
  });

  it('answers honestly when the quota service is not initialized', async () => {
    quotaMocks.lastSnapshot.mockImplementation(() => {
      throw new Error('quota service not initialized');
    });
    const out = (await tool('nexus_quota_status').handler({}, ctx())) as {
      available: boolean;
      reason: string;
      entries: unknown[];
    };
    expect(out.available).toBe(false);
    expect(out.entries).toEqual([]);
    expect(out.reason).toMatch(/not initialized/i);
  });

  it('gives the orchestrator the whole fleet with decision fields only', async () => {
    quotaMocks.lastSnapshot.mockReturnValue(snapshot);
    const out = (await tool('nexus_quota_status').handler({}, ctx())) as {
      available: boolean;
      scope: string;
      entries: Array<Record<string, unknown>>;
      fleet: Record<string, unknown>;
    };
    expect(out.available).toBe(true);
    expect(out.scope).toBe('fleet');
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toEqual({
      adapterId: 'claude',
      accountId: 'acct-1',
      kind: 'account',
      installed: true,
      onCooldown: true,
      cooldownUntil: 1_700_000_100_000,
      updatedAt: 1_700_000_000_000,
      windows: [
        {
          kind: 'weekly',
          label: 'Semanal',
          usedRatio: 0.91,
          resetsAt: 1_700_600_000_000,
          source: 'provider-api',
          confidence: 'high',
        },
      ],
    });
    expect(out.fleet).toEqual({
      worstUsedRatio: 0.91,
      highUsageCount: 1,
      unknownCount: 0,
      entryCount: 2,
    });
  });

  it('never leaks the account label, e-mail or free-text remaining blurb', async () => {
    quotaMocks.lastSnapshot.mockReturnValue(snapshot);
    const raw = JSON.stringify(
      await tool('nexus_quota_status').handler({}, ctx()),
    );
    expect(raw).not.toContain('retornoja');
    expect(raw).not.toContain('@');
    expect(raw).not.toContain('cleofas');
    expect(raw).not.toContain('remainingLabel');
    expect(raw).not.toContain('label":"Claude Code');
  });

  it('scopes a worker to its own provider and hides the fleet aggregate', async () => {
    quotaMocks.lastSnapshot.mockReturnValue(snapshot);
    const out = (await tool('nexus_quota_status').handler(
      {},
      ctx({ role: 'worker', providerId: 'codex' }),
    )) as {
      scope: string;
      entries: Array<{ adapterId: string }>;
      fleet?: unknown;
    };
    expect(out.scope).toBe('own-provider');
    expect(out.entries.map((e) => e.adapterId)).toEqual(['codex']);
    expect(out.fleet).toBeUndefined();
  });

  it('refuses a worker with no provider identity instead of showing the fleet', async () => {
    quotaMocks.lastSnapshot.mockReturnValue(snapshot);
    const out = (await tool('nexus_quota_status').handler(
      {},
      ctx({ role: 'worker' }),
    )) as { available: boolean; reason: string; entries: unknown[] };
    expect(out.available).toBe(false);
    expect(out.entries).toEqual([]);
    expect(out.reason).toMatch(/provider identity/i);
  });

  it('caps entries and windows', async () => {
    quotaMocks.lastSnapshot.mockReturnValue({
      updatedAt: 1,
      worstUsedRatio: null,
      highUsageCount: 0,
      unknownCount: 0,
      entries: Array.from({ length: 200 }, (_, i) => ({
        id: `a${i}`,
        adapterId: `adapter-${i}`,
        label: `l${i}`,
        installed: true,
        onCooldown: false,
        updatedAt: 1,
        windows: Array.from({ length: 40 }, (_, w) => ({
          kind: 'session',
          label: `w${w}`,
          usedRatio: 0.1,
          source: 'unknown',
          confidence: 'low',
        })),
      })),
    });
    const out = (await tool('nexus_quota_status').handler({}, ctx())) as {
      truncated: boolean;
      entries: Array<{ windows: unknown[] }>;
    };
    expect(out.entries).toHaveLength(64);
    expect(out.entries[0].windows).toHaveLength(8);
    expect(out.truncated).toBe(true);
  });
});

describe('nexus_model_ranking', () => {
  const ranking = {
    schemaVersion: 1,
    generatedAt: '2026-07-31T00:00:00.000Z',
    suiteId: 'v1',
    suiteRevision: 'fixture-1',
    description: 'public',
    entries: [
      {
        id: 'claude/opus',
        adapterId: 'claude',
        modelId: 'opus',
        overall: 0.9,
        coding: 0.7,
        costTier: 'premium',
        evaluatedAt: '2026-07-30T00:00:00.000Z',
        source: 'nexus-eval/fixtures',
        confidence: 0.8,
        estimate: true,
        sourceLabel: 'estimativa (fixture)',
      },
      {
        id: 'codex/gpt',
        adapterId: 'codex',
        modelId: 'gpt',
        overall: 0.6,
        coding: 0.95,
        evaluatedAt: '2026-07-30T00:00:00.000Z',
        source: 'nexus-eval/v1',
      },
    ],
  };

  it('ranks by the requested dimension and keeps the estimate mark', async () => {
    rankingMocks.getPublicModelRanking.mockReturnValue(ranking);
    const out = (await tool('nexus_model_ranking').handler(
      { dimension: 'coding' },
      ctx(),
    )) as {
      available: boolean;
      dimension: string;
      entries: Array<{ modelId: string; score: number; estimate: boolean }>;
    };
    expect(out.available).toBe(true);
    expect(out.dimension).toBe('coding');
    expect(out.entries.map((e) => e.modelId)).toEqual(['gpt', 'opus']);
    expect(out.entries[0].score).toBe(0.95);
    expect(out.entries[1].estimate).toBe(true);
    expect(out.entries[0].estimate).toBe(false);
  });

  it('reports honestly when the ranking engine has nothing to say', async () => {
    rankingMocks.getPublicModelRanking.mockReturnValue({
      ...ranking,
      entries: [],
    });
    const out = (await tool('nexus_model_ranking').handler({}, ctx())) as {
      available: boolean;
      reason: string;
      entries: unknown[];
    };
    expect(out.available).toBe(false);
    expect(out.entries).toEqual([]);
    expect(out.reason).toMatch(/no ranking entries/i);
  });

  it('reports honestly when the ranking source throws', async () => {
    rankingMocks.getPublicModelRanking.mockImplementation(() => {
      throw new Error('catalog unreadable');
    });
    const out = (await tool('nexus_model_ranking').handler({}, ctx())) as {
      available: boolean;
      reason: string;
    };
    expect(out.available).toBe(false);
    expect(out.reason).toContain('catalog unreadable');
  });

  it('caps the requested limit', async () => {
    rankingMocks.getPublicModelRanking.mockReturnValue({
      ...ranking,
      entries: Array.from({ length: 300 }, (_, i) => ({
        id: `a/${i}`,
        adapterId: 'a',
        modelId: `m${i}`,
        overall: i / 300,
        evaluatedAt: '2026-07-30T00:00:00.000Z',
        source: 'nexus-eval/v1',
      })),
    });
    const out = (await tool('nexus_model_ranking').handler(
      { limit: 5_000 },
      ctx(),
    )) as { entries: unknown[]; truncated: boolean };
    expect(out.entries).toHaveLength(64);
    expect(out.truncated).toBe(true);
  });

  it('is available to a worker (public data, no account facts)', async () => {
    rankingMocks.getPublicModelRanking.mockReturnValue(ranking);
    const out = (await tool('nexus_model_ranking').handler(
      {},
      ctx({ role: 'worker', providerId: 'codex' }),
    )) as { available: boolean };
    expect(out.available).toBe(true);
  });

  it('sempre devolve doutrina + faixas — paridade com overclock_model_list', async () => {
    rankingMocks.getPublicModelRanking.mockReturnValue({
      ...ranking,
      entries: [
        ...ranking.entries,
        {
          id: 'grok/fast',
          adapterId: 'grok',
          modelId: 'fast',
          overall: 0.4,
          costTier: 'low',
          evaluatedAt: '2026-07-30T00:00:00.000Z',
          source: 'nexus-eval/v1',
        },
      ],
    });
    const out = (await tool('nexus_model_ranking').handler(
      { need: 'atualizar o README com o guia de instalação' },
      ctx(),
    )) as {
      doctrine: { rule: string };
      bands: { fast: Array<{ modelId: string }> };
      need: {
        specialty: string;
        band: string;
        pick: { modelId: string; degraded: boolean; servedBand: string };
      };
    };
    expect(out.doctrine.rule).toBe('default-down');
    expect(out.need.specialty).toBe('doc');
    expect(out.need.band).toBe('fast');
    expect(out.need.pick.modelId).toBe('fast');
    expect(out.need.pick.degraded).toBe(false);
    expect(out.bands.fast.some((e) => e.modelId === 'fast')).toBe(true);
  });

  it('degrada a faixa quando o alvo está vazio — nunca escala UP', async () => {
    rankingMocks.getPublicModelRanking.mockReturnValue({
      ...ranking,
      entries: [
        {
          id: 'grok/fast',
          adapterId: 'grok',
          modelId: 'fast',
          overall: 0.4,
          costTier: 'low',
          evaluatedAt: '2026-07-30T00:00:00.000Z',
          source: 'nexus-eval/v1',
        },
      ],
    });
    const out = (await tool('nexus_model_ranking').handler(
      { need: 'auditar autenticação e cobrança' },
      ctx(),
    )) as {
      need: { band: string; pick: { servedBand: string; degraded: boolean } };
    };
    expect(out.need.band).toBe('deep');
    expect(out.need.pick.servedBand).toBe('fast');
    expect(out.need.pick.degraded).toBe(true);
  });

  it('F-1230: faixas e pick saem do catálogo instalado, na linha mais nova', async () => {
    const row = (adapterId: string, modelId: string, security: number) => ({
      id: `${adapterId}/${modelId}`,
      adapterId,
      modelId,
      overall: security,
      security,
      costTier: 'high',
      evaluatedAt: '2026-07-30T00:00:00.000Z',
      source: 'nexus-eval/fixtures',
      estimate: true,
    });
    rankingMocks.getPublicModelRanking.mockReturnValue({
      ...ranking,
      entries: [
        row('codex', 'gpt-5.6-luna', 95),
        row('kimi', 'kimi-k2.8', 94),
        row('grok', 'grok-4.6', 93),
        row('claude', 'claude-sonnet-5', 92),
        // O score do próprio modelo novo vence o herdado do velho.
        row('claude', 'claude-sonnet-5-5', 80),
        row('agy', 'gemini-3.8-flash-high', 91),
        row('opencode', 'glm-5', 90),
        row('codex', 'gpt-4.1-mini', 89),
      ],
    });
    const adapter = (id: string, list: string[], installed = true) => ({
      id,
      kind: 'cli-pty',
      label: id,
      models: { list, default: list[0], info: {} },
      installed,
    });
    adapterMocks.listAdapterInfos.mockReturnValue([
      adapter('codex', ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-luna']),
      adapter('grok', ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6']),
      adapter('kimi', ['kimi-code/k3', 'kimi-code/kimi-for-coding']),
      adapter('claude', ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5']),
      adapter('agy', ['gemini-3.8-flash-high']),
      adapter('opencode', ['glm-5'], false),
    ]);
    providerMocks.listProviderSettings.mockReturnValue([
      { adapterId: 'agy', enabled: false },
    ]);

    const out = (await tool('nexus_model_ranking').handler(
      { need: 'revisão sênior de segurança em código TypeScript', dimension: 'security' },
      ctx(),
    )) as {
      bands: { deep: Array<{ id: string; upgradedFrom?: string }> };
      need: { band: string; pick: { id: string; upgradedFrom?: string } };
      entries: Array<{ id: string; score: number; estimate: boolean }>;
      installedCatalog: { applied: boolean; dropped: string[] };
    };

    expect(out.need.band).toBe('deep');
    expect(out.need.pick).toMatchObject({ id: 'codex/gpt-6-luna', upgradedFrom: 'gpt-5.6-luna' });
    // kimi-k2.8 é aposentado (migra para kimi-code/k3, instalado).
    expect(out.bands.deep.map((e) => [e.id, e.upgradedFrom])).toEqual([
      ['codex/gpt-6-luna', 'gpt-5.6-luna'],
      ['kimi/kimi-code/k3', 'kimi-k2.8'],
      ['grok/grok-4.7', 'grok-4.6'],
      ['claude/claude-sonnet-5-5', undefined],
    ]);
    expect(out.entries.find((e) => e.id === 'claude/claude-sonnet-5-5')).toMatchObject({
      score: 80,
    });
    expect(out.entries.every((e) => e.estimate)).toBe(true);
    // CLI desabilitada (agy), CLI não instalada (opencode) e modelo fora da
    // oferta da CLI (gpt-4.1-mini) não entram.
    expect(out.installedCatalog.applied).toBe(true);
    expect(out.installedCatalog.dropped).toEqual([
      'agy/gemini-3.8-flash-high',
      'opencode/glm-5',
      'codex/gpt-4.1-mini',
    ]);
  });

  it('F-1290: linha sem fixture mas com benchmark publicado entra como estimativa', async () => {
    const row = (adapterId: string, modelId: string, overall: number) => ({
      id: `${adapterId}/${modelId}`,
      adapterId,
      modelId,
      overall,
      coding: overall,
      costTier: 'high',
      availability: 'paid',
      evaluatedAt: '2026-09-13T00:00:00.000Z',
      source: 'nexus-eval/v1/fixture',
      estimate: true,
      sourceLabel: 'estimativa (fixture)',
    });
    // Fixture velha: do codex só luna e terra; do agy só o 3.8 — nenhuma
    // linha sol/astra/argon.
    rankingMocks.getPublicModelRanking.mockReturnValue({
      ...ranking,
      entries: [
        row('codex', 'gpt-5.6-luna', 71),
        row('codex', 'gpt-5.6-terra', 70),
        row('agy', 'gemini-3.8-flash-high', 72),
      ],
    });
    const adapter = (id: string, list: string[]) => ({
      id,
      kind: 'cli-pty',
      label: id,
      models: {
        list,
        default: list[0],
        info: Object.fromEntries(
          list.map((m) => [m, { costTier: 'high', availability: 'paid' }]),
        ),
      },
      installed: true,
    });
    adapterMocks.listAdapterInfos.mockReturnValue([
      adapter('codex', [
        'gpt-6.1-sol',
        'gpt-6-astra',
        'gpt-6-sol',
        'gpt-6-luna',
        'gpt-5.6-luna',
        'gpt-5.6-terra',
      ]),
      adapter('agy', ['gemini-4-argon', 'gemini-3.8-flash-high']),
    ]);
    providerMocks.listProviderSettings.mockReturnValue([]);

    const out = (await tool('nexus_model_ranking').handler(
      { dimension: 'overall' },
      ctx(),
    )) as {
      available: boolean;
      bands: Record<string, Array<{ id: string }>>;
      entries: Array<{ id: string; estimate: boolean; sourceLabel?: string }>;
    };

    expect(out.available).toBe(true);
    const banded = Object.values(out.bands).flat().map((e) => e.id);
    // Lift da linha (luna) + síntese de benchmark publicado (sol, astra, argon).
    for (const id of [
      'codex/gpt-6-luna',
      'codex/gpt-6.1-sol',
      'codex/gpt-6-astra',
      'agy/gemini-4-argon',
    ]) {
      expect(banded).toContain(id);
    }
    // Linha sem sucessor instalado continua listada (sem regressão).
    expect(banded).toContain('codex/gpt-5.6-terra');
    // Modelo mais novo sempre: a síntese nunca devolve a versão velha de uma
    // linha que tem sucessor instalado (o lift já trocou luna 5.6 → 6).
    for (const id of ['codex/gpt-6-sol', 'codex/gpt-5.6-luna']) {
      expect(out.entries.map((e) => e.id)).not.toContain(id);
    }
    // Síntese é estimativa com fonte, nunca número inventado como medição.
    for (const id of ['codex/gpt-6.1-sol', 'codex/gpt-6-astra', 'agy/gemini-4-argon']) {
      const entry = out.entries.find((e) => e.id === id);
      expect(entry?.estimate).toBe(true);
      expect(entry?.sourceLabel).toMatch(/benchmark publicado/);
    }
  });
});

describe('nexus_mcp_servers', () => {
  function writeHub(root: string, servers: unknown[]): void {
    fs.mkdirSync(path.join(root, '.nexus'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.nexus', 'mcp-hub.json'),
      JSON.stringify({ schemaVersion: 1, servers }),
    );
  }

  it('never emits secret values — only key names, command name and url host', async () => {
    const root = mkRoot();
    writeHub(root, [
      {
        id: 'srv-1',
        name: 'Firecrawl',
        transport: 'stdio',
        command: '/opt/homebrew/bin/npx',
        args: ['-y', 'firecrawl-mcp', '--token', 'tok-ARG-LEAK'],
        env: { FIRECRAWL_API_KEY: 'sk-live-SUPERSECRET', LOG_LEVEL: 'debug' },
        headers: { Authorization: 'Bearer tok-HEADER-LEAK' },
        url: 'https://hubuser:pAsSw0rdLEAK@mcp.example.com/sse?token=t-QUERY-LEAK',
        tools: ['scrape', 'search'],
        source: 'nexus',
      },
    ]);

    const result = await tool('nexus_mcp_servers').handler({}, ctx({}, root));
    const raw = JSON.stringify(result);

    for (const secret of [
      'sk-live-SUPERSECRET',
      'tok-ARG-LEAK',
      'tok-HEADER-LEAK',
      't-QUERY-LEAK',
      'pAsSw0rdLEAK',
      'hubuser',
      '[REDACTED]',
    ]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).toContain('FIRECRAWL_API_KEY');
    expect(raw).toContain('mcp.example.com');

    const out = result as {
      available: boolean;
      servers: Array<Record<string, unknown>>;
    };
    expect(out.available).toBe(true);
    expect(out.servers[0]).toMatchObject({
      id: 'srv-1',
      name: 'Firecrawl',
      transport: 'stdio',
      source: 'nexus',
      status: 'configured',
      commandName: 'npx',
      argCount: 4,
      urlHost: 'mcp.example.com',
      envKeys: ['FIRECRAWL_API_KEY', 'LOG_LEVEL'],
      headerKeys: ['Authorization'],
      toolCount: 2,
      tools: ['scrape', 'search'],
    });
  });

  it('never claims liveness — the hub health source is configuration only', async () => {
    const root = mkRoot();
    writeHub(root, []);
    const out = (await tool('nexus_mcp_servers').handler({}, ctx({}, root))) as {
      livenessProbed: boolean;
      livenessNote: string;
    };
    expect(out.livenessProbed).toBe(false);
    expect(out.livenessNote).toMatch(/does not probe/i);
  });

  it('answers honestly when the workspace has no hub config', async () => {
    const root = mkRoot();
    const out = (await tool('nexus_mcp_servers').handler({}, ctx({}, root))) as {
      available: boolean;
      configured: boolean;
      servers: unknown[];
      reason: string;
    };
    expect(out.available).toBe(true);
    expect(out.configured).toBe(false);
    expect(out.servers).toEqual([]);
    expect(out.reason).toMatch(/no .*mcp-hub\.json/i);
  });

  it('answers honestly when the config is replaced mid-call (TOCTOU stat race)', async () => {
    // `.nexus/mcp-hub.json` is written atomically (temp + rename), so between
    // an existsSync and an lstatSync the path is momentarily gone and the stat
    // throws ENOENT from outside every try — invariant 3 turned into a crash.
    // One stat that answers "absent" instead of throwing is the contract.
    const root = mkRoot();
    writeHub(root, []);
    const real = fs.lstatSync;
    const spy = vi
      .spyOn(fs, 'lstatSync')
      .mockImplementation(((target: string, options?: unknown) => {
        if (String(target).endsWith('mcp-hub.json')) {
          throw Object.assign(new Error('ENOENT: renamed under us'), {
            code: 'ENOENT',
          });
        }
        return (real as (t: unknown, o?: unknown) => unknown)(target, options);
      }) as unknown as typeof fs.lstatSync);
    try {
      const out = (await tool('nexus_mcp_servers').handler(
        {},
        ctx({}, root),
      )) as { available: boolean; configured: boolean; servers: unknown[] };
      expect(out.available).toBe(true);
      expect(out.configured).toBe(false);
      expect(out.servers).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('answers honestly when the hub config is corrupt', async () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, '.nexus'), { recursive: true });
    fs.writeFileSync(path.join(root, '.nexus', 'mcp-hub.json'), '{ not json');
    const out = (await tool('nexus_mcp_servers').handler({}, ctx({}, root))) as {
      available: boolean;
      reason: string;
      servers: unknown[];
    };
    expect(out.available).toBe(false);
    expect(out.servers).toEqual([]);
    expect(out.reason).toMatch(/unreadable|invalid/i);
  });

  it('answers honestly when the MCP Hub feature flag is off', async () => {
    flagMocks.isEnabled.mockReturnValue(false);
    const root = mkRoot();
    writeHub(root, []);
    const out = (await tool('nexus_mcp_servers').handler({}, ctx({}, root))) as {
      available: boolean;
      reason: string;
    };
    expect(out.available).toBe(false);
    expect(out.reason).toContain('feature.mcp.hub');
  });

  it('refuses a worker — third-party server topology is a fleet decision', async () => {
    const root = mkRoot();
    writeHub(root, []);
    await expect(
      tool('nexus_mcp_servers').handler(
        {},
        ctx({ role: 'worker', providerId: 'codex' }, root),
      ),
    ).rejects.toThrow(/orchestrator/i);
  });

  it('caps servers and per-server tool lists', async () => {
    const root = mkRoot();
    writeHub(
      root,
      Array.from({ length: 64 }, (_, i) => ({
        id: `s${i}`,
        name: `n${i}`,
        transport: 'stdio',
        command: 'node',
        tools: Array.from({ length: 100 }, (_, t) => `tool-${t}`),
        source: 'nexus',
      })),
    );
    const out = (await tool('nexus_mcp_servers').handler({}, ctx({}, root))) as {
      servers: Array<{ tools: string[]; toolCount: number }>;
    };
    expect(out.servers).toHaveLength(64);
    expect(out.servers[0].tools).toHaveLength(32);
    expect(out.servers[0].toolCount).toBe(100);
  });
});

describe('nexus_skills_inventory', () => {
  const home = os.homedir();
  const items = [
    {
      kind: 'skill',
      name: 'impeccable',
      file: path.join(home, '.claude', 'skills', 'impeccable'),
      size: 0,
      modifiedAt: 1_700_000_000_000,
    },
    {
      kind: 'agent',
      name: 'code-reviewer',
      file: path.join(home, '.claude', 'agents', 'code-reviewer.md'),
      size: 2_048,
      modifiedAt: 1_700_000_000_000,
    },
  ];

  it('lists installed skills without leaking absolute home paths', async () => {
    catalogMocks.listInstalledCatalogItems.mockReturnValue(items);
    const result = await tool('nexus_skills_inventory').handler({}, ctx());
    const raw = JSON.stringify(result);
    expect(raw).not.toContain(home);

    const out = result as {
      available: boolean;
      counts: { skill: number; agent: number };
      items: Array<Record<string, unknown>>;
    };
    expect(out.available).toBe(true);
    expect(out.counts).toEqual({ skill: 1, agent: 1 });
    expect(out.items).toEqual([
      {
        name: 'impeccable',
        kind: 'skill',
        source: '~/.claude/skills',
        sizeBytes: 0,
        modifiedAt: 1_700_000_000_000,
      },
    ]);
  });

  it('anota itens com tier/blurb/whenToUse do arsenal enriquecido quando existe', async () => {
    catalogMocks.listInstalledCatalogItems.mockReturnValue(items);
    enrichMocks.loadEnrichedCatalog.mockReturnValue({
      version: 1,
      updatedAt: 1_700_000_000_000,
      items: [
        {
          name: 'impeccable',
          kind: 'skill',
          tier: 'builder',
          blurb: 'Design e polimento de frontend',
          whenToUse: 'UI nova ou redesign',
        },
        // Mesmo nome, kind diferente: não pode vazar pro skill.
        { name: 'impeccable', kind: 'agent', tier: 'reviewer', blurb: 'outro' },
      ],
    });

    const out = (await tool('nexus_skills_inventory').handler({}, ctx())) as {
      items: Array<Record<string, unknown>>;
    };
    expect(out.items[0]).toMatchObject({
      name: 'impeccable',
      tier: 'builder',
      blurb: 'Design e polimento de frontend',
      whenToUse: 'UI nova ou redesign',
    });
  });

  it('sem catálogo enriquecido os itens saem sem anotação e nada quebra', async () => {
    catalogMocks.listInstalledCatalogItems.mockReturnValue(items);
    enrichMocks.loadEnrichedCatalog.mockReturnValue(null);

    const out = (await tool('nexus_skills_inventory').handler({}, ctx())) as {
      available: boolean;
      items: Array<Record<string, unknown>>;
    };
    expect(out.available).toBe(true);
    expect(out.items[0]).not.toHaveProperty('tier');
  });

  it('falha ao carregar o enriquecido degrada silenciosamente (inventário nunca cai)', async () => {
    catalogMocks.listInstalledCatalogItems.mockReturnValue(items);
    enrichMocks.loadEnrichedCatalog.mockImplementation(() => {
      throw new Error('disk corrupt');
    });

    const out = (await tool('nexus_skills_inventory').handler({}, ctx())) as {
      available: boolean;
    };
    expect(out.available).toBe(true);
  });

  it('F-1157: reports open skill access whatever the token recorded', async () => {
    catalogMocks.listInstalledCatalogItems.mockReturnValue(items);
    const out = (await tool('nexus_skills_inventory').handler(
      {},
      ctx({ role: 'worker', allowedSkills: ['impeccable', 'ponytail'] }),
    )) as { gate: { restricted: boolean; allowed: string[] | null } };
    expect(out.gate).toEqual({ restricted: false, allowed: null });
  });

  it('answers honestly when nothing is installed', async () => {
    catalogMocks.listInstalledCatalogItems.mockReturnValue([]);
    const out = (await tool('nexus_skills_inventory').handler({}, ctx())) as {
      available: boolean;
      reason: string;
      items: unknown[];
    };
    expect(out.available).toBe(false);
    expect(out.items).toEqual([]);
    expect(out.reason).toMatch(/no installed/i);
  });

  it('still answers when the OS cannot resolve a home directory', async () => {
    // `os.homedir()` is an OS lookup, it runs per item inside the projection,
    // and it does throw on a machine with no resolvable home. Invariant 3
    // forbids that becoming the exception that kills the whole consultation.
    catalogMocks.listInstalledCatalogItems.mockReturnValue(items);
    const spy = vi.spyOn(os, 'homedir').mockImplementation(() => {
      throw new Error('ENOENT: no home for this uid');
    });
    try {
      const out = (await tool('nexus_skills_inventory').handler({}, ctx())) as {
        available: boolean;
        items: Array<Record<string, unknown>>;
      };
      expect(out.available).toBe(true);
      expect(out.items).toHaveLength(1);
      expect(out.items[0]!.source).toBe('(outside home)');
    } finally {
      spy.mockRestore();
    }
  });

  it('answers honestly when the catalog scan throws', async () => {
    catalogMocks.listInstalledCatalogItems.mockImplementation(() => {
      throw new Error('EACCES scanning skills');
    });
    const out = (await tool('nexus_skills_inventory').handler({}, ctx())) as {
      available: boolean;
      reason: string;
    };
    expect(out.available).toBe(false);
    expect(out.reason).toContain('EACCES scanning skills');
  });

  it('caps the item list', async () => {
    catalogMocks.listInstalledCatalogItems.mockReturnValue(
      Array.from({ length: 500 }, (_, i) => ({
        kind: 'skill',
        name: `skill-${i}`,
        file: path.join(home, '.claude', 'skills', `skill-${i}`),
        size: 1,
        modifiedAt: 1,
      })),
    );
    const out = (await tool('nexus_skills_inventory').handler(
      { limit: 9_000 },
      ctx(),
    )) as { items: unknown[]; truncated: boolean };
    expect(out.items).toHaveLength(200);
    expect(out.truncated).toBe(true);
  });
});

describe('nexus_cli_inventory', () => {
  const adapters = [
    {
      id: 'claude',
      kind: 'cli-pty',
      label: 'Claude Code',
      icon: 'C',
      models: { list: ['opus', 'sonnet'], default: 'sonnet' },
      installed: true,
      resolvedBinPath: '/Users/SECRETUSER/.bun/bin/claude',
      installCommand: 'npm i -g @anthropic-ai/claude-code',
      idleTimeoutMs: 1_000,
      orchestratorCapable: true,
      orchestrationEvidence: 'verified',
      taskHandoffCapable: true,
    },
    {
      id: 'shell',
      kind: 'cli-pty',
      label: 'Shell',
      icon: 'S',
      models: { list: [], default: '' },
      installed: true,
      installCommand: '',
      idleTimeoutMs: 1_000,
      orchestratorCapable: false,
    },
  ];

  const providers = [
    {
      adapterId: 'claude',
      label: 'Claude Code',
      icon: 'C',
      kind: 'cli-pty',
      enabled: true,
      installed: true,
      canAutoInstall: true,
      binPath: '/Users/SECRETUSER/.bun/bin/claude',
      detectedBin: '/Users/SECRETUSER/.bun/bin/claude',
      defaultModel: 'sonnet',
      models: ['opus', 'sonnet'],
      authReadyModels: ['sonnet'],
      extraArgs: [],
      keyEnvVar: 'ANTHROPIC_API_KEY',
      hasKey: true,
      keyMasked: 'sk-…4a2fSECRET',
      authMethod: 'subscription',
      secureStorageAvailable: true,
      authStrategy: 'subscription',
      upstream: 'anthropic',
    },
  ];

  it('never emits binary paths, key previews or key env var names', async () => {
    adapterMocks.listAdapterInfos.mockReturnValue(adapters);
    providerMocks.listProviderSettings.mockReturnValue(providers);
    const raw = JSON.stringify(
      await tool('nexus_cli_inventory').handler({}, ctx()),
    );
    for (const secret of [
      'SECRETUSER',
      '/Users/',
      'sk-…4a2fSECRET',
      '4a2f',
      'ANTHROPIC_API_KEY',
    ]) {
      expect(raw).not.toContain(secret);
    }
  });

  it('F-790: reports duplicate versions and the selected version without paths', async () => {
    const cliInstallationWarning = '2 instalações: 0.146.0 e 0.160.0; usando 0.160.0';
    adapterMocks.listAdapterInfos.mockReturnValue([{ ...adapters[0], cliInstallationWarning }]);
    providerMocks.listProviderSettings.mockReturnValue(providers);
    const out = await tool('nexus_cli_inventory').handler({}, ctx()) as { clis: Array<Record<string, unknown>> };
    expect(out.clis[0].cliInstallationWarning).toBe(cliInstallationWarning);
    expect(JSON.stringify(out)).not.toContain('/Users/');
  });

  it('merges install status with auth readiness in decision shape', async () => {
    adapterMocks.listAdapterInfos.mockReturnValue(adapters);
    providerMocks.listProviderSettings.mockReturnValue(providers);
    const out = (await tool('nexus_cli_inventory').handler({}, ctx())) as {
      available: boolean;
      authSource: string;
      clis: Array<Record<string, unknown>>;
    };
    expect(out.available).toBe(true);
    expect(out.authSource).toBe('provider-settings');
    expect(out.clis[0]).toEqual({
      adapterId: 'claude',
      label: 'Claude Code',
      kind: 'cli-pty',
      installed: true,
      binaryResolved: true,
      enabled: true,
      authStrategy: 'subscription',
      hasStoredKey: true,
      authReadyModelCount: 1,
      defaultModel: 'sonnet',
      modelCount: 2,
      models: ['opus', 'sonnet'],
      orchestratorCapable: true,
      orchestrationEvidence: 'verified',
      taskHandoffCapable: true,
      missionControlCapable: false,
      autonomousWorkspaceWriteCapable: false,
      installCommand: 'npm i -g @anthropic-ai/claude-code',
    });
  });

  it('degrades honestly when the auth source is unavailable', async () => {
    adapterMocks.listAdapterInfos.mockReturnValue(adapters);
    providerMocks.listProviderSettings.mockImplementation(() => {
      throw new Error('keychain locked');
    });
    const out = (await tool('nexus_cli_inventory').handler({}, ctx())) as {
      available: boolean;
      authSource: string;
      reason: string;
      clis: Array<{ authStrategy: string | null }>;
    };
    expect(out.available).toBe(true);
    expect(out.authSource).toBe('unavailable');
    expect(out.reason).toContain('keychain locked');
    expect(out.clis[0].authStrategy).toBeNull();
  });

  it('answers honestly when no adapter is known', async () => {
    adapterMocks.listAdapterInfos.mockReturnValue([]);
    const out = (await tool('nexus_cli_inventory').handler({}, ctx())) as {
      available: boolean;
      reason: string;
      clis: unknown[];
    };
    expect(out.available).toBe(false);
    expect(out.clis).toEqual([]);
    expect(out.reason).toMatch(/no cli adapter/i);
  });

  it('refuses a worker — fleet auth posture is an orchestrator decision', async () => {
    adapterMocks.listAdapterInfos.mockReturnValue(adapters);
    await expect(
      tool('nexus_cli_inventory').handler(
        {},
        ctx({ role: 'worker', providerId: 'claude' }),
      ),
    ).rejects.toThrow(/orchestrator/i);
  });

  it('caps clis and per-cli model lists', async () => {
    adapterMocks.listAdapterInfos.mockReturnValue(
      Array.from({ length: 200 }, (_, i) => ({
        id: `a${i}`,
        kind: 'cli-pty',
        label: `A${i}`,
        icon: 'x',
        models: {
          list: Array.from({ length: 100 }, (_, m) => `m${m}`),
          default: 'm0',
        },
        installed: true,
        installCommand: '',
        idleTimeoutMs: 1,
        orchestratorCapable: false,
      })),
    );
    const out = (await tool('nexus_cli_inventory').handler({}, ctx())) as {
      clis: Array<{ models: string[]; modelCount: number }>;
      truncated: boolean;
    };
    expect(out.clis).toHaveLength(64);
    expect(out.clis[0].models).toHaveLength(24);
    expect(out.clis[0].modelCount).toBe(100);
    expect(out.truncated).toBe(true);
  });
});
