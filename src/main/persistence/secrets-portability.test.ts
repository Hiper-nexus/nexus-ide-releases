import { describe, expect, it } from 'vitest';
import {
  MIN_PASSPHRASE_LENGTH,
  SECRETS_BUNDLE_FORMAT,
  exportSecretsVault,
  importSecretsVault,
  type SecretsPortabilityDeps,
} from './secrets-portability';

function fakeDeps(initial: Record<string, string> = {}): SecretsPortabilityDeps & {
  store: Map<string, string>;
} {
  const store = new Map(Object.entries(initial));
  return {
    store,
    listKeys: () => [...store.keys()],
    getSecret: (key) => store.get(key) ?? null,
    setSecret: (key, value) => {
      store.set(key, value);
      return { ok: true };
    },
  };
}

const PASS = 'correct-horse-battery';
const WRONG = 'wrong-horse-battery!';

describe('exportSecretsVault', () => {
  it('rejeita passphrase curta sem tocar o cofre', () => {
    const deps = fakeDeps({ a: 'secret-a' });
    expect(exportSecretsVault('short', deps)).toEqual({
      ok: false,
      error: `A passphrase precisa de pelo menos ${MIN_PASSPHRASE_LENGTH} caracteres.`,
    });
    expect(exportSecretsVault('', deps).ok).toBe(false);
  });

  it('cifra o payload — a key em plaintext não aparece no bundle', () => {
    const deps = fakeDeps({ 'XAI_API_KEY': 'sk-live-super-secret' });
    const result = exportSecretsVault(PASS, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exportedKeys).toBe(1);
    expect(result.skippedKeys).toEqual([]);
    expect(result.bundle).not.toContain('sk-live-super-secret');
    expect(result.bundle).toContain(SECRETS_BUNDLE_FORMAT);
  });

  it('lista keys ilegíveis como skipped e falha quando nada é legível', () => {
    const deps = fakeDeps();
    deps.getSecret = () => null;
    deps.listKeys = () => ['foreign-key-1', 'foreign-key-2'];
    const result = exportSecretsVault(PASS, deps);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.error).toContain('outro Mac');
  });
});

describe('importSecretsVault', () => {
  it('round-trip: export → import regrava as mesmas keys', () => {
    const source = fakeDeps({
      'XAI_API_KEY': 'sk-a',
      'voice-env:NEXUS_GITHUB_TOKEN': 'ghp-b',
    });
    const exported = exportSecretsVault(PASS, source);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    const target = fakeDeps();
    const imported = importSecretsVault(exported.bundle, PASS, target);
    expect(imported).toEqual({ ok: true, importedKeys: 2, failedKeys: [] });
    expect(target.store.get('XAI_API_KEY')).toBe('sk-a');
    expect(target.store.get('voice-env:NEXUS_GITHUB_TOKEN')).toBe('ghp-b');
  });

  it('recusa passphrase errada e não grava nada', () => {
    const source = fakeDeps({ a: 'secret-a' });
    const exported = exportSecretsVault(PASS, source);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    const target = fakeDeps();
    const imported = importSecretsVault(exported.bundle, WRONG, target);
    expect(imported).toEqual({
      ok: false,
      error: 'Passphrase incorreta ou bundle corrompido.',
    });
    expect(target.store.size).toBe(0);
  });

  it('recusa formato desconhecido e KDF fraco', () => {
    const deps = fakeDeps();
    expect(importSecretsVault('not-json', PASS, deps)).toEqual({
      ok: false,
      error: 'Bundle inválido ou formato não suportado.',
    });
    const weak = JSON.stringify({
      format: SECRETS_BUNDLE_FORMAT,
      createdAt: new Date().toISOString(),
      kdf: { algo: 'pbkdf2-sha512', iterations: 1_000, salt: 'AA==' },
      cipher: { algo: 'aes-256-gcm', iv: 'AA==', tag: 'AA==' },
      payload: 'AA==',
    });
    expect(importSecretsVault(weak, PASS, deps)).toEqual({
      ok: false,
      error: 'Bundle inválido ou formato não suportado.',
    });
  });

  it('reporta failedKeys quando o safeStorage local recusa uma gravação', () => {
    const source = fakeDeps({ good: 'g', bad: 'b' });
    const exported = exportSecretsVault(PASS, source);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    const target = fakeDeps();
    target.setSecret = (key) =>
      key === 'bad'
        ? { ok: false, error: 'OS secure storage is unavailable; secret was not persisted.' }
        : { ok: true };
    const imported = importSecretsVault(exported.bundle, PASS, target);
    expect(imported).toEqual({ ok: true, importedKeys: 1, failedKeys: ['bad'] });
  });
});
