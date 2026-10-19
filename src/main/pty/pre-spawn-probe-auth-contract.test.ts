import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_AUTH_ADAPTER_IDS,
  type FileAuthAdapterId,
} from '../../shared/file-auth-adapters';
import {
  detectSubscriptionAuth,
  hasSubscriptionAuth,
  resolveAuthStrategy,
  type SubscriptionAuthDetectionOptions,
} from '../adapters/subscription-auth';
import {
  PRODUCTION_PROBE_DEPS,
  clearRecentCredentialProbeFailuresForTests,
  probePreSpawn,
  type PreSpawnProbeDeps,
} from './pre-spawn-probe';

const traceMock = vi.hoisted(() => vi.fn());
vi.mock('../observability/main-trace', () => ({ trace: traceMock }));

const homes: string[] = [];
const detectionOptions: SubscriptionAuthDetectionOptions = {
  probeAgyKeychain: false,
  probeOpenClaudeKeychain: false,
  museKeychainProbe: () => false,
};

type Fixture = {
  readonly adapterId: FileAuthAdapterId;
  readonly model?: string;
  readonly ready: boolean;
  readonly options?: SubscriptionAuthDetectionOptions;
  readonly setup: (home: string) => void;
};

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-probe-auth-contract-'));
  homes.push(home);
  for (const [name, value] of Object.entries({
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    GROK_HOME: path.join(home, '.grok'),
    KIMI_CODE_HOME: path.join(home, '.kimi-code'),
    OPENCODE_HOME: path.join(home, '.opencode'),
    OPENCLAUDE_CONFIG_DIR: path.join(home, '.openclaude'),
    GEMINI_CLI_HOME: path.join(home, '.gemini'),
    MIMOCODE_HOME: home,
    MINIMAX_DATA_DIR: path.join(home, '.minimax'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    MUSE_AUTH_PATH: path.join(home, '.config', 'muse', 'auth.json'),
  })) vi.stubEnv(name, value);
  return home;
}

