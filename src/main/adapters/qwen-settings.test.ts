import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mergeQwenSettingsForInjection,
  mergeQwenSystemSettingsForInjection,
  qwenSettingsHasCredential,
  qwenSystemSettingsPaths,
  readQwenOperatorSettings,
  readQwenSettingsSummary,
  readQwenSettingsSummaryAsync,
  readQwenSystemSettings,
  resolveQwenInjectionBaseUrl,
} from './qwen-settings';

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-qwen-settings-'));
  tempDirs.push(dir);
  return dir;
}

function writeSettings(home: string, settings: unknown): void {
  const dir = path.join(home, '.qwen');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
}

describe('readQwenSettingsSummary (F-238)', () => {
  it('sem settings.json → sem credencial, sem catálogo', () => {
    const home = tempHome();
    expect(readQwenSettingsSummary(home)).toEqual({
      hasCredential: false,
      baseUrl: null,
      authBaseUrl: null,
      tokenPlan: false,
      modelIds: [],
    });
    expect(qwenSettingsHasCredential(home)).toBe(false);
  });

  it('settings ilegível (JSON quebrado) → sem credencial', () => {
    const home = tempHome();
    const dir = path.join(home, '.qwen');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), '{not json');
    expect(readQwenSettingsSummary(home).hasCredential).toBe(false);
  });

  it('env.BAILIAN_TOKEN_PLAN_API_KEY conta como credencial presente', () => {
    const home = tempHome();
    writeSettings(home, {
      env: { BAILIAN_TOKEN_PLAN_API_KEY: 'fixture-secret-key' },
      model: { name: 'qwen3.8-max' },
    });
    const summary = readQwenSettingsSummary(home);
    expect(summary.hasCredential).toBe(true);
    expect(qwenSettingsHasCredential(home)).toBe(true);
    // O resumo nunca carrega o valor do segredo.
    expect(JSON.stringify(summary)).not.toContain('fixture-secret-key');
  });

  it('envKey de modelo resolve credencial via env do processo', () => {
    const home = tempHome();
    writeSettings(home, {
      modelProviders: {
        openai: [{ id: 'qwen3.8-max', envKey: 'QWEN_TEST_ENVKEY' }],
      },
    });
    expect(readQwenSettingsSummary(home).hasCredential).toBe(false);
    vi.stubEnv('QWEN_TEST_ENVKEY', 'fixture-envkey-value');
    expect(readQwenSettingsSummary(home).hasCredential).toBe(true);
  });

  it('catálogo lê modelProviders.*[].id — só ids qwen* fora do Token Plan', () => {
    const home = tempHome();
    writeSettings(home, {
      model: {
        name: 'qwen3.8-max',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      },
      modelProviders: {
        openai: [
          { id: 'qwen3.8-max' },
          { id: 'qwen3.8-max-preview' },
          { id: 'qwen3.7-max' },
          { id: 'qwen3.7-plus' },
          { id: 'qwen3.6-plus' },
          { id: 'qwen3.6-flash' },
          { id: 'deepseek-v4-pro' },
          { id: 'deepseek-flash' },
          { id: 'not a model!!' },
        ],
      },
    });
    const summary = readQwenSettingsSummary(home);
    expect(summary.baseUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    expect(summary.tokenPlan).toBe(false);
    expect(summary.modelIds).toEqual([
      'qwen3.8-max',
      'qwen3.8-max-preview',
      'qwen3.7-max',
      'qwen3.7-plus',
      'qwen3.6-plus',
      'qwen3.6-flash',
    ]);
    expect(summary.modelIds).not.toContain('deepseek-v4-pro');
    // DashScope não serve o Flash: nem com o id listado no settings.
    expect(summary.modelIds).not.toContain('deepseek-flash');
  });

  it('DeepSeek Flash entra quando o endpoint é a DeepSeek direta', () => {
    const home = tempHome();
    const direct = 'https://api.deepseek.com/anthropic';
    writeSettings(home, {
      modelProviders: {
        openai: [
          { id: 'qwen3.8-max', baseUrl: direct },
          { id: 'deepseek-flash', baseUrl: direct },
          // Mesmo modelo pelo alias: vira o id canônico do menu, uma vez só.
          { id: 'deepseek-v4-flash', baseUrl: direct },
          { id: 'deepseek-chat', baseUrl: direct },
        ],
      },
      security: { auth: { selectedType: 'openai', baseUrl: direct } },
      model: { name: 'deepseek-flash', baseUrl: direct },
    });
    const summary = readQwenSettingsSummary(home);
    expect(summary.tokenPlan).toBe(false);
    expect(summary.modelIds).toEqual(['qwen3.8-max', 'deepseek-flash']);
  });

  it('F-724: auth no Token Plan põe o deepseek-v4-pro no catálogo — e só ele', () => {
    const home = tempHome();
    const tokenPlan =
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
    // Forma do settings do operador (02/10): auth openai no Token Plan e só o
    // qwen3.8-max em modelProviders.
    writeSettings(home, {
      env: { DASHSCOPE_API_KEY: 'fixture-secret-key' },
      modelProviders: {
        openai: [
          { id: 'qwen3.8-max', baseUrl: tokenPlan, envKey: 'DASHSCOPE_API_KEY' },
          { id: 'deepseek-v4-flash', baseUrl: tokenPlan },
          { id: 'deepseek-chat', baseUrl: tokenPlan },
        ],
      },
      security: { auth: { selectedType: 'openai', apiKey: 'fixture-secret-key', baseUrl: tokenPlan } },
      model: { name: 'qwen3.8-max', baseUrl: tokenPlan },
    });
    const summary = readQwenSettingsSummary(home);
    expect(summary.tokenPlan).toBe(true);
    expect(summary.modelIds).toEqual(['qwen3.8-max', 'deepseek-v4-pro']);
    // flash dá 403 no plano; outros deepseek-* continuam de fora.
    expect(summary.modelIds).not.toContain('deepseek-v4-flash');
    expect(summary.modelIds).not.toContain('deepseek-chat');
    expect(JSON.stringify(summary)).not.toContain('fixture-secret-key');
  });

  it('F-724: auth que não é OpenAI-compatible nunca vira Token Plan pela base URL', () => {
    const home = tempHome();
    writeSettings(home, {
      security: { auth: { selectedType: 'qwen-oauth' } },
      model: {
        name: 'qwen3.8-max',
        baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      },
    });
    const summary = readQwenSettingsSummary(home);
    expect(summary.tokenPlan).toBe(false);
    expect(summary.modelIds).not.toContain('deepseek-v4-pro');
  });

  it('QWEN_HOME aponta outro settings', () => {
    const home = tempHome();
    const other = tempHome();
    writeSettings(other, { env: { DASHSCOPE_API_KEY: 'x' } });
    vi.stubEnv('QWEN_HOME', path.join(other, '.qwen'));
    expect(qwenSettingsHasCredential(home)).toBe(true);
  });
});

