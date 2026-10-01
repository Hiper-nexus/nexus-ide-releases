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

  it('catálogo lê modelProviders.*[].id — só ids qwen*', () => {
    const home = tempHome();
    writeSettings(home, {
      model: {
        name: 'qwen3.8-max',
        baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
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
          { id: 'not a model!!' },
        ],
      },
    });
    const summary = readQwenSettingsSummary(home);
    expect(summary.baseUrl).toBe(
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    );
    expect(summary.modelIds).toEqual([
      'qwen3.8-max',
      'qwen3.8-max-preview',
      'qwen3.7-max',
      'qwen3.7-plus',
      'qwen3.6-plus',
      'qwen3.6-flash',
    ]);
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
