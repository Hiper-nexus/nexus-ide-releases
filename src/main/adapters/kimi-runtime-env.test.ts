import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  KIMI_TRANSIENT_MODEL_ENV_KEYS,
  buildKimiApiKeyRuntimeEnv,
  parseKimiConfigModelAliases,
  readKimiModelAliases,
} from './kimi-runtime-env';

describe('buildKimiApiKeyRuntimeEnv', () => {
  it('uses Kimi Code official transient-model env without persisting the key', () => {
    expect(
      buildKimiApiKeyRuntimeEnv('sk-kimi', 'kimi-code/kimi-for-coding'),
    ).toEqual({
      KIMI_MODEL_API_KEY: 'sk-kimi',
      KIMI_MODEL_NAME: 'kimi-for-coding',
    });
  });

  it('preserves ordinary model ids and lists every env suppressed for OAuth', () => {
    expect(buildKimiApiKeyRuntimeEnv('sk-kimi', 'kimi-k2.7')).toEqual({
      KIMI_MODEL_API_KEY: 'sk-kimi',
      KIMI_MODEL_NAME: 'kimi-k2.7',
    });
    expect(KIMI_TRANSIENT_MODEL_ENV_KEYS).toContain('KIMI_MODEL_API_KEY');
    expect(KIMI_TRANSIENT_MODEL_ENV_KEYS).toContain('KIMI_MODEL_NAME');
    expect(KIMI_TRANSIENT_MODEL_ENV_KEYS).toContain('KIMI_MODEL_BASE_URL');
    expect(KIMI_TRANSIENT_MODEL_ENV_KEYS).toContain('KIMI_MODEL_THINKING_KEEP');
  });

  it('rejects incomplete transient credentials before spawning Kimi', () => {
    expect(() => buildKimiApiKeyRuntimeEnv('', 'kimi-for-coding')).toThrow(
      'non-empty key',
    );
    expect(() => buildKimiApiKeyRuntimeEnv('sk-kimi', ' ')).toThrow(
      'model name',
    );
  });
});

describe('aliases de modelo do config.toml do Kimi Code', () => {
  const toml = [
    'default_model = "kimi-code/k3"',
    '',
    '[models."kimi-code/kimi-for-coding"]',
    'model = "kimi-for-coding"',
    'display_name = "K2.7 Coding"',
    '[models."kimi-code/k3"] # comentário',
    "[models.'kimi-code/k3-256k']",
    '[providers."kimi-code"]',
    'type = "kimi"',
  ].join('\n');

  it('lê só as chaves de [models], sem provedores nem valores', () => {
    expect(parseKimiConfigModelAliases(toml)).toEqual([
      'kimi-code/kimi-for-coding',
      'kimi-code/k3',
      'kimi-code/k3-256k',
    ]);
    // TOML válido com espaços no cabeçalho e forma inline (Astra, 28/09).
    expect(parseKimiConfigModelAliases('[models . "kimi-code/k3"]\nmodel = "k3"\n')).toEqual(['kimi-code/k3']);
    expect(parseKimiConfigModelAliases('models = { "kimi-code/k3" = { model = "k3" } }\n')).toEqual(['kimi-code/k3']);
    // Arquivo quebrado: cai para a leitura por linha, sem perder o que dá para ler.
    expect(parseKimiConfigModelAliases('[models."kimi-code/k3"]\nmodel = = "k3"\n')).toEqual(['kimi-code/k3']);
  });

  it('lê ~/.kimi-code/config.toml e devolve [] sem config', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-kimi-home-'));
    const saved = process.env.KIMI_CODE_HOME;
    delete process.env.KIMI_CODE_HOME;
    try {
      expect(readKimiModelAliases({ home })).toEqual([]);
      fs.mkdirSync(path.join(home, '.kimi-code'));
      fs.writeFileSync(path.join(home, '.kimi-code', 'config.toml'), toml);
      expect(readKimiModelAliases({ home })).toContain('kimi-code/k3');
      // Perfil do pane (conta escolhida) manda sobre o do Main.
      const pane = path.join(home, 'pane-profile');
      fs.mkdirSync(pane);
      fs.writeFileSync(path.join(pane, 'config.toml'), '[models."kimi-code/k3-256k"]\n');
      expect(readKimiModelAliases({ home, kimiCodeHome: pane })).toEqual(['kimi-code/k3-256k']);
    } finally {
      if (saved !== undefined) process.env.KIMI_CODE_HOME = saved;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
