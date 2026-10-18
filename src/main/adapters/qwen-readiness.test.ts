import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  probeQwenCredential,
  QWEN_INVALID_CREDENTIAL_MESSAGE,
} from './qwen-readiness';

const tempDirs: string[] = [];
beforeEach(() => {
  for (const name of ['BAILIAN_TOKEN_PLAN_API_KEY', 'DASHSCOPE_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']) vi.stubEnv(name, '');
  vi.stubEnv('QWEN_HOME', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-qwen-probe-'));
  tempDirs.push(dir);
  return dir;
}

function writeSettings(home: string, settings: unknown): void {
  const dir = path.join(home, '.qwen');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
}

const okFetch = async () => ({ status: 200 });

describe('probeQwenCredential (F-238)', () => {
  it('does not send an unrelated OpenAI key to the default Alibaba endpoint', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'unrelated-openai-key');
    vi.stubEnv('OPENAI_BASE_URL', '');
    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    expect((await probeQwenCredential({ home: tempHome(), fetchImpl })).state).toBe('no-credential');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('uses the selected provider env key before deprecated auth fields, with shell env over settings env', async () => {
    const home = tempHome();
    writeSettings(home, { model: { name: 'qwen3.8-max' }, env: { SELECTED_QWEN_KEY: 'settings-key' },
      modelProviders: { openai: [{ id: 'qwen3.8-max', envKey: 'SELECTED_QWEN_KEY', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }] },
      security: { auth: { selectedType: 'openai', apiKey: 'deprecated-key' } } });
    vi.stubEnv('SELECTED_QWEN_KEY', 'shell-key');
    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    await probeQwenCredential({ home, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: { authorization: 'Bearer shell-key' } }));
  });
  it('does not treat an upstream failure as accepted credentials', async () => {
    const result = await probeQwenCredential({ home: tempHome(), key: 'fixture', fetchImpl: async () => ({ status: 503 }) });
    expect(result.state).toBe('unknown');
  });
  it('never follows credential-bearing redirects or probes an untrusted endpoint', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    await probeQwenCredential({ home: tempHome(), key: 'fixture', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'error' }));
    fetchImpl.mockClear();
    expect((await probeQwenCredential({ home: tempHome(), key: 'fixture', baseUrl: 'https://attacker.invalid/v1', fetchImpl })).state).toBe('unknown');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('reads the selected modern OpenAI-compatible auth configuration', async () => {
    const home = tempHome();
    writeSettings(home, { security: { auth: { selectedType: 'openai', apiKey: 'selected-key',
      baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1' } } });
    const fetchImpl = vi.fn(async () => ({ status: 401 }));
    expect((await probeQwenCredential({ home, fetchImpl })).state).toBe('invalid-credential');
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('token-plan.'),
      expect.objectContaining({ headers: { authorization: 'Bearer selected-key' } }));
  });
  it('sem credencial nenhuma → no-credential, sem fetch', async () => {
    const home = tempHome();
    const fetchImpl = vi.fn(okFetch);
    const result = await probeQwenCredential({ home, fetchImpl });
    expect(result.state).toBe('no-credential');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('401 → invalid-credential com a mensagem do Token Plan', async () => {
    const home = tempHome();
    const fetchImpl = vi.fn(async () => ({ status: 401 }));
    const result = await probeQwenCredential({
      home,
      key: 'fixture-key',
      fetchImpl,
    });
    expect(result.state).toBe('invalid-credential');
    expect(result.detail).toBe(QWEN_INVALID_CREDENTIAL_MESSAGE);
  });

  it('usa o baseUrl do settings e manda o Bearer da settings em memória', async () => {
    const home = tempHome();
    writeSettings(home, {
      model: {
        baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      },
      env: { BAILIAN_TOKEN_PLAN_API_KEY: 'fixture-settings-key' },
    });
    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    const result = await probeQwenCredential({ home, fetchImpl });
    expect(result.state).toBe('present');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { authorization: 'Bearer fixture-settings-key' },
      }),
    );
  });

  it('falha de rede → unknown (nunca bloqueia)', async () => {
    const home = tempHome();
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await probeQwenCredential({
      home,
      key: 'fixture-key',
      fetchImpl,
    });
    expect(result.state).toBe('unknown');
  });

  it('200 → present', async () => {
    const home = tempHome();
    const result = await probeQwenCredential({
      home,
      key: 'fixture-key',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      fetchImpl: okFetch,
    });
    expect(result.state).toBe('present');
  });

  it('baseUrl não-https → unknown sem fetch', async () => {
    const home = tempHome();
    const fetchImpl = vi.fn(okFetch);
    const result = await probeQwenCredential({
      home,
      key: 'fixture-key',
      baseUrl: 'http://example.com/v1',
      fetchImpl,
    });
    expect(result.state).toBe('unknown');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('F-1565: a sonda testa o mesmo par chave+base URL que o pane usa', () => {
  const PLAN = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
  const DASH = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

  it('chave sk-sp- configurada + settings com baseUrl DashScope → sonda vai à URL exclusiva do plano', async () => {
    const home = tempHome();
    writeSettings(home, {
      security: { auth: { selectedType: 'openai', apiKey: 'sk-sp-VELHA-EMBUTIDA', baseUrl: DASH } },
      model: { name: 'qwen3.8-max' },
    });
    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    const result = await probeQwenCredential({ home, key: 'sk-sp-NOVA-DO-COFRE', fetchImpl });
    expect(result.state).toBe('present');
    expect(fetchImpl).toHaveBeenCalledWith(
      `${PLAN}/models`,
      expect.objectContaining({ headers: { authorization: 'Bearer sk-sp-NOVA-DO-COFRE' } }),
    );
  });

  it('chave sk-sp- sem settings nenhum → URL do plano (nunca o padrão DashScope)', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    await probeQwenCredential({ home: tempHome(), key: 'sk-sp-fixture', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(`${PLAN}/models`, expect.anything());
  });

  it('a base URL configurada em Providers › Qwen vence o settings', async () => {
    const home = tempHome();
    writeSettings(home, { security: { auth: { selectedType: 'openai', baseUrl: DASH } } });
    const { setQwenProbeConfiguredBaseUrlLookup } = await import('./qwen-readiness');
    setQwenProbeConfiguredBaseUrlLookup(() => PLAN);
    try {
      const fetchImpl = vi.fn(async () => ({ status: 200 }));
      await probeQwenCredential({ home, key: 'sk-fixture-padrao', fetchImpl });
      expect(fetchImpl).toHaveBeenCalledWith(`${PLAN}/models`, expect.anything());
    } finally {
      setQwenProbeConfiguredBaseUrlLookup(null);
    }
  });

  it('A1: base URL de host desconhecido no settings não é o destino da sonda — vai à URL do plano, como o pane', async () => {
    const home = tempHome();
    writeSettings(home, {
      security: { auth: { selectedType: 'openai', baseUrl: 'https://attacker.test/compatible-mode/v1' } },
      model: { name: 'qwen3.8-max' },
    });
    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    const result = await probeQwenCredential({ home, key: 'sk-sp-NOVA-DO-COFRE', fetchImpl });
    expect(result.state).toBe('present');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(`${PLAN}/models`, expect.anything());
  });

  it('N3: JSONC com BOM preserva o Token Plan de Pequim na sonda', async () => {
    const home = tempHome();
    const dir = path.join(home, '.qwen');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      '\uFEFF// perfil\n{ "security": { "auth": { "baseUrl": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", }, }, }',
    );
    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    expect((await probeQwenCredential({ home, key: 'sk-sp-fixture', fetchImpl })).state).toBe('present');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models',
      expect.anything(),
    );
  });

  it('401/403 diz chave inválida ou base URL incompatível — nunca limite/cota', async () => {
    const result = await probeQwenCredential({
      home: tempHome(),
      key: 'sk-sp-fixture',
      fetchImpl: async () => ({ status: 401 }),
    });
    expect(result.state).toBe('invalid-credential');
    expect(result.detail).toContain('base URL incompatível');
    expect(result.detail).not.toMatch(/cota|limite de uso/i);
  });
});
