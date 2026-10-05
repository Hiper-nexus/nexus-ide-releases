#!/usr/bin/env node
/**
 * Assina o `SHA256SUMS-linux-x64.txt` de uma versão Linux para o auto-update do app.
 *
 *   node scripts/sign-linux-update.mjs --sums <SHA256SUMS-linux-x64.txt> [--out <arquivo.sig>] [--key <pem>]
 *
 * A chave privada Ed25519 fica FORA do repositório e do container de build
 * (padrão: ~/.config/nexus-release/linux-update-ed25519.pem, modo 0600). O script recusa chave
 * legível por outros, chave cujo id não esteja entre as chaves embutidas no app
 * (src/main/linux-update-signing.ts) e arquivo de somas malformado; depois de assinar,
 * verifica a própria assinatura. Saída: o `.sig` (base64) ao lado das somas.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUMS_LINE_RE = /^([0-9a-f]{64}) {2}([A-Za-z0-9._+-]{1,120})$/u;
const SIGNING_SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'linux-update-signing.ts');

export function embeddedKeyIds(source = fs.readFileSync(SIGNING_SOURCE, 'utf8')) {
  return [...source.matchAll(/id:\s*'([0-9a-f]{16})'/gu)].map((match) => match[1]);
}

export function validateSums(text) {
  if (!text || Buffer.byteLength(text, 'utf8') > 4096) throw new Error('arquivo de somas vazio ou grande demais');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const names = new Set();
  for (const line of lines) {
    const match = SUMS_LINE_RE.exec(line);
    if (!match || names.has(match[2])) throw new Error(`linha inválida no arquivo de somas: ${JSON.stringify(line.slice(0, 80))}`);
    names.add(match[2]);
  }
  if (![...names].some((name) => /^NexusIDE-linux-x64-\d+\.\d+\.\d+\.zip$/u.test(name))) {
    throw new Error('o arquivo de somas não lista o ZIP portátil do Linux');
  }
  return names;
}

export function signSums({ sumsPath, keyPath, outPath, knownKeyIds = embeddedKeyIds() }) {
  const stat = fs.statSync(keyPath);
  if ((stat.mode & 0o077) !== 0) throw new Error(`a chave privada precisa ser 0600 (está ${(stat.mode & 0o777).toString(8)})`);
  const text = fs.readFileSync(sumsPath, 'utf8');
  validateSums(text);
  const privateKey = createPrivateKey(fs.readFileSync(keyPath));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('a chave precisa ser Ed25519');
  const publicKey = createPublicKey(privateKey);
  const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
  if (!knownKeyIds.includes(keyId)) throw new Error(`a chave ${keyId} não está embutida no app; o app recusaria a assinatura`);
  const data = Buffer.from(text, 'utf8');
  const signature = sign(null, data, privateKey);
  if (!verify(null, data, publicKey, signature)) throw new Error('a assinatura recém-feita não verifica');
  const target = outPath ?? `${sumsPath}.sig`;
  fs.writeFileSync(target, `${signature.toString('base64')}\n`, { mode: 0o644 });
  return { keyId, outPath: target };
}

function main(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) args.set(argv[index], argv[index + 1]);
  const sumsPath = args.get('--sums');
  if (!sumsPath) throw new Error('uso: sign-linux-update.mjs --sums <SHA256SUMS-linux-x64.txt> [--out <sig>] [--key <pem>]');
  const keyPath = args.get('--key') ?? path.join(os.homedir(), '.config', 'nexus-release', 'linux-update-ed25519.pem');
  const result = signSums({ sumsPath: path.resolve(sumsPath), keyPath, outPath: args.get('--out') });
  console.log(`assinado com a chave ${result.keyId}: ${result.outPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`sign-linux-update: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
