/**
 * Portabilidade multi-PC do cofre de segredos.
 *
 * `safeStorage` (e portanto `~/.nexus/secrets.enc`) é amarrado ao keychain da
 * máquina: copiar o arquivo para outro Mac deixa o índice legível e todos os
 * blobs indecifráveis — a UI costumava traduzir isso como "redefina a chave",
 * o que parecia perda de dado. Este módulo exporta/importa o conteúdo em um
 * bundle cifrado por passphrase (PBKDF2-SHA512 + AES-256-GCM), independente do
 * keychain de origem. O import regrava cada chave com o `safeStorage` LOCAL.
 *
 * O bundle contém as keys em plaintext DENTRO da cifra: é tão sensível quanto
 * as próprias keys — apague-o depois do import. Nunca logar passphrase, payload
 * ou valores.
 */
import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from 'node:crypto';
import {
  getSecret,
  listSecretKeys,
  setSecret,
  type SecretWriteResult,
} from './secrets-store';

export const SECRETS_BUNDLE_FORMAT = 'nexus-secrets-v1';
/** OWASP 2023 floor for PBKDF2-SHA512. Import rejects weaker bundles. */
const PBKDF2_ITERATIONS = 210_000;
const MIN_ACCEPTABLE_ITERATIONS = 100_000;
export const MIN_PASSPHRASE_LENGTH = 8;

export interface SecretsPortabilityDeps {
  listKeys(): string[];
  getSecret(key: string): string | null;
  setSecret(key: string, value: string): SecretWriteResult;
}

const defaultDeps: SecretsPortabilityDeps = {
  listKeys: listSecretKeys,
  getSecret,
  setSecret,
};

interface PortableVaultBundle {
  format: typeof SECRETS_BUNDLE_FORMAT;
  createdAt: string;
  kdf: { algo: 'pbkdf2-sha512'; iterations: number; salt: string };
  cipher: { algo: 'aes-256-gcm'; iv: string; tag: string };
  payload: string;
}

export type ExportSecretsResult =
  | { ok: true; bundle: string; exportedKeys: number; skippedKeys: string[] }
  | { ok: false; error: string };

export type ImportSecretsResult =
  | { ok: true; importedKeys: number; failedKeys: string[] }
  | { ok: false; error: string };

function assertPassphrase(passphrase: string): string | null {
  if (typeof passphrase !== 'string' || passphrase.trim().length < MIN_PASSPHRASE_LENGTH) {
    return `A passphrase precisa de pelo menos ${MIN_PASSPHRASE_LENGTH} caracteres.`;
  }
  return null;
}

function deriveKey(passphrase: string, salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(passphrase, salt, iterations, 32, 'sha512');
}

/**
 * Export every readable secret into a passphrase-encrypted bundle. Keys the
 * local keychain currently refuses (foreign vault, locked session) are listed
 * as skipped rather than silently dropped.
 */
export function exportSecretsVault(
  passphrase: string,
  deps: SecretsPortabilityDeps = defaultDeps,
): ExportSecretsResult {
  const passError = assertPassphrase(passphrase);
  if (passError) return { ok: false, error: passError };

  const secrets: Record<string, string> = {};
  const skippedKeys: string[] = [];
  for (const key of deps.listKeys()) {
    const value = deps.getSecret(key);
    if (value === null) {
      skippedKeys.push(key);
      continue;
    }
    secrets[key] = value;
  }
  const exportedKeys = Object.keys(secrets).length;
  if (exportedKeys === 0) {
    return {
      ok: false,
      error:
        skippedKeys.length > 0
          ? 'Nenhuma key legível nesta máquina — o cofre parece vir de outro Mac. Export a partir da máquina onde as keys funcionam.'
          : 'Não há keys salvas para exportar.',
    };
  }

  try {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const plain = Buffer.from(JSON.stringify(secrets), 'utf8');
    const payload = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    const bundle: PortableVaultBundle = {
      format: SECRETS_BUNDLE_FORMAT,
      createdAt: new Date().toISOString(),
      kdf: {
        algo: 'pbkdf2-sha512',
        iterations: PBKDF2_ITERATIONS,
        salt: salt.toString('base64'),
      },
      cipher: {
        algo: 'aes-256-gcm',
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
      },
      payload: payload.toString('base64'),
    };
    return {
      ok: true,
      bundle: JSON.stringify(bundle),
      exportedKeys,
      skippedKeys,
    };
  } catch {
    return { ok: false, error: 'Não foi possível cifrar o bundle de keys.' };
  }
}

function parseBundle(bundleText: string): PortableVaultBundle | null {
  try {
    const parsed = JSON.parse(bundleText) as PortableVaultBundle;
    if (parsed?.format !== SECRETS_BUNDLE_FORMAT) return null;
    if (parsed.kdf?.algo !== 'pbkdf2-sha512') return null;
    if (parsed.cipher?.algo !== 'aes-256-gcm') return null;
    if (
      typeof parsed.kdf.iterations !== 'number' ||
      parsed.kdf.iterations < MIN_ACCEPTABLE_ITERATIONS ||
      parsed.kdf.iterations > 5_000_000
    ) {
      return null;
    }
    if (
      typeof parsed.kdf.salt !== 'string' ||
      typeof parsed.cipher.iv !== 'string' ||
      typeof parsed.cipher.tag !== 'string' ||
      typeof parsed.payload !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Import a bundle produced by {@link exportSecretsVault} and re-encrypt each
 * entry with THIS machine's safeStorage. Overwrites same-named keys.
 */
export function importSecretsVault(
  bundleText: string,
  passphrase: string,
  deps: SecretsPortabilityDeps = defaultDeps,
): ImportSecretsResult {
  const passError = assertPassphrase(passphrase);
  if (passError) return { ok: false, error: passError };

  const bundle = parseBundle(bundleText);
  if (!bundle) {
    return { ok: false, error: 'Bundle inválido ou formato não suportado.' };
  }

  let secrets: Record<string, string>;
  try {
    const key = deriveKey(
      passphrase,
      Buffer.from(bundle.kdf.salt, 'base64'),
      bundle.kdf.iterations,
    );
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(bundle.cipher.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(bundle.cipher.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(bundle.payload, 'base64')),
      decipher.final(),
    ]);
    const parsed = JSON.parse(plain.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Payload do bundle inválido.' };
    }
    secrets = parsed as Record<string, string>;
  } catch {
    // Wrong passphrase and tampered payload share this path (GCM auth tag).
    return { ok: false, error: 'Passphrase incorreta ou bundle corrompido.' };
  }

  const entries = Object.entries(secrets).filter(
    ([key, value]) => key.length > 0 && typeof value === 'string' && value.length > 0,
  );
  if (entries.length === 0) {
    return { ok: false, error: 'Bundle sem keys válidas.' };
  }

  const failedKeys: string[] = [];
  let importedKeys = 0;
  for (const [key, value] of entries) {
    const saved = deps.setSecret(key, value);
    if (saved.ok) importedKeys += 1;
    else failedKeys.push(key);
  }
  if (importedKeys === 0) {
    return {
      ok: false,
      error:
        'Nenhuma key foi gravada — o secure storage desta máquina recusou (keychain bloqueado?).',
    };
  }
  return { ok: true, importedKeys, failedKeys };
}
