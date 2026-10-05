/**
 * Assinatura das atualizações do Linux (ZIP portátil que se atualiza sozinho).
 *
 * O GitHub entrega o arquivo, mas quem garante que ele é nosso é esta chave: o
 * `SHA256SUMS-linux-x64.txt` de cada versão é assinado com Ed25519 (`.sig`, base64) fora do
 * container de build, e o app só confia no ZIP cujo SHA-256 está nesse arquivo assinado.
 * Conta do GitHub invadida sozinha não basta para empurrar código para quem já tem o app.
 *
 * Rotação: o app aceita várias chaves públicas. Uma chave nova entra na lista numa versão
 * assinada pela antiga; só depois a antiga sai. A privada nunca vem para o repositório:
 * vive em `~/.config/nexus-release/` de quem publica (0600). Ver docs/SECURITY.md.
 */
import { createPublicKey, createHash, verify } from 'node:crypto';

export interface UpdateSigningKey {
  /** Primeiros 16 hex do SHA-256 do SPKI DER; só para log e rotação. */
  readonly id: string;
  readonly publicKeyPem: string;
}

export const UPDATE_SIGNING_KEYS: readonly UpdateSigningKey[] = Object.freeze([
  {
    id: '146d8273eac73536',
    publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAzpgEWnFnledDLTwALTuTNs8D8Nkvsfiu/subSWO1pYA=
-----END PUBLIC KEY-----
`,
  },
]);

/** O arquivo assinado é pequeno (3 linhas); qualquer coisa maior que isso é suspeita. */
export const SUMS_MAX_BYTES = 4096;
export const SIGNATURE_BASE64_MAX_CHARS = 256;

const SUMS_LINE_RE = /^([0-9a-f]{64}) {2}([A-Za-z0-9._+-]{1,120})$/u;

export function keyIdOf(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/** `true` só se algum dos `keys` assinou exatamente estes bytes. Nunca lança. */
export function verifyDetachedSignature(
  data: Buffer,
  signatureBase64: string,
  keys: readonly UpdateSigningKey[] = UPDATE_SIGNING_KEYS,
): { ok: true; keyId: string } | { ok: false } {
  try {
    const text = signatureBase64.trim();
    if (!text || text.length > SIGNATURE_BASE64_MAX_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/u.test(text)) {
      return { ok: false };
    }
    const signature = Buffer.from(text, 'base64');
    if (signature.length !== 64) return { ok: false }; // Ed25519 tem sempre 64 bytes
    for (const key of keys) {
      if (verify(null, data, createPublicKey(key.publicKeyPem), signature)) {
        return { ok: true, keyId: key.id };
      }
    }
  } catch {
    // chave ou assinatura malformada: não confia
  }
  return { ok: false };
}

/**
 * Lê o `SHA256SUMS-linux-x64.txt` com rigor: só linhas `<64 hex>␣␣<nome>`, nome sem barra nem
 * caracteres estranhos, sem duplicata. Qualquer desvio rejeita o arquivo inteiro.
 */
export function parseSums(text: string): ReadonlyMap<string, string> | null {
  if (text.length === 0 || Buffer.byteLength(text, 'utf8') > SUMS_MAX_BYTES) return null;
  const sums = new Map<string, string>();
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0 || lines.length > 16) return null;
  for (const line of lines) {
    const match = SUMS_LINE_RE.exec(line);
    if (!match) return null;
    const [, sha, name] = match;
    if (name === '.' || name === '..' || sums.has(name)) return null;
    sums.set(name, sha);
  }
  return sums;
}

/**
 * Verifica a assinatura do arquivo de somas e devolve o SHA-256 esperado do `assetName`.
 * `null` = não confiar em nada (assinatura inválida, arquivo malformado ou asset ausente).
 */
export function trustedSha256For(
  sumsText: string,
  signatureBase64: string,
  assetName: string,
  keys: readonly UpdateSigningKey[] = UPDATE_SIGNING_KEYS,
): { sha256: string; keyId: string } | null {
  if (Buffer.byteLength(sumsText, 'utf8') > SUMS_MAX_BYTES) return null;
  const signed = verifyDetachedSignature(Buffer.from(sumsText, 'utf8'), signatureBase64, keys);
  if (!signed.ok) return null;
  const sums = parseSums(sumsText);
  const sha256 = sums?.get(assetName);
  return sha256 ? { sha256, keyId: signed.keyId } : null;
}