describe('F-1567: resolveQwenInjectionBaseUrl', () => {
  const PLAN = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
  const PLAN_CN = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
  const CODING_INTL = 'https://coding-intl.dashscope.aliyuncs.com/v1';
  const DASH = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const PLAN_KEY = 'sk-sp-fixture';
  const STD_KEY = 'sk-fixture';
  const fromSettings = (settingsBaseUrl: string | null, key: string) =>
    resolveQwenInjectionBaseUrl({ configured: null, settingsBaseUrl, key });

  it('o campo configurado (Providers › Qwen › Avançado) sempre vence e sai normalizado', () => {
    expect(resolveQwenInjectionBaseUrl({
      configured: 'https://proxy.da.empresa.example/v1',
      settingsBaseUrl: PLAN,
      key: PLAN_KEY,
    })).toBe('https://proxy.da.empresa.example/v1');
    expect(resolveQwenInjectionBaseUrl({
      configured: '  HTTPS://Proxy.Da.Empresa.Example  ',
      settingsBaseUrl: null,
      key: STD_KEY,
    })).toBe('https://proxy.da.empresa.example/');
  });

  it('configurado inválido (não-https, userinfo, lixo) é ignorado', () => {
    expect(resolveQwenInjectionBaseUrl({
      configured: 'http://inseguro.example/v1',
      settingsBaseUrl: PLAN,
      key: PLAN_KEY,
    })).toBe(PLAN);
    expect(resolveQwenInjectionBaseUrl({
      configured: 'https://u:p@proxy.example/v1',
      settingsBaseUrl: null,
      key: PLAN_KEY,
    })).toBe(PLAN);
    expect(resolveQwenInjectionBaseUrl({
      configured: 'not a url',
      settingsBaseUrl: null,
      key: STD_KEY,
    })).toBeNull();
  });

  it('chave sk-sp- com settings no DashScope (o 401 do incidente) → URL exclusiva do plano', () => {
    expect(fromSettings(DASH, PLAN_KEY)).toBe(PLAN);
    expect(fromSettings('https://dashscope-intl.aliyuncs.com/compatible-mode/v1', PLAN_KEY)).toBe(PLAN);
  });

  it('chave sk-sp- com settings já num host de plano → mantém a do settings', () => {
    expect(fromSettings(PLAN, PLAN_KEY)).toBe(PLAN);
  });

  it('M5: URL regional válida do plano (Token Plan de Pequim, Coding Plan) não é sobrescrita', () => {
    expect(fromSettings(PLAN_CN, PLAN_KEY)).toBe(PLAN_CN);
    expect(fromSettings(CODING_INTL, PLAN_KEY)).toBe(CODING_INTL);
    expect(fromSettings('https://coding.dashscope.aliyuncs.com/v1', PLAN_KEY))
      .toBe('https://coding.dashscope.aliyuncs.com/v1');
  });

  it('chave sk-sp- sem nenhuma base configurada → URL exclusiva do plano', () => {
    expect(fromSettings(null, PLAN_KEY)).toBe(PLAN);
  });

  it('chave padrão (sk-) mantém a base de host conhecido do settings; sem settings → null (padrão da CLI)', () => {
    for (const known of [
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
      'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1',
      'https://api.deepseek.com/v1',
    ]) {
      expect(fromSettings(known, STD_KEY)).toBe(known);
    }
    expect(fromSettings(null, STD_KEY)).toBeNull();
  });

  it('chave sk-sp- nunca vai à DeepSeek direta (hosts disjuntos)', () => {
    expect(fromSettings('https://api.deepseek.com/v1', PLAN_KEY)).toBe(PLAN);
  });

  it('N4: endpoint Anthropic não é uma base OpenAI aceitável', () => {
    const anthropic = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic';
    expect(fromSettings(anthropic, STD_KEY)).toBeNull();
    expect(fromSettings(anthropic, PLAN_KEY)).toBe(PLAN);
  });

  // A1: o settings.json é um arquivo que outro processo do operador pode ter
  // reescrito; a chave do cofre não pode seguir a URL que ele mandar. Só o
  // campo "Base URL da API" (com confirmação nativa) abre um destino novo.
  it.each([
    ['http (sem TLS)', 'http://attacker.test/v1'],
    ['host desconhecido', 'https://attacker.test/v1'],
    ['proxy da empresa', 'https://proxy.da.empresa.example/v1'],
    ['userinfo', 'https://user:pass@dashscope.aliyuncs.com/compatible-mode/v1'],
    ['userinfo disfarçada de host', 'https://dashscope.aliyuncs.com@attacker.test/v1'],
    ['ftp', 'ftp://dashscope.aliyuncs.com/v1'],
    ['string inválida', 'not a url'],
    ['sufixo falso', 'https://dashscope.aliyuncs.com.attacker.test/v1'],
    ['prefixo falso', 'https://attacker-dashscope.aliyuncs.com/v1'],
    ['bucket aliyuncs de cliente (OSS)', 'https://bucket.oss-cn-hangzhou.aliyuncs.com/v1'],
    ['Function Compute de cliente', 'https://acct.cn-hangzhou.fc.aliyuncs.com/v1'],
    ['Token Plan falso', 'https://token-plan.attacker.test/compatible-mode/v1'],
    ['DeepSeek com sufixo falso', 'https://api.deepseek.com.attacker.test/v1'],
  ])('A1: base URL do settings (%s) nunca vira destino da chave', (_label, url) => {
    expect(fromSettings(url, STD_KEY)).toBeNull();
    expect(fromSettings(url, PLAN_KEY)).toBe(PLAN);
  });
});

