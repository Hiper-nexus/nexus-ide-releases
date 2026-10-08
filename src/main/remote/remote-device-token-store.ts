import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  REMOTE_DEVICE_SCOPES,
  type RemoteDeviceScope,
} from '../../shared/remote-types';
import { normalizeRemoteDeviceScopes } from './device-scopes';
import { writeJsonAtomic } from '../util/atomic-write';
import {
  parseRemoteDeviceIdentity,
  remoteDeviceKeyFingerprint,
  type RemoteDevicePublicKey,
} from './remote-device-authority';

export interface RemoteDeviceTokenRecord {
  readonly id: string;
  readonly hash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly deviceId: string;
  readonly devicePublicKey: RemoteDevicePublicKey;
  readonly deviceKeyFingerprint: string;
  /** MOB-12: o que este aparelho pode fazer (escolhido no pareamento). */
  readonly scopes: readonly RemoteDeviceScope[];
}

interface TokenFile {
  readonly tokens: RemoteDeviceTokenRecord[];
}

const TOKENS_FILE = path.join(
  os.homedir(),
  '.nexus',
  'remote-bridge',
  'tokens.json',
);
const DEFAULT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function resolveTokenTtlMs(): number {
  if (process.env.NODE_ENV !== 'test') return DEFAULT_TOKEN_TTL_MS;
  const configured = Number(process.env.NEXUS_REMOTE_TOKEN_TTL_MS);
  return Number.isSafeInteger(configured) && configured >= 100
    ? configured
    : DEFAULT_TOKEN_TTL_MS;
}

const TOKEN_TTL_MS = resolveTokenTtlMs();
let tokenCache: RemoteDeviceTokenRecord[] | null = null;

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeTokens(tokens: RemoteDeviceTokenRecord[]): void {
  writeJsonAtomic(TOKENS_FILE, { tokens });
  tokenCache = tokens;
}

function loadTokens(): RemoteDeviceTokenRecord[] {
  if (tokenCache) return tokenCache;
  try {
    const raw = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')) as TokenFile;
    tokenCache = (raw.tokens ?? []).filter(
      (token) =>
        typeof token.id === 'string' &&
        typeof token.hash === 'string' &&
        Number.isFinite(token.expiresAt) &&
        typeof token.projectId === 'string' &&
        typeof token.checkoutId === 'string' &&
        typeof token.deviceId === 'string' &&
        typeof token.deviceKeyFingerprint === 'string' &&
        parseRemoteDeviceIdentity({
          deviceId: token.deviceId,
          publicKey: token.devicePublicKey,
        }) !== null,
    )
      // MOB-12: grant sem `scopes` (pareado antes) = todos os escopos de hoje;
      // a próxima gravação do arquivo persiste a migração.
      .map((token) => ({ ...token, scopes: normalizeRemoteDeviceScopes(token.scopes) }));
  } catch {
    tokenCache = [];
  }
  return tokenCache;
}

function readLiveTokens(): RemoteDeviceTokenRecord[] {
  const all = loadTokens();
  const live = all.filter((token) => token.expiresAt > Date.now());
  if (live.length !== all.length) writeTokens(live);
  return live;
}

export function issueRemoteDeviceToken(
  scope: ProjectExecutionScope,
  deviceId: string,
  devicePublicKey: RemoteDevicePublicKey,
  scopes: readonly RemoteDeviceScope[] = REMOTE_DEVICE_SCOPES,
): {
  readonly token: string;
  readonly expiresAt: number;
  readonly record: RemoteDeviceTokenRecord;
} {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const record: RemoteDeviceTokenRecord = {
    id: crypto.randomUUID(),
    hash: sha256Hex(token),
    createdAt: Date.now(),
    expiresAt,
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    deviceId,
    devicePublicKey,
    deviceKeyFingerprint: remoteDeviceKeyFingerprint(devicePublicKey),
    scopes: normalizeRemoteDeviceScopes([...scopes]),
  };
  writeTokens([...readLiveTokens(), record]);
  return { token, expiresAt, record };
}

export function findRemoteDeviceToken(
  token: string,
  scope: ProjectExecutionScope,
  deviceId: string,
): RemoteDeviceTokenRecord | undefined {
  if (!token || !deviceId) return undefined;
  const hash = sha256Hex(token);
  const right = Buffer.from(hash, 'hex');
  return readLiveTokens().find((record) => {
    if (
      record.projectId !== scope.projectId ||
      record.checkoutId !== scope.checkoutId ||
      record.deviceId !== deviceId
    ) {
      return false;
    }
    const left = Buffer.from(record.hash, 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  });
}

export function remoteDeviceTokenExists(input: {
  readonly tokenId: string;
  readonly deviceId: string;
  readonly scope: ProjectExecutionScope;
}): boolean {
  return readLiveTokens().some(
    (token) =>
      token.id === input.tokenId &&
      token.deviceId === input.deviceId &&
      token.projectId === input.scope.projectId &&
      token.checkoutId === input.scope.checkoutId,
  );
}

export function revokeRemoteDeviceTokens(
  scope?: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
): void {
  writeTokens(
    scope
      ? readLiveTokens().filter(
          (token) =>
            token.projectId !== scope.projectId ||
            token.checkoutId !== scope.checkoutId,
        )
      : [],
  );
}

export function countRemoteDeviceTokens(
  scope?: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
): number {
  if (!scope) return 0;
  return readLiveTokens().filter(
    (token) =>
      token.projectId === scope.projectId &&
      token.checkoutId === scope.checkoutId,
  ).length;
}

// MOB-12 (F-1022): escopos do grant, lidos a cada pedido (a edição no desktop
// vale no próximo pedido do aparelho, sem reconectar).

/** Escopos vivos de um grant; grant inexistente/expirado = nenhum. */
export function remoteDeviceTokenScopes(tokenId: string): readonly RemoteDeviceScope[] {
  return readLiveTokens().find((token) => token.id === tokenId)?.scopes ?? [];
}

export function listRemoteDeviceTokens(
  scope?: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
): RemoteDeviceTokenRecord[] {
  if (!scope) return [];
  return readLiveTokens().filter(
    (token) =>
      token.projectId === scope.projectId &&
      token.checkoutId === scope.checkoutId,
  );
}

export function setRemoteDeviceTokenScopes(input: {
  readonly tokenId: string;
  readonly scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>;
  readonly scopes: readonly RemoteDeviceScope[];
}): boolean {
  const tokens = readLiveTokens();
  const index = tokens.findIndex(
    (token) =>
      token.id === input.tokenId &&
      token.projectId === input.scope.projectId &&
      token.checkoutId === input.scope.checkoutId,
  );
  if (index < 0) return false;
  const next = [...tokens];
  next[index] = { ...tokens[index]!, scopes: normalizeRemoteDeviceScopes([...input.scopes]) };
  writeTokens(next);
  return true;
}
