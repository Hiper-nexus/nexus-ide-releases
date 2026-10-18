import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mergeQwenSettingsForInjection,
  qwenSettingsHasCredential,
  readQwenOperatorSettings,
  readQwenSettingsSummary,
  readQwenSettingsSummaryAsync,
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

describe('F-1565: resolveQwenInjectionBaseUrl', () => {
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

describe('F-1565: mergeQwenSettingsForInjection', () => {
  const PLAN = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
  const PLAN_CN = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
  const DASH = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const OURS = 'BAILIAN_TOKEN_PLAN_API_KEY';
  type Row = Record<string, unknown>;
  const rowsOf = (merged: Record<string, unknown>, type = 'openai'): Row[] =>
    (merged.modelProviders as Record<string, Row[]>)[type] ?? [];
  const options = (over: Partial<Parameters<typeof mergeQwenSettingsForInjection>[1]> = {}) => ({
    baseUrl: PLAN,
    models: [] as string[],
    tokenPlanKey: true,
    ...over,
  });

  it('gera as entradas modelProviders com envKey + baseUrl, sem segredo, e força auth openai', () => {
    const merged = mergeQwenSettingsForInjection(null, {
      baseUrl: PLAN,
      models: ['qwen3.8-max', 'qwen3.7-plus'],
      tokenPlanKey: true,
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

  it('A1: linha de outro protocolo alimentada pela nossa env em host não confiável é descartada; em host de plano fica', () => {
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
    expect(rowsOf(merged, 'anthropic').map((row) => row.id)).toEqual(['p', 'outra-env']);
    expect(rowsOf(merged, 'anthropic')[0]).toEqual(planRow);
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
      baseUrl: PLAN, models: ['qwen3.8-max'], tokenPlanKey: true,
    });
    expect(rowsOf(merged)).toHaveLength(1);
  });
});

describe('F-1565 A1: destino da chave só por autoridade/porta/caminho canônicos', () => {
  const PLAN_CN = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
  const PLAN_SG = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
  const OURS = 'BAILIAN_TOKEN_PLAN_API_KEY';
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
      { baseUrl: PLAN_SG, models: [], tokenPlanKey: true },
    );
    const rows = (merged.modelProviders as { openai: Array<{ id: string; baseUrl: string }> }).openai;
    expect(rows.find((r) => r.id === 'ok')?.baseUrl).toBe(PLAN_CN);
    for (const i of [0, 1, 2]) expect(rows.find((r) => r.id === `x${i}`)?.baseUrl).toBe(PLAN_SG);
  });
});

describe('F-1565 M5: o resumo lê o settings com o mesmo parser tolerante do overlay', () => {
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