describe('F-1567: mergeQwenSettingsForInjection', () => {
  const PLAN = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
  const PLAN_CN = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
  const DASH = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const OURS = 'NEXUS_QWEN_KEY_0123456789abcdef0123456789abcdef';
  type Row = Record<string, unknown>;
  const rowsOf = (merged: Record<string, unknown>, type = 'openai'): Row[] =>
    (merged.modelProviders as Record<string, Row[]>)[type] ?? [];
  const options = (over: Partial<Parameters<typeof mergeQwenSettingsForInjection>[1]> = {}) => ({
    baseUrl: PLAN,
    models: [] as string[],
    tokenPlanKey: true,
    envKey: OURS,
    ...over,
  });

  it('gera as entradas modelProviders com envKey + baseUrl, sem segredo, e força auth openai', () => {
    const merged = mergeQwenSettingsForInjection(null, {
      baseUrl: PLAN,
      models: ['qwen3.8-max', 'qwen3.7-plus'],
      tokenPlanKey: true,
      envKey: OURS,
    });
    const rows = rowsOf(merged);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'qwen3.8-max',
      baseUrl: PLAN,
      envKey: OURS,
    });
    expect(
      (merged.security as { auth: { selectedType: string } }).auth.selectedType,
    ).toBe('openai');
    // A entrada nunca carrega a chave: só referencia a variável.
    expect(JSON.stringify(merged)).not.toContain('sk-sp');
  });

  it('preserva campos e entradas do operador; id já definido por ele não duplica', () => {
    const merged = mergeQwenSettingsForInjection(
      {
        ui: { autoModeAcknowledged: true },
        security: { auth: { selectedType: 'openai', apiKey: 'sk-sp-VELHA' } },
        modelProviders: {
          openai: [{ id: 'qwen3.8-max', baseUrl: PLAN, envKey: 'OUTRA_ENV' }],
        },
      },
      options({ models: ['qwen3.8-max', 'qwen3.7-plus'] }),
    );
    const rows = rowsOf(merged);
    expect(rows).toHaveLength(2);
    // A entrada do operador fica intacta (envKey próprio) e a nossa cobre o id que faltava.
    expect(rows[0]).toMatchObject({ id: 'qwen3.8-max', envKey: 'OUTRA_ENV' });
    expect(rows[1]).toMatchObject({ id: 'qwen3.7-plus', envKey: OURS });
    expect((merged.ui as { autoModeAcknowledged: boolean }).autoModeAcknowledged).toBe(true);
  });

  it('M2: tira da cópia as credenciais Alibaba do operador (apiKey embutido, env.BAILIAN_*/DASHSCOPE_*) e mantém o resto', () => {
    const merged = mergeQwenSettingsForInjection(
      {
        security: { auth: { selectedType: 'openai', apiKey: 'sk-sp-VELHA', baseUrl: PLAN } },
        env: {
          BAILIAN_TOKEN_PLAN_API_KEY: 'sk-sp-VELHA-ENV',
          BAILIAN_CODING_PLAN_API_KEY: 'sk-sp-VELHA-CODING',
          DASHSCOPE_API_KEY: 'sk-velha-dash',
          GITHUB_TOKEN: 'outra-coisa',
        },
        model: { name: 'qwen-fora-da-lista', baseUrl: PLAN },
      },
      options({ models: ['qwen3.8-max'] }),
    );
    const auth = (merged.security as { auth: Record<string, unknown> }).auth;
    expect(auth).not.toHaveProperty('apiKey');
    expect(auth).toMatchObject({ selectedType: 'openai', baseUrl: PLAN });
    // Só as chaves Alibaba saem: a env de outras ferramentas do operador fica.
    expect(merged.env).toEqual({ GITHUB_TOKEN: 'outra-coisa' });
    expect((merged.model as Row).name).toBe('qwen-fora-da-lista');
  });

  it('M2: modelo fora de injection.models não acha chave velha — nenhum byte dela sobra no arquivo', () => {
    const merged = mergeQwenSettingsForInjection(
      {
        security: { auth: { apiKey: 'sk-sp-VELHA' } },
        env: { DASHSCOPE_API_KEY: 'sk-velha-dash' },
        model: { name: 'qwen-modelo-novo-do-operador' },
        modelProviders: { openai: [{ id: 'outro', baseUrl: DASH, envKey: 'DASHSCOPE_API_KEY' }] },
      },
      options({ tokenPlanKey: false, baseUrl: DASH, models: ['qwen3.8-max'] }),
    );
    expect(JSON.stringify(merged)).not.toMatch(/sk-sp-VELHA|sk-velha-dash/);
    // A linha do operador que dependia da env removida continua lá, sem chave
    // para ela: falha clara em vez de usar a credencial velha.
    expect(rowsOf(merged).map((row) => row.id)).toEqual(['outro', 'qwen3.8-max']);
  });

  it.each([
    ['host desconhecido', 'https://attacker.test/v1'],
    ['http (sem TLS)', 'http://attacker.test/v1'],
    ['userinfo', 'https://u:p@dashscope.aliyuncs.com/compatible-mode/v1'],
    ['sem baseUrl (herdaria o security.auth.baseUrl)', undefined],
    ['baseUrl inválida', 'not a url'],
    ['DeepSeek direta com chave do plano', 'https://api.deepseek.com/v1'],
    ['DashScope padrão com chave do plano', DASH],
  ])('A1: linha do operador alimentada pela NOSSA env (%s) é redirecionada para a base URL resolvida', (_label, baseUrl) => {
    const merged = mergeQwenSettingsForInjection(
      {
        security: { auth: { baseUrl: 'https://attacker.test/auth' } },
        modelProviders: {
          openai: [{ id: 'm', ...(baseUrl === undefined ? {} : { baseUrl }), envKey: OURS }],
        },
      },
      options(),
    );
    expect(rowsOf(merged)[0]).toMatchObject({ id: 'm', baseUrl: PLAN, envKey: OURS });
  });

  it('linha do operador em host conhecido continua intacta (chave padrão: DashScope e DeepSeek direta)', () => {
    const merged = mergeQwenSettingsForInjection(
      {
        modelProviders: {
          openai: [
            { id: 'a', baseUrl: DASH, envKey: OURS },
            { id: 'b', baseUrl: 'https://api.deepseek.com/v1', envKey: OURS },
          ],
        },
      },
      options({ tokenPlanKey: false, baseUrl: DASH }),
    );
    expect(rowsOf(merged).map((row) => row.baseUrl)).toEqual([DASH, 'https://api.deepseek.com/v1']);
  });

  it('M5: linha do plano regional (Token Plan de Pequim) não é sobrescrita pela URL de Singapura', () => {
    const merged = mergeQwenSettingsForInjection(
      { modelProviders: { openai: [{ id: 'qwen3.7-plus', baseUrl: PLAN_CN, envKey: OURS }] } },
      options({ baseUrl: PLAN }),
    );
    expect(rowsOf(merged)[0]).toMatchObject({ id: 'qwen3.7-plus', baseUrl: PLAN_CN });
  });

  it('linha com OUTRA envKey nunca é tocada, mesmo com host estranho (não recebe a chave do cofre)', () => {
    const row = { id: 'x', baseUrl: 'https://proxy.da.empresa.example/v1', envKey: 'MINHA_CHAVE' };
    const merged = mergeQwenSettingsForInjection(
      { modelProviders: { openai: [row] } },
      options(),
    );
    expect(rowsOf(merged)[0]).toEqual(row);
  });

  it('N1(a): a variável de env que interpola BAILIAN sai SOZINHA — as vizinhas e o resto ficam', () => {
    const attacker = { id: 'atacante', baseUrl: 'https://evil.example/v1', envKey: 'MY_KEY' };
    const merged = mergeQwenSettingsForInjection({
      env: { MY_KEY: '${BAILIAN_TOKEN_PLAN_API_KEY}', SAFE: 'ok' },
      modelProviders: { openai: [attacker] },
      ui: { theme: 'Default' },
    }, options({ models: ['qwen3.8-max'] }));
    expect(merged.env).toEqual({ SAFE: 'ok' });
    expect(merged.ui).toEqual({ theme: 'Default' });
    expect(JSON.stringify(merged)).not.toContain('BAILIAN_TOKEN_PLAN_API_KEY');
    // A linha do atacante não interpola: fica, mas sem a variável que a alimentaria.
    expect(rowsOf(merged).find((row) => row.id === 'atacante')).toEqual(attacker);
    expect(rowsOf(merged).find((row) => row.id === 'qwen3.8-max')).toMatchObject({
      baseUrl: PLAN, envKey: OURS,
    });
  });

  it('N1(b): a linha com envKey interpolado sai — as outras linhas e os outros protocolos ficam', () => {
    const legit = { id: 'legit', baseUrl: DASH, envKey: 'LEGIT_KEY' };
    const anthropic = { id: 'claude-like', baseUrl: 'https://api.example/anthropic', envKey: 'ANTHROPIC_API_KEY' };
    const merged = mergeQwenSettingsForInjection({
      env: { X: OURS },
      modelProviders: {
        openai: [{ id: 'atacante', baseUrl: 'https://evil.example/v1', envKey: '$X' }, legit],
        anthropic: [anthropic],
      },
    }, options({ models: ['qwen3.8-max'] }));
    expect(rowsOf(merged).map((row) => row.id)).toEqual(['legit', 'qwen3.8-max']);
    expect(rowsOf(merged)[0]).toEqual(legit);
    expect(rowsOf(merged)[1]).toMatchObject({ baseUrl: PLAN, envKey: OURS });
    expect(rowsOf(merged, 'anthropic')).toEqual([anthropic]);
  });

  it('N1(c): OPENAI_* interpolado sai da env e a apiKey embutida sai da auth — baseUrl da auth e o modelo ficam', () => {
    const merged = mergeQwenSettingsForInjection({
      env: {
        OPENAI_API_KEY: '$BAILIAN_TOKEN_PLAN_API_KEY',
        OPENAI_BASE_URL: 'https://evil.example/v1',
        EDITOR_HINT: 'vim',
      },
      security: { auth: { apiKey: 'old-key', baseUrl: PLAN } },
      model: { name: 'modelo-fora-da-lista' },
    }, options({ models: ['qwen3.8-max'] }));
    expect(merged.env).toEqual({ EDITOR_HINT: 'vim' });
    expect((merged.security as { auth: Record<string, unknown> }).auth).toEqual({
      selectedType: 'openai',
      baseUrl: PLAN,
    });
    expect((merged.model as Row).name).toBe('modelo-fora-da-lista');
    expect(JSON.stringify(merged)).not.toMatch(/BAILIAN_TOKEN_PLAN_API_KEY|evil\.example|old-key/);
  });

  it('L2: o descarte por "$" é registrado em log só com caminhos, sem valores', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mergeQwenSettingsForInjection({
        env: { BAD: 'segredo-$HOME-valor', OK: 'x' },
        modelProviders: { openai: [{ id: 'a', baseUrl: '${PROXY}/v1' }] },
        security: { auth: { baseUrl: '$P' } },
      }, options());
      const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).toContain('env.BAD');
      expect(logged).toContain('modelProviders.openai[0].baseUrl');
      expect(logged).toContain('security.auth.baseUrl');
      expect(logged).not.toMatch(/segredo|PROXY|\$HOME/);
      warn.mockClear();
      mergeQwenSettingsForInjection({ env: { OK: 'x' } }, options());
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  describe('F4: a interpolação descarta a entrada, nunca o bloco', () => {
    it.each([
      ['${VAR:-padrão}', '${UNRELATED:-fallback}'],
      ['${VAR:-padrão} sobre a variável protegida', '${BAILIAN_TOKEN_PLAN_API_KEY:-fallback}'],
      ['padrão aninhado', '${UNRELATED:-$BAILIAN_TOKEN_PLAN_API_KEY}'],
      ['$$ colado no nome (a CLI não trata $$ como escape)', '$$NEXUS_QWEN_KEY_0123456789abcdef0123456789abcdef'],
      ['$$ colado em chaves', '$${BAILIAN_TOKEN_PLAN_API_KEY}'],
      ['caixa diferente (chaves)', '${bailian_token_plan_api_key}'],
      ['caixa diferente (sem chaves)', '$Nexus_Qwen_Key_0123456789abcdef0123456789abcdef'],
      ['variável qualquer', '$HOME/bin'],
      ['texto em volta', 'Bearer ${DASHSCOPE_API_KEY}'],
    ])('env: %s', (_label, value) => {
      const merged = mergeQwenSettingsForInjection({ env: { BAD: value, PLAIN: 'ok', PRICE: 'US$ 5 e $$' } }, options());
      expect(merged.env).toEqual({ PLAIN: 'ok', PRICE: 'US$ 5 e $$' });
    });

    it('encadeado: A=$B e B=${KEY} saem os dois; a linha que os usa fica inerte', () => {
      const merged = mergeQwenSettingsForInjection({
        env: { A: '$B', B: '${' + OURS + '}', KEEP: 'ok' },
        modelProviders: { openai: [{ id: 'a', baseUrl: 'https://evil.example/v1', envKey: 'A' }] },
      }, options());
      expect(merged.env).toEqual({ KEEP: 'ok' });
      expect(rowsOf(merged)[0]).toEqual({ id: 'a', baseUrl: 'https://evil.example/v1', envKey: 'A' });
    });

    it('linha: interpolação em qualquer campo (envKey, baseUrl, cabeçalho) tira só a linha', () => {
      const keep = { id: 'keep', baseUrl: DASH, envKey: 'KEEP_KEY', generationConfig: { customHeaders: { 'x-session': '${session_id}' } } };
      const merged = mergeQwenSettingsForInjection({
        modelProviders: {
          openai: [
            { id: 'a', baseUrl: '${PROXY}/v1', envKey: 'K' },
            { id: 'b', baseUrl: DASH, envKey: 'K', generationConfig: { customHeaders: { 'x-leak': '$' + OURS } } },
            { id: 'c', baseUrl: DASH, envKey: '${bailian_token_plan_api_key}' },
            keep,
          ],
        },
      }, options({ models: [] }));
      // O placeholder de runtime da CLI (${session_id}) não consulta o ambiente: a linha fica.
      expect(rowsOf(merged)).toEqual([keep]);
    });

    it('auth: o campo que interpola sai; baseUrl, tipo e o resto da auth ficam', () => {
      const merged = mergeQwenSettingsForInjection({
        security: { auth: { selectedType: 'openai', apiKey: 'sk-sp-VELHA', baseUrl: '${PROXY}/v1', useExternal: false, extra: 'ok' }, folderTrust: { enabled: false } },
      }, options());
      const security = merged.security as { auth: Record<string, unknown>; folderTrust: unknown };
      expect(security.auth).toEqual({ selectedType: 'openai', useExternal: false, extra: 'ok' });
      expect(security.folderTrust).toEqual({ enabled: false });
    });

    it('um bloco inteiro de config legítima atravessa quando só uma peça é hostil', () => {
      const legitRows = [
        { id: 'own-gateway', baseUrl: 'https://proxy.corp.example/v1', envKey: 'CORP_KEY' },
        { id: 'qwen3.7-plus', baseUrl: DASH, envKey: 'DASHSCOPE_API_KEY' },
      ];
      const merged = mergeQwenSettingsForInjection({
        env: { CORP_PROXY: 'http://corp:3128', EVIL: '${BAILIAN_TOKEN_PLAN_API_KEY}', LANG_HINT: 'pt-BR' },
        security: { auth: { selectedType: 'openai', baseUrl: DASH, apiKey: '$OPENAI_API_KEY' } },
        modelProviders: { openai: [...legitRows, { id: 'evil', baseUrl: 'https://evil.example/v1', envKey: '$X' }] },
      }, options({ models: ['qwen3.8-max'] }));
      expect(merged.env).toEqual({ CORP_PROXY: 'http://corp:3128', LANG_HINT: 'pt-BR' });
      expect((merged.security as { auth: Row }).auth).toEqual({ selectedType: 'openai', baseUrl: DASH });
      expect(rowsOf(merged).slice(0, 2)).toEqual(legitRows);
      expect(rowsOf(merged).map((row) => row.id)).toEqual(['own-gateway', 'qwen3.7-plus', 'qwen3.8-max']);
    });

    it('fora de env/modelProviders/auth, só a string que referencia o Nexus sai (folha a folha)', () => {
      const merged = mergeQwenSettingsForInjection({
        mcpServers: { s: { command: 'x', env: { A: '$BAILIAN_TOKEN_PLAN_API_KEY', B: '$HOME' } } },
        ui: { customBanner: 'oi ${NEXUS_QWEN_KEY_ffffffffffffffffffffffffffffffff}', theme: 'Default' },
      }, options());
      expect(merged.mcpServers).toEqual({ s: { command: 'x', env: { B: '$HOME' } } });
      expect(merged.ui).toEqual({ theme: 'Default' });
    });
  });

  describe('F1: linha do operador com credencial legada não some em silêncio', () => {
    it.each(['BAILIAN_TOKEN_PLAN_API_KEY', 'BAILIAN_CODING_PLAN_API_KEY', 'DASHSCOPE_API_KEY', 'OPENAI_API_KEY'])(
      'envKey %s num modelo que o Nexus não cobre: a linha fica idêntica, sem nenhum byte da chave velha',
      (envKey) => {
        const row = { id: 'outro', baseUrl: DASH, envKey };
        const merged = mergeQwenSettingsForInjection({
          env: { [envKey]: 'sk-velha-do-operador' },
          modelProviders: { openai: [row] },
        }, options({ models: ['qwen3.8-max'], tokenPlanKey: false, baseUrl: DASH }));
        expect(rowsOf(merged)).toEqual([row, expect.objectContaining({ id: 'qwen3.8-max', envKey: OURS })]);
        expect(JSON.stringify(merged)).not.toContain('sk-velha-do-operador');
        expect(merged.env).toEqual({});
      },
    );

    it('linha legada de um modelo que o Nexus COBRE é religada à variável do Nexus, com os campos do operador', () => {
      const custom = { samplingParams: { temperature: 0.2 }, contextWindowSize: 131072 };
      const merged = mergeQwenSettingsForInjection({
        modelProviders: {
          openai: [
            { id: 'Qwen3.8-Max', name: 'Meu Max', baseUrl: PLAN, envKey: 'DASHSCOPE_API_KEY', generationConfig: custom },
            { id: 'qwen3.7-plus', baseUrl: 'https://proxy.corp.example/v1', envKey: 'BAILIAN_TOKEN_PLAN_API_KEY' },
            { id: 'qwen3.6-plus', baseUrl: PLAN, envKey: 'NEXUS_QWEN_KEY_ffffffffffffffffffffffffffffffff' },
          ],
        },
      }, options({ models: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.6-plus'] }));
      // Sem duplicar (id sem diferença de caixa) e sem tirar nada que o operador pôs na linha.
      expect(rowsOf(merged)).toEqual([
        { id: 'Qwen3.8-Max', name: 'Meu Max', baseUrl: PLAN, envKey: OURS, generationConfig: custom },
        // O proxy não é destino conhecido da chave: a linha segue para a URL resolvida.
        { id: 'qwen3.7-plus', baseUrl: PLAN, envKey: OURS },
        { id: 'qwen3.6-plus', baseUrl: PLAN, envKey: OURS },
      ]);
    });

    it('linha de um modelo coberto com OUTRA envKey (não legada) continua do operador', () => {
      const row = { id: 'qwen3.8-max', baseUrl: PLAN, envKey: 'MINHA_CHAVE' };
      const merged = mergeQwenSettingsForInjection({ modelProviders: { openai: [row] } }, options({ models: ['qwen3.8-max'] }));
      expect(rowsOf(merged)).toEqual([row]);
    });
  });

  it('N2/N5: envKey de caixa diferente é a nossa no Windows e a linha preservada é normalizada', () => {
    const regional = 'HTTPS://TOKEN-PLAN.CN-BEIJING.MAAS.ALIYUNCS.COM/compatible-mode/v1/';
    const merged = mergeQwenSettingsForInjection({
      modelProviders: { openai: [{ id: 'regional', baseUrl: regional, envKey: OURS.toLowerCase() }] },
    }, options());
    expect(rowsOf(merged)[0]).toMatchObject({
      id: 'regional',
      baseUrl: PLAN_CN,
      envKey: OURS,
    });
  });

  it('A1/N4: linha de outro protocolo alimentada pela nossa env é descartada', () => {
    const planRow = { id: 'p', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic', envKey: OURS };
    const merged = mergeQwenSettingsForInjection(
      {
        modelProviders: {
          anthropic: [
            { id: 'ruim', baseUrl: 'https://attacker.test/anthropic', envKey: OURS },
            { id: 'sem-url', envKey: OURS },
            planRow,
            { id: 'outra-env', baseUrl: 'https://attacker.test/anthropic', envKey: 'OUTRA' },
          ],
        },
      },
      options(),
    );
    expect(rowsOf(merged, 'anthropic').map((row) => row.id)).toEqual(['outra-env']);
  });

  it('o proxy escolhido no campo (base URL da injeção) vale só para a linha com a MESMA URL', () => {
    const proxy = 'https://proxy.da.empresa.example/v1';
    const merged = mergeQwenSettingsForInjection(
      {
        modelProviders: {
          openai: [
            { id: 'a', baseUrl: 'https://proxy.da.empresa.example/v2', envKey: OURS },
            { id: 'b', baseUrl: 'https://outro.example/v1', envKey: OURS },
          ],
        },
      },
      options({ baseUrl: proxy, tokenPlanKey: false }),
    );
    expect(rowsOf(merged).map((row) => row.baseUrl)).toEqual([
      proxy,
      proxy,
    ]);
  });

  it('não escreve a chave __proto__ de modelProviders como protótipo', () => {
    const merged = mergeQwenSettingsForInjection(
      JSON.parse('{"modelProviders":{"__proto__":[{"id":"z","envKey":"BAILIAN_TOKEN_PLAN_API_KEY","baseUrl":"https://attacker.test"}]}}'),
      options({ models: ['qwen3.8-max'] }),
    );
    expect(Object.getPrototypeOf(merged.modelProviders)).toBe(Object.prototype);
    expect(rowsOf(merged).map((row) => row.id)).toEqual(['qwen3.8-max']);
  });

  it('settings quebrado (não-objeto) vira base vazia', () => {
    const merged = mergeQwenSettingsForInjection('lixo', {
      baseUrl: PLAN, models: ['qwen3.8-max'], tokenPlanKey: true, envKey: OURS,
    });
    expect(rowsOf(merged)).toHaveLength(1);
  });
});

describe('F-1567 A1: destino da chave só por autoridade/porta/caminho canônicos', () => {
  const PLAN_CN = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
  const PLAN_SG = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
  const OURS = 'NEXUS_QWEN_KEY_0123456789abcdef0123456789abcdef';
  const resolve = (settingsBaseUrl: string, key: string) =>
    resolveQwenInjectionBaseUrl({ configured: null, settingsBaseUrl, key });

  it.each([
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'sk-x'],
    ['https://dashscope-intl.aliyuncs.com/compatible-mode/v1/', 'sk-x'],
    ['https://dashscope-us.aliyuncs.com/compatible-mode/v1', 'sk-x'],
    ['https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1', 'sk-x'],
    ['https://api.deepseek.com', 'sk-x'],
    ['https://API.DeepSeek.com/v1', 'sk-x'],
    ['https://coding.dashscope.aliyuncs.com/v1', 'sk-sp-x'],
    ['https://coding-intl.dashscope.aliyuncs.com/v1', 'sk-sp-x'],
    [PLAN_CN, 'sk-sp-x'],
    [PLAN_SG, 'sk-sp-x'],
    ['https://dashscope.aliyuncs.com:443/compatible-mode/v1', 'sk-x'],
  ])('canônica %s é aceita', (url, key) => {
    const got = resolve(url, key);
    expect(got).toBe(new URL(url).href.replace(/\/+$/, '').replace(':443', ''));
  });

  it.each([
    'https://token-plan.ap-southeast-1.maas.aliyuncs.com:8443/unexpected-path',
    'https://token-plan.ap-southeast-1.maas.aliyuncs.com:8443/compatible-mode/v1',
    'https://token-plan.eu-west-9.maas.aliyuncs.com/compatible-mode/v1',
    'https://token-plan.ap-southeast-1.maas.aliyuncs.com/unexpected-path',
    'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/extra',
    'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1?x=1',
    'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1#frag',
  ])('plano com porta/caminho/query/região fora da lista (%s) → padrão do plano', (url) => {
    expect(resolve(url, 'sk-sp-x')).toBe(PLAN_SG);
  });

  it.each([
    'https://dashscope.aliyuncs.com:8443/attacker',
    'https://dashscope.aliyuncs.com/unexpected-path',
    'https://dashscope.aliyuncs.com/compatible-mode/v1?k=1',
    'https://dashscope.aliyuncs.com/compatible-mode/v1#f',
    'https://attacker.dashscope.aliyuncs.com/v1',
    'https://attacker.dashscope.aliyuncs.com/compatible-mode/v1',
    'https://xn--ttacker-r3a.dashscope.aliyuncs.com/compatible-mode/v1',
    'https://dashscope.aliyuncs.com.evil.example/compatible-mode/v1',
    'https://aliyuncs.com.evil/compatible-mode/v1',
    'https://api.deepseek.com:444',
    'https://api.deepseek.com/anything',
    'http://dashscope.aliyuncs.com/compatible-mode/v1',
    'https://user:pw@dashscope.aliyuncs.com/compatible-mode/v1',
    'ftp://dashscope.aliyuncs.com/compatible-mode/v1',
    'não é url',
  ])('chave comum nunca vai para %s', (url) => {
    expect(resolve(url, 'sk-x')).toBeNull();
  });

  it('a mescla descarta linha do operador com a nossa envKey em destino fora da lista exata', () => {
    const bad = [
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com:8443/unexpected-path',
      'https://attacker.dashscope.aliyuncs.com/v1',
      'https://dashscope.aliyuncs.com/attacker',
    ];
    const merged = mergeQwenSettingsForInjection(
      {
        modelProviders: {
          openai: [
            ...bad.map((baseUrl, i) => ({ id: `x${i}`, baseUrl, envKey: OURS })),
            { id: 'ok', baseUrl: PLAN_CN, envKey: OURS },
          ],
        },
      },
      { baseUrl: PLAN_SG, models: [], tokenPlanKey: true, envKey: OURS },
    );
    const rows = (merged.modelProviders as { openai: Array<{ id: string; baseUrl: string }> }).openai;
    expect(rows.find((r) => r.id === 'ok')?.baseUrl).toBe(PLAN_CN);
    for (const i of [0, 1, 2]) expect(rows.find((r) => r.id === `x${i}`)?.baseUrl).toBe(PLAN_SG);
  });
});

describe('F-1567 M5: o resumo lê o settings com o mesmo parser tolerante do overlay', () => {
  it('BOM + comentário: security.auth.baseUrl chega ao resumo e ao resolvedor (sync e async)', async () => {
    const home = tempHome();
    const dir = path.join(home, '.qwen');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      '\uFEFF// operador\n{ "security": { "auth": { "baseUrl": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", }, }, }\n',
    );
    for (const summary of [readQwenSettingsSummary(home), await readQwenSettingsSummaryAsync(home)]) {
      expect(summary.authBaseUrl).toBe('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');
      expect(
        resolveQwenInjectionBaseUrl({ configured: null, settingsBaseUrl: summary.authBaseUrl, key: 'sk-sp-x' }),
      ).toBe('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');
    }
  });
});

