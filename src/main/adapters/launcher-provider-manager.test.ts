import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildProviderRoutingEnv,
  getUpstreamProvider,
  listUpstreamProviders,
  loadLauncherProviderBaseUrl,
  loadLauncherProviderKey,
  setLauncherProvidersFileForTests,
  upstreamAllowedForAdapter,
  UPSTREAM_PROVIDERS,
} from './launcher-provider-manager';

describe('launcher provider routing (ported from ~/ai-launcher)', () => {
  it('exposes the canonical provider table', () => {
    const ids = listUpstreamProviders().map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'anthropic',
        'glm',
        'sakana',
        'openrouter',
        'deepseek',
        'ollama',
        'lmstudio',
        'litellm',
      ]),
    );
  });

  it('keeps the exact GLM/Z.ai base URL and routing env', () => {
    expect(UPSTREAM_PROVIDERS.glm.baseUrl).toBe('https://api.z.ai/api/anthropic');
    const env = buildProviderRoutingEnv('glm', 'zai-token');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('zai-token');
    // Extra env ported verbatim from PROVIDER_EXTRA_ENV[glm].
    expect(env.API_TIMEOUT_MS).toBe('600000');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.3-flash[1m]');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.3[1m]');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.3[1m]');
    // Third parties use AUTH_TOKEN, never API_KEY.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('routes glm-flash like `ai gf`: same z.ai host, every model slot on Flash', () => {
    const provider = getUpstreamProvider('glm-flash');
    expect(provider?.baseUrl).toBe('https://api.z.ai/api/anthropic');
    expect(provider?.requiresToken).toBe(true);
    const env = buildProviderRoutingEnv('glm-flash', 'zai-token');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('zai-token');
    // glm_flash_setup_env pinna os quatro slots + o modelo da sessão.
    expect(env.ANTHROPIC_MODEL).toBe('glm-5.3-flash[1m]');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.3-flash[1m]');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.3-flash[1m]');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.3-flash[1m]');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    // Sem token a rota falha fechada como os demais upstreams com token.
    expect(buildProviderRoutingEnv('glm-flash', null)).toEqual({});
  });

  it('returns no routing env for native anthropic', () => {
    expect(buildProviderRoutingEnv('anthropic', 'x')).toEqual({});
  });

  it('routes the Xiaomi API through its current Anthropic endpoint and V2.6 models', () => {
    const env = buildProviderRoutingEnv('mimo', 'sk-mimo-fixture');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.xiaomimimo.com/anthropic');
    expect(UPSTREAM_PROVIDERS.mimo.defaultModel).toBe('mimo-v2.6-pro');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('mimo-v2.6-pro');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('mimo-v2.6-pro');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('mimo-v2.6-flash');
  });

  it('routes MiniMax through the stable Anthropic model without disabling thinking', () => {
    const env = buildProviderRoutingEnv('minimax', 'sk-minimax-fixture');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.minimax.io/anthropic');
    expect(UPSTREAM_PROVIDERS.minimax.defaultModel).toBe('MiniMax-M3.1-Flash');
    for (const slot of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']) {
      expect(env[slot]).toBe('MiniMax-M3.1-Flash');
      expect(env[slot]).not.toContain('[1m]');
    }
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000');
    expect(JSON.stringify(env)).not.toMatch(/thinking.*disabled/i);
  });

  it('refuses to route a token-required provider without a token', () => {
    expect(buildProviderRoutingEnv('glm', null)).toEqual({});
    expect(buildProviderRoutingEnv('sakana', null)).toEqual({});
  });

  it('routes local providers without a token', () => {
    const env = buildProviderRoutingEnv('ollama', null);
    expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:11434');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('gives OpenRouter both the auth token and its own key var', () => {
    const env = buildProviderRoutingEnv('openrouter', 'or-key');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('or-key');
    expect(env.OPENROUTER_API_KEY).toBe('or-key');
  });

  it('returns null for an unknown provider', () => {
    expect(getUpstreamProvider('nope')).toBeNull();
    expect(buildProviderRoutingEnv('nope', 'x')).toEqual({});
  });

  it('F-724: DeepSeek pelo Token Plan aponta o endpoint Anthropic do plano com todos os slots no v4-pro', () => {
    const env = buildProviderRoutingEnv('deepseek-token-plan', 'sk-sp-fixture');
    expect(env.ANTHROPIC_BASE_URL).toBe(
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
    );
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-sp-fixture');
    for (const slot of [
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
    ]) {
      expect(env[slot]).toBe('deepseek-v4-pro');
    }
    // O plano dá 403 no flash e nunca serve Qwen por este caminho.
    expect(Object.values(env).join(' ')).not.toMatch(/flash|qwen/);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(buildProviderRoutingEnv('deepseek-token-plan', null)).toEqual({});
    // A API direta continua idêntica.
    expect(buildProviderRoutingEnv('deepseek', 'sk-direct').ANTHROPIC_BASE_URL).toBe(
      'https://api.deepseek.com/anthropic',
    );
  });

  it('F-724: a rota do Token Plan é só do adapter deepseek', () => {
    expect(listUpstreamProviders().map((p) => p.id)).not.toContain('deepseek-token-plan');
    expect(upstreamAllowedForAdapter('deepseek', 'deepseek-token-plan')).toBe(true);
    expect(upstreamAllowedForAdapter('claude', 'deepseek-token-plan')).toBe(false);
    expect(upstreamAllowedForAdapter('claude', 'glm')).toBe(true);
    expect(upstreamAllowedForAdapter('claude', 'nope')).toBe(true);
  });
});

