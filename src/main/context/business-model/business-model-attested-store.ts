import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';

/**
 * Registro, FORA do checkout, dos hashes do modelo de negócio que o Main
 * extraiu, revisou por re-derivação e aplicou. É ele que autoriza injetar o doc
 * como contexto: a atestação em `.context/nexus/attestations/` mora onde o
 * agente escreve, então vira só espelho informativo.
 *
 * Só `runBusinessModelBootstrap` grava aqui. Por projeto (worktrees do mesmo
 * projeto dividem): guarda os últimos hashes para uma aba atrás do checkout
 * principal continuar lendo o doc revisado que ela tem.
 */

const MAX_HASHES = 16;
const MAX_STORE_BYTES = 64 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

let configuredDir: string | null = null;

/** Base explícita (testes, ambientes fora do Electron). `null` volta ao padrão. */
export function configureBusinessModelAttestedStore(dir: string | null): void {
  configuredDir = dir;
}

export function isBusinessModelAttestedStoreConfigured(): boolean {
  return configuredDir !== null;
}

function storeDir(): string {
  if (configuredDir) return configuredDir;
  // Require tardio: fora do Electron (vitest) `electron` não expõe `app`.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electron = require('electron') as { app?: { getPath(name: 'userData'): string } };
  if (typeof electron?.app?.getPath !== 'function') {
    throw new Error('business model attested store requires configureBusinessModelAttestedStore outside Electron');
  }
  return path.join(electron.app.getPath('userData'), 'business-model-attested');
}

function storeFile(scope: ProjectExecutionScope): string {
  const key = createHash('sha256')
    .update(`${scope.installationId}\0${scope.projectId}`)
    .digest('hex')
    .slice(0, 32);
  return path.join(storeDir(), `${key}.json`);
}

function readHashes(file: string): string[] {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_STORE_BYTES) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { hashes?: unknown };
    return Array.isArray(raw.hashes)
      ? raw.hashes.filter((hash): hash is string => typeof hash === 'string' && HASH_PATTERN.test(hash))
      : [];
  } catch {
    return [];
  }
}

/** O Main aplicou (ou re-derivou idêntico) o doc com estes bytes. */
export function recordAttestedBusinessModelHash(
  scope: ProjectExecutionScope,
  hash: string,
): void {
  if (!HASH_PATTERN.test(hash)) throw new Error('invalid business model hash');
  const file = storeFile(scope);
  const hashes = [hash, ...readHashes(file).filter((known) => known !== hash)].slice(0, MAX_HASHES);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, hashes }), { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** Nunca lança: store ausente/ilegível não atesta nada. */
export function isAttestedBusinessModelHash(
  scope: ProjectExecutionScope,
  hash: string,
): boolean {
  try {
    return readHashes(storeFile(scope)).includes(hash);
  } catch {
    return false;
  }
}