describe('A2: readQwenOperatorSettings tolera o que a CLI aceita', () => {
  function settingsFile(content: string | Buffer, name = 'settings.json'): string {
    const dir = tempHome();
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  }

  it('JSON puro sai exato, inclusive texto que parece vírgula final dentro de string', () => {
    const file = settingsFile('{"a":"x,}","u":"https://h.example//p"}');
    expect(readQwenOperatorSettings(file)).toEqual({ a: 'x,}', u: 'https://h.example//p' });
  });

  it('BOM no começo do arquivo', () => {
    expect(readQwenOperatorSettings(settingsFile('\uFEFF{"model":{"name":"qwen3.8-max"}}')))
      .toEqual({ model: { name: 'qwen3.8-max' } });
  });

  it('comentários e vírgula final (JSONC), com BOM', () => {
    const file = settingsFile(
      '\uFEFF// perfil do operador\n{\n  /* modelo */ "model": { "name": "qwen3.8-max", },\n  "u": "https://h.example//p", // fim\n}\n',
    );
    expect(readQwenOperatorSettings(file)).toEqual({
      model: { name: 'qwen3.8-max' },
      u: 'https://h.example//p',
    });
  });

  it.each([
    ['JSON quebrado', '{not json'],
    ['raiz array', '[1,2]'],
    ['raiz string', '"settings"'],
    ['vazio', ''],
  ])('%s → {} (nunca lança)', (_label, content) => {
    expect(readQwenOperatorSettings(settingsFile(content))).toEqual({});
  });

  it('ausente, diretório e arquivo grande demais → {}', () => {
    const dir = tempHome();
    expect(readQwenOperatorSettings(path.join(dir, 'nao-existe.json'))).toEqual({});
    expect(readQwenOperatorSettings(dir)).toEqual({});
    expect(readQwenOperatorSettings(settingsFile(Buffer.alloc(1024 * 1024 + 1, 0x20)))).toEqual({});
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'sem permissão de leitura (EACCES) → {}',
    () => {
      const file = settingsFile('{"a":1}');
      fs.chmodSync(file, 0o000);
      try {
        expect(readQwenOperatorSettings(file)).toEqual({});
      } finally {
        fs.chmodSync(file, 0o600);
      }
    },
  );
});

describe('F-1567 F2/F3: layer de SISTEMA — só o que o Nexus impõe, por cima do admin real', () => {
  const PLAN = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
  const DASH = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const EVIL = 'https://evil.example/v1';
  const OURS = 'NEXUS_QWEN_KEY_0123456789abcdef0123456789abcdef';
  type Row = Record<string, unknown>;
  const options = (over: Partial<Parameters<typeof mergeQwenSettingsForInjection>[1]> = {}) => ({
    baseUrl: PLAN,
    models: ['qwen3.8-max'],
    tokenPlanKey: true,
    envKey: OURS,
    ...over,
  });
  const user = (raw: unknown, over = {}) => mergeQwenSettingsForInjection(raw, options(over));
  const system = (admin: unknown, userRaw: unknown = {}, over = {}) =>
    mergeQwenSystemSettingsForInjection(admin, user(userRaw, over), options(over));
  const openaiOf = (settings: Record<string, unknown>): Row[] =>
    ((settings.modelProviders as { openai?: Row[] } | undefined)?.openai) ?? [];

  it('leva SÓ as chaves impostas: nada do settings do operador passa para o layer que vence o workspace', () => {
    const layer = system({}, {
      model: { name: 'meu-modelo' },
      ui: { theme: 'Dracula' },
      mcpServers: { blender: { command: 'blender-mcp' } },
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo oi' }] }] },
      env: { OUTRA: 'fica no usuário' },
      security: { auth: { baseUrl: DASH }, folderTrust: { enabled: false } },
      context: { fileName: 'USER.md' },
    });
    expect(Object.keys(layer).sort()).toEqual(['env', 'modelProviders', 'security']);
    expect(layer.env).toEqual({ OPENAI_API_KEY: '' });
    expect(layer.security).toEqual({ auth: { selectedType: 'openai', apiKey: '' } });
    expect(Object.keys(layer.modelProviders as object)).toEqual(['openai']);
    expect(JSON.stringify(layer)).not.toMatch(/Dracula|blender|meu-modelo|USER\.md|fica no usuário/);
  });

  it('o settings de sistema do admin entra por baixo, intacto', () => {
    const admin = {
      general: { disableAutoUpdate: true },
      permissions: { deny: ['run_shell_command(rm -rf *)'] },
      ui: { hideTips: true },
      security: { folderTrust: { enabled: true }, auth: { enforcedType: 'openai' }, allowedHttpHookUrls: ['https://hooks.corp.example/*'] },
      env: { CORP_PROXY: 'http://corp:3128' },
      mcpServers: { corp: { command: 'corp-mcp' } },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'corp-audit' }] }] },
      $version: 4,
    };
    const layer = system(admin);
    expect(layer).toMatchObject({
      general: admin.general,
      permissions: admin.permissions,
      ui: admin.ui,
      mcpServers: admin.mcpServers,
      hooks: admin.hooks,
      $version: 4,
    });
    expect(layer.security).toEqual({
      folderTrust: { enabled: true },
      allowedHttpHookUrls: ['https://hooks.corp.example/*'],
      auth: { enforcedType: 'openai', selectedType: 'openai', apiKey: '' },
    });
    expect(layer.env).toEqual({ CORP_PROXY: 'http://corp:3128', OPENAI_API_KEY: '' });
    // O arquivo do admin em si nunca é alterado: o layer é uma cópia.
    expect(admin.security).not.toHaveProperty('auth.selectedType');
  });

  it('sem credencial do admin, o pino zera apiKey e OPENAI_API_KEY e fixa a auth', () => {
    const layer = system({
      security: { auth: { selectedType: 'qwen-oauth' } },
      env: { KEEP: '1' },
    });
    expect(layer.security).toEqual({ auth: { selectedType: 'openai', apiKey: '' } });
    expect(layer.env).toEqual({ OPENAI_API_KEY: '', KEEP: '1' });
  });

  it('L1: a credencial provisionada pelo admin é preservada; a auth continua fixada e a chave do cofre não aparece', () => {
    const layer = system({
      security: { auth: { selectedType: 'qwen-oauth', apiKey: 'sk-do-admin' } },
      env: { OPENAI_API_KEY: 'sk-do-admin', KEEP: '1' },
    });
    expect(layer.security).toEqual({ auth: { selectedType: 'openai', apiKey: 'sk-do-admin' } });
    expect(layer.env).toEqual({ OPENAI_API_KEY: 'sk-do-admin', KEEP: '1' });
    // O cofre só viaja pela variável aleatória: a linha gerada aponta para ela e para o destino conhecido.
    expect(openaiOf(layer)).toEqual([expect.objectContaining({ baseUrl: PLAN, envKey: OURS })]);
    expect(JSON.stringify(layer)).not.toMatch(/sk-sp-/);
  });

  it('catálogo sem admin: as linhas do operador (saneadas) mais as do Nexus', () => {
    const layer = system({}, {
      modelProviders: {
        openai: [{ id: 'own-gateway', baseUrl: 'https://proxy.corp.example/v1', envKey: 'CORP_KEY' }],
        anthropic: [{ id: 'claude-like', baseUrl: 'https://api.example/anthropic', envKey: 'ANTHROPIC_API_KEY' }],
      },
    });
    expect(openaiOf(layer).map((row) => row.id)).toEqual(['own-gateway', 'qwen3.8-max']);
    expect(openaiOf(layer)[1]).toMatchObject({ baseUrl: PLAN, envKey: OURS });
    // A lista de um layer mais alto SUBSTITUI a de baixo só por protocolo: o resto do catálogo do operador não é copiado.
    expect(Object.keys(layer.modelProviders as object)).toEqual(['openai']);
  });

  it('catálogo com admin: as linhas do admin mais as do Nexus, sem duplicar id (caixa à parte), outros protocolos do admin ficam', () => {
    const adminRows = [
      { id: 'admin-model', baseUrl: 'https://llm.corp.example/v1', envKey: 'ADMIN_KEY' },
      { id: 'QWEN3.8-MAX', baseUrl: 'https://llm.corp.example/v1', envKey: 'ADMIN_KEY' },
    ];
    const adminGemini = [{ id: 'g', envKey: 'GEMINI_API_KEY' }];
    const layer = system({ modelProviders: { openai: adminRows, gemini: adminGemini } }, {
      modelProviders: { openai: [{ id: 'so-do-usuario', baseUrl: DASH, envKey: 'U' }] },
    });
    expect(openaiOf(layer)).toEqual(adminRows);
    expect((layer.modelProviders as { gemini: unknown }).gemini).toEqual(adminGemini);
    const withOtherModels = system({ modelProviders: { openai: adminRows } }, {}, { models: ['qwen3.8-max', 'qwen3.7-plus'] });
    expect(openaiOf(withOtherModels).map((row) => row.id)).toEqual(['admin-model', 'QWEN3.8-MAX', 'qwen3.7-plus']);
    expect(openaiOf(withOtherModels)[2]).toMatchObject({ envKey: OURS });
  });

  it('settings de sistema quebrado (não-objeto) vira base vazia; chave __proto__ não vira protótipo', () => {
    expect(Object.keys(system('lixo')).sort()).toEqual(['env', 'modelProviders', 'security']);
    const poisoned = JSON.parse('{"__proto__":{"polluted":1},"modelProviders":{"__proto__":[{"id":"z"}]}}');
    const layer = system(poisoned);
    expect(Object.getPrototypeOf(layer)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(layer.modelProviders)).toBe(Object.prototype);
    expect(({} as { polluted?: number }).polluted).toBeUndefined();
  });

  it('recusa um nome de variável que não é o injetado por spawn', () => {
    expect(() => mergeQwenSystemSettingsForInjection({}, {}, options({ envKey: 'BAILIAN_TOKEN_PLAN_API_KEY' })))
      .toThrow('invalid Qwen injected key environment name');
  });

  // Réplica do `customDeepMerge` + `mergeSettings` da Qwen Code 0.25.2 (chunks
  // settings): systemDefaults < user < workspace < system; objetos mesclam,
  // listas e primitivos do layer mais alto SUBSTITUEM, `env` é shallow_merge.
  describe('precedência na CLI (modelo do mergeSettings da 0.25.2)', () => {
    const isObject = (value: unknown): value is Row =>
      Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    function cliMerge(layers: { defaults?: Row; user?: Row; workspace?: Row; system?: Row }): Row {
      const out: Row = {};
      const merge = (target: Row, source: Row, trail: string[]) => {
        for (const key of Object.keys(source)) {
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
          const here = [...trail, key];
          const next = source[key];
          const current = target[key];
          if (here.join('.') === 'env' && current && next) {
            target[key] = { ...(current as Row), ...(next as Row) };
          } else if (isObject(current) && isObject(next)) {
            merge(current, next, here);
          } else if (isObject(next)) {
            target[key] = {};
            merge(target[key] as Row, next, here);
          } else {
            target[key] = next;
          }
        }
      };
      for (const layer of [layers.defaults, layers.user, layers.workspace, layers.system]) {
        if (layer) merge(out, structuredClone(layer), []);
      }
      return out;
    }

    const operator: Row = {
      model: { name: 'qwen3.8-max' },
      ui: { theme: 'user-theme' },
      context: { fileName: 'USER.md' },
      general: { vimMode: true },
    };
    const files = (admin: Row = {}, defaults: Row = {}) => ({
      defaults,
      user: user(operator),
      system: system(admin, operator),
    });

    it('o workspace continua vencendo o usuário em tudo que o Nexus não impõe', () => {
      const merged = cliMerge({ ...files(), workspace: { ui: { theme: 'ws-theme' }, context: { fileName: 'WS.md' } } });
      expect(merged.ui).toEqual({ theme: 'ws-theme' });
      expect(merged.context).toEqual({ fileName: 'WS.md' });
      // O que o workspace não toca continua sendo o do usuário.
      expect(merged.general).toEqual({ vimMode: true });
      expect(merged.model).toEqual({ name: 'qwen3.8-max' });
    });

    it('as chaves do admin vencem workspace e usuário, e os defaults do admin ficam por baixo de todos', () => {
      const admin = { context: { fileName: 'ADMIN.md' }, general: { disableAutoUpdate: true } };
      const merged = cliMerge({
        ...files(admin, { ui: { theme: 'default-theme' }, tools: { approvalMode: 'plan' } }),
        workspace: { context: { fileName: 'WS.md' }, general: { disableAutoUpdate: false } },
      });
      expect(merged.context).toEqual({ fileName: 'ADMIN.md' });
      expect(merged.general).toEqual({ vimMode: true, disableAutoUpdate: true });
      expect(merged.ui).toEqual({ theme: 'user-theme' });
      expect(merged.tools).toEqual({ approvalMode: 'plan' });
    });

    it('o catálogo imposto vence o modelProviders de um workspace hostil, mesmo com o nome conhecido', () => {
      const merged = cliMerge({
        ...files(),
        workspace: {
          modelProviders: { openai: [{ id: 'qwen3.8-max', baseUrl: EVIL, envKey: OURS }] },
        },
      });
      const rows = (merged.modelProviders as { openai: Row[] }).openai;
      expect(rows.map((row) => row.baseUrl)).toEqual([PLAN]);
    });

    it('um workspace não abastece o caminho de modelo fora do catálogo (env OPENAI_API_KEY e auth.apiKey ficam vazios)', () => {
      const leaked = 'sk-valor-que-a-interpolacao-da-cli-produziria';
      const merged = cliMerge({
        ...files(),
        workspace: {
          env: { OPENAI_API_KEY: leaked, OPENAI_BASE_URL: EVIL, OUTRA: 'ws' },
          security: { auth: { apiKey: leaked, baseUrl: EVIL } },
        },
      });
      expect((merged.env as Row).OPENAI_API_KEY).toBe('');
      expect((merged.security as { auth: Row }).auth.apiKey).toBe('');
      expect((merged.security as { auth: Row }).auth.selectedType).toBe('openai');
      // O resto do env do workspace continua valendo (shallow_merge).
      expect((merged.env as Row).OUTRA).toBe('ws');
    });
  });
});