describe('loadLauncherProviderKey (ai-launcher providers.conf bridge)', () => {
  let tmpDir = '';
  let conf = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-launcher-keys-'));
    conf = path.join(tmpDir, 'providers.conf');
  });

  afterEach(() => {
    setLauncherProvidersFileForTests(null);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup races
    }
  });

  it('reads glm=… the same way the launcher does', () => {
    fs.writeFileSync(conf, 'glm=zai-secret-token-abc\nsakana=sakana-key\n', {
      mode: 0o600,
    });
    setLauncherProvidersFileForTests(conf);
    expect(loadLauncherProviderKey('glm')).toBe('zai-secret-token-abc');
    expect(loadLauncherProviderKey('sakana')).toBe('sakana-key');
    expect(loadLauncherProviderKey('openrouter')).toBeNull();
  });

  it('accepts zai alias for the glm credential slot', () => {
    fs.writeFileSync(conf, 'zai=from-alias\n', { mode: 0o600 });
    setLauncherProvidersFileForTests(conf);
    expect(loadLauncherProviderKey('glm')).toBe('from-alias');
  });

  it('shares the glm credential slot with glm-flash (own key wins first)', () => {
    fs.writeFileSync(conf, 'glm=zai-shared\n', { mode: 0o600 });
    setLauncherProvidersFileForTests(conf);
    expect(loadLauncherProviderKey('glm-flash')).toBe('zai-shared');
    fs.writeFileSync(conf, 'glm-flash=dedicated\nglm=zai-shared\n', {
      mode: 0o600,
    });
    setLauncherProvidersFileForTests(conf);
    expect(loadLauncherProviderKey('glm-flash')).toBe('dedicated');
  });

  it('rejects invalid provider names and missing files', () => {
    setLauncherProvidersFileForTests(path.join(tmpDir, 'does-not-exist.conf'));
    expect(loadLauncherProviderKey('glm')).toBeNull();
    expect(loadLauncherProviderKey('../evil')).toBeNull();
    expect(loadLauncherProviderKey('')).toBeNull();
    expect(loadLauncherProviderBaseUrl('deepseek')).toBeNull();
  });

  it('F-724: lê o endpoint que o launcher amarra ao slot (`<id>-base-url`)', () => {
    fs.writeFileSync(
      conf,
      'deepseek=sk-sp-fixture\n' +
        'deepseek-base-url=https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic\n' +
        'glm=zai\n',
      { mode: 0o600 },
    );
    setLauncherProvidersFileForTests(conf);
    expect(loadLauncherProviderBaseUrl('deepseek')).toBe(
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
    );
    expect(loadLauncherProviderBaseUrl('glm')).toBeNull();
    expect(loadLauncherProviderBaseUrl('../evil')).toBeNull();
  });
});