function write(home: string, relative: string, contents: unknown): void {
  const file = path.join(home, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
}

function muse(providers: Record<string, unknown>): string {
  return JSON.stringify({ schema_version: 2, providers: { meta: providers } });
}

const fixtures: readonly Fixture[] = [
  { adapterId: 'codex', ready: true, setup: (home) => write(home, '.codex/auth.json', { tokens: { access_token: 'fixture' } }) },
  { adapterId: 'grok', ready: true, setup: (home) => write(home, '.grok/auth.json', { key: 'fixture' }) },
  { adapterId: 'kimi', ready: true, setup: (home) => write(home, '.kimi-code/credentials/kimi-code.json', { access_token: 'fixture', refresh_token: 'fixture', expires_at: 1_700_000_000 }) },
  { adapterId: 'opencode', ready: true, model: 'openrouter/openai/gpt-5', setup: (home) => write(home, '.opencode/auth.json', { key: 'fixture' }) },
  { adapterId: 'mimo-code', ready: true, model: 'xiaomi/mimo-v2.6-pro', setup: (home) => write(home, 'data/auth.json', { xiaomi: { type: 'api', key: 'fixture', metadata: { uid: 'fixture', base_url: 'https://api.xiaomimimo.com/v1' } } }) },
  { adapterId: 'agy', ready: true, setup: (home) => write(home, '.gemini/oauth_creds.json', { access_token: 'fixture' }) },
  { adapterId: 'openclaude', ready: true, setup: (home) => write(home, '.openclaude/.credentials.json', { claudeAiOauth: { accessToken: 'fixture' } }) },
  { adapterId: 'minimax-code', ready: true, setup: (home) => write(home, '.minimax/auth/prod/en/mcode-public/auth-state.json', { status: 'authenticated' }) },
  { adapterId: 'muse', ready: true, setup: (home) => write(home, '.config/muse/auth.json', muse({ mechanism: 'oauth', storage: 'file', access_token: 'fixture' })) },
  { adapterId: 'muse', ready: true, setup: (home) => write(home, '.config/muse/auth.json', muse({ mechanism: 'api_key', storage: 'file', api_key: 'fixture' })) },
  { adapterId: 'muse', ready: true, options: { ...detectionOptions, museKeychainProbe: () => true }, setup: (home) => write(home, '.config/muse/auth.json', muse({ mechanism: 'oauth', storage: 'keychain' })) },
  { adapterId: 'muse', ready: false, setup: (home) => write(home, '.config/muse/auth.json', muse({ mechanism: 'oauth', storage: 'keychain' })) },
  { adapterId: 'devin', ready: true, setup: (home) => write(home, '.local/share/devin/credentials.toml', 'token = "fixture"\n') },
];

async function expectProbeUiRoute(fixture: Fixture): Promise<void> {
  const home = tempHome();
  fixture.setup(home);
  const options = fixture.options ?? detectionOptions;
  const ui = detectSubscriptionAuth(fixture.adapterId, home, fixture.model, options);
  const route = resolveAuthStrategy({
    authMethod: 'oauth',
    hasStoredKey: false,
    subscriptionAuthed: ui,
  }).strategy;
  const deps: PreSpawnProbeDeps = {
    getAdapter: () => ({
      kind: 'cli-pty',
      auth: { method: 'oauth' },
      models: fixture.model ? { default: fixture.model } : {},
    }),
    listAccounts: () => [],
    hasStoredKey: () => false,
    readActiveClaudeCredential: () => null,
    readClaudeCredentialsFile: () => null,
    claudeOauthEmail: () => null,
    nativeSessionReady: (adapterId, model) =>
      detectSubscriptionAuth(adapterId, home, model, options),
    authStrategy: () => route,
    kimiSeatReadiness: () => fixture.ready ? 'present' : 'no-credential',
  };
  const failure = await probePreSpawn(fixture.adapterId, {
    deps,
    model: fixture.model,
  });
  expect({
    ui,
    route,
    probe: failure?.code ?? null,
  }, `${fixture.adapterId} (${fixture.model ?? 'default'})`).toEqual(fixture.ready
    ? { ui: true, route: 'subscription', probe: null }
    : { ui: false, route: 'login-needed', probe: 'missing-credential' });
}

afterEach(() => {
  vi.unstubAllEnvs();
  traceMock.mockClear();
  while (homes.length > 0) {
    fs.rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

describe('pre-spawn probe — contrato único de prontidão nativa', () => {
  it('a fiação de produção usa exatamente a função de auth da UI/rota', () => {
    expect(PRODUCTION_PROBE_DEPS.nativeSessionReady).toBe(hasSubscriptionAuth);
  });

  it('cobre todos os adapters file-auth e seus formatos conhecidos', async () => {
    expect(new Set(fixtures.map((fixture) => fixture.adapterId))).toEqual(
      new Set(FILE_AUTH_ADAPTER_IDS),
    );
    for (const fixture of fixtures) await expectProbeUiRoute(fixture);
  });

  it('sem sessão, probe, UI e rota também concordam para cada adapter', async () => {
    for (const adapterId of FILE_AUTH_ADAPTER_IDS) {
      await expectProbeUiRoute({ adapterId, ready: false, setup: () => {} });
    }
  });

  it('probe-divergence informa o login divergente e o caminho do auth', async () => {
    // A checagem de divergência roda no máximo a cada 10 min por CLI.
    clearRecentCredentialProbeFailuresForTests();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const failure = await probePreSpawn('muse', {
        deps: {
          getAdapter: () => ({ kind: 'cli-pty', auth: { method: 'oauth' } }),
          listAccounts: () => [],
          hasStoredKey: () => false,
          readActiveClaudeCredential: () => null,
          readClaudeCredentialsFile: () => null,
          claudeOauthEmail: () => null,
          nativeSessionReady: () => true,
          authStrategy: () => 'login-needed',
        },
      });
      expect(failure?.hint).toContain('credencial recusada pelo probe, mas a UI mostra login');
      expect(failure?.hint).toContain('~/.config/muse/auth.json');
      expect(failure?.hint).toContain('ai.meta.dev.credentials/meta');
      expect(traceMock).toHaveBeenCalledWith({ kind: 'probe-divergence', adapterId: 'muse' });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('[probe-divergence] muse'));
    } finally {
      warning.mockRestore();
    }
  });
});