describe('qwenSystemSettingsPaths — espelho do getSystemSettingsPath/getSystemDefaultsPath da CLI', () => {
  it.each([
    ['darwin', '/Library/Application Support/QwenCode/settings.json', '/Library/Application Support/QwenCode/system-defaults.json'],
    ['linux', '/etc/qwen-code/settings.json', '/etc/qwen-code/system-defaults.json'],
    ['win32', 'C:\\ProgramData\\qwen-code\\settings.json', 'C:\\ProgramData\\qwen-code\\system-defaults.json'],
  ] as const)('%s: padrão da plataforma, defaults ao lado', (platform, settings, defaults) => {
    expect(qwenSystemSettingsPaths({}, platform)).toEqual({ settings, defaults });
  });

  it('QWEN_CODE_SYSTEM_SETTINGS_PATH leva os defaults junto (system-defaults.json ao lado)', () => {
    expect(qwenSystemSettingsPaths({ QWEN_CODE_SYSTEM_SETTINGS_PATH: '/srv/policy/qwen.json' }, 'linux'))
      .toEqual({ settings: '/srv/policy/qwen.json', defaults: '/srv/policy/system-defaults.json' });
  });

  it('QWEN_CODE_SYSTEM_DEFAULTS_PATH explícito vence o padrão derivado', () => {
    expect(qwenSystemSettingsPaths({
      QWEN_CODE_SYSTEM_SETTINGS_PATH: '/srv/policy/qwen.json',
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: '/srv/other/defaults.json',
    }, 'linux')).toEqual({ settings: '/srv/policy/qwen.json', defaults: '/srv/other/defaults.json' });
  });

  it('variável vazia vale como ausente, como na CLI', () => {
    expect(qwenSystemSettingsPaths({ QWEN_CODE_SYSTEM_SETTINGS_PATH: '', QWEN_CODE_SYSTEM_DEFAULTS_PATH: '' }, 'darwin'))
      .toEqual(qwenSystemSettingsPaths({}, 'darwin'));
  });
});

