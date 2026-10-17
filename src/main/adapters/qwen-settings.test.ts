import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  qwenSettingsHasCredential,
  readQwenSettingsSummary,
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
