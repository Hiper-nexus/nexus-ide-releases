import { describe, expect, it, vi } from 'vitest';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { decisionCredentialRevision } from '../decision-models/decision-revision';
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
    isProviderId: id => ['claude', 'codex', 'good', 'bad'].includes(id),
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
  it('round-trips the Clef credential without exposing plaintext or exporting internal authority', () => {
    const source = fakeDeps({ 'clef-env:CLOUDFLARE_API_TOKEN': 'cloudflare-token-123456',
      'auth:account': 'internal-license', 'clef-env:UNRECOGNIZED_SECRET': 'not-portable' });
    const exported = exportSecretsVault(PASS, source);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.bundle).not.toContain('cloudflare-token-123456');
    const target = fakeDeps();
    const before = decisionCredentialRevision();
    expect(importSecretsVault(exported.bundle, PASS, target).ok).toBe(true);
    expect(decisionCredentialRevision()).toBeGreaterThan(before);
    expect(target.store.get('clef-env:CLOUDFLARE_API_TOKEN')).toBe('cloudflare-token-123456');
    expect(target.store.has('auth:account')).toBe(false);
    expect(target.store.has('clef-env:UNRECOGNIZED_SECRET')).toBe(false);
  });
  it('rejeita passphrase curta sem tocar o cofre', () => {
    const deps = fakeDeps({ claude: 'secret-a' });
    expect(exportSecretsVault('short', deps)).toEqual({
      ok: false,
      error: `A passphrase precisa de pelo menos ${MIN_PASSPHRASE_LENGTH} caracteres.`,
    });
    expect(exportSecretsVault('', deps).ok).toBe(false);
  });

  it('cifra o payload — a key em plaintext não aparece no bundle', () => {
    const deps = fakeDeps({ 'claude': 'sk-live-super-secret' });
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
    deps.listKeys = () => ['claude', 'codex'];
    const result = exportSecretsVault(PASS, deps);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.error).toContain('outro Mac');
  });
});

describe('importSecretsVault', () => {
  it('round-trip: export → import regrava as mesmas keys', () => {
    const source = fakeDeps({
      'claude': 'sk-a',
      'voice-env:NEXUS_GITHUB_TOKEN': 'ghp-b',
    });
    const exported = exportSecretsVault(PASS, source);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    const target = fakeDeps();
    const imported = importSecretsVault(exported.bundle, PASS, target);
    expect(imported).toEqual({ ok: true, importedKeys: 2, failedKeys: [] });
    expect(target.store.get('claude')).toBe('sk-a');
    expect(target.store.get('voice-env:NEXUS_GITHUB_TOKEN')).toBe('ghp-b');
  });

  it('recusa passphrase errada e não grava nada', () => {
    const source = fakeDeps({ claude: 'secret-a' });
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

// Um bundle externo não precisa ter sido criado pelo exportador do Nexus.
function externalBundle(secrets: Record<string, string>): string {
  const salt = randomBytes(16), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', pbkdf2Sync(PASS, salt, 210_000, 32, 'sha512'), iv);
  const payload = Buffer.concat([cipher.update(JSON.stringify(secrets)), cipher.final()]);
  return JSON.stringify({ format: SECRETS_BUNDLE_FORMAT, createdAt: new Date().toISOString(),
    kdf: { algo: 'pbkdf2-sha512', iterations: 210_000, salt: salt.toString('base64') },
    cipher: { algo: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    payload: payload.toString('base64') });
}

it.each(['auth:account', 'auth:session', 'auth:license-seal-key', 'system:cron-authority-hmac:v1',
  'agentkey:v1:m:owner:a', 'unknown-provider'])
('N1: recusa todo o bundle com %s antes de qualquer escrita', name => {
  const deps = fakeDeps({ claude: 'previous', 'auth:account': 'revoked' });
  const before = new Map(deps.store);
  expect(importSecretsVault(externalBundle({ claude: 'new-key', [name]: 'forged' }), PASS, deps).ok).toBe(false);
  expect(deps.store).toEqual(before);
});
it('N1: export não lê nem transporta a autoridade interna', () => {
  const deps = fakeDeps({ claude: 'provider-key', 'auth:session': 'opaque-session',
    'auth:license-seal-key': 'internal-seal', 'auth:account': 'revoked-state',
    'system:cron-authority-hmac:v1': 'cron-signing', 'agentkey:v1:m:owner:a': 'private-key' });
  const read = vi.spyOn(deps, 'getSecret');
  const exported = exportSecretsVault(PASS, deps);
  expect(exported).toMatchObject({ ok: true, exportedKeys: 1, skippedKeys: [] });
  expect(read.mock.calls).toEqual([['claude']]);
  if (!exported.ok) return;
  const target = fakeDeps();
  expect(importSecretsVault(exported.bundle, PASS, target)).toEqual({ ok: true, importedKeys: 1, failedKeys: [] });
  expect([...target.store.keys()]).toEqual(['claude']);
});