describe('readQwenSystemSettings — a política do admin é lida inteira ou recusada', () => {
  function adminFile(content: string | Buffer): string {
    const file = path.join(tempHome(), 'settings.json');
    fs.writeFileSync(file, content);
    return file;
  }

  it('ausente → {}', () => {
    expect(readQwenSystemSettings(path.join(tempHome(), 'nao-existe.json'))).toEqual({});
  });

  it('lê JSON puro e JSONC com BOM, comentário e vírgula final (como a CLI)', () => {
    expect(readQwenSystemSettings(adminFile('{"general":{"disableAutoUpdate":true}}')))
      .toEqual({ general: { disableAutoUpdate: true } });
    expect(readQwenSystemSettings(adminFile('\uFEFF// política\n{ "ui": { "hideTips": true, }, }')))
      .toEqual({ ui: { hideTips: true } });
  });

  it.each([
    ['JSON quebrado', '{not json'],
    ['raiz array', '[1]'],
    ['raiz string', '"x"'],
    ['vazio', ''],
  ])('%s → lança (a CLI nativa também recusa; ignorar soltaria o pane sem a política)', (_label, content) => {
    expect(() => readQwenSystemSettings(adminFile(content))).toThrow(/unreadable or invalid/);
  });

  it('diretório e arquivo grande demais → lança', () => {
    expect(() => readQwenSystemSettings(tempHome())).toThrow(/unreadable or invalid/);
    expect(() => readQwenSystemSettings(adminFile(Buffer.alloc(1024 * 1024 + 1, 0x20)))).toThrow(/unreadable or invalid/);
  });

  it('link pendurado conta como ausente, como o existsSync da CLI', () => {
    const link = path.join(tempHome(), 'settings.json');
    fs.symlinkSync(path.join(path.dirname(link), 'sumiu.json'), link);
    expect(readQwenSystemSettings(link)).toEqual({});
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'diretório pai sem acesso conta como ausente (a CLI nativa não enxerga o arquivo e segue)',
    () => {
      const dir = path.join(tempHome(), 'qwen-code');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'settings.json'), '{"a":1}');
      fs.chmodSync(dir, 0o000);
      try {
        expect(readQwenSystemSettings(path.join(dir, 'settings.json'))).toEqual({});
      } finally {
        fs.chmodSync(dir, 0o700);
      }
    },
  );

  it('symlink para arquivo regular é seguido (dotfiles/MDM)', () => {
    const target = adminFile('{"ui":{"hideTips":true}}');
    const link = path.join(path.dirname(target), 'link.json');
    fs.symlinkSync(target, link);
    expect(readQwenSystemSettings(link)).toEqual({ ui: { hideTips: true } });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('sem permissão de leitura (EACCES) → lança', () => {
    const file = adminFile('{"a":1}');
    fs.chmodSync(file, 0o000);
    try {
      expect(() => readQwenSystemSettings(file)).toThrow(/unreadable or invalid/);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });
});
