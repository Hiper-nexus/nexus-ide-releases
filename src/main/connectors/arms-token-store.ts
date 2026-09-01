import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Nexus Arms — conector externo (paridade Overclock 1.3.9–1.3.11).
 *
 * Credencial de longo prazo para orquestradores que NÃO moram num pane
 * (Grok Bot, Cursor): um token bearer que só existe para o endpoint
 * dedicado /arms/mcp (observação de app + eventos com cursor). O arquivo em
 * disco guarda o SHA-256 do token — nunca o valor. O plaintext é mostrado
 * uma única vez na geração/rotação, como fazem GitHub PATs.
 */

const ARMS_DIR = path.join(os.homedir(), '.nexus');
const ARMS_FILE = path.join(ARMS_DIR, 'arms.json');

interface ArmsTokenRecord {
  schemaVersion: 1;
  tokenHash: string;
  createdAt: number;
  rotatedAt?: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

interface ArmsFileState {
  record: ArmsTokenRecord | null;
  revokedAt: number | null;
  createdAt: number | null;
  rotatedAt: number | null;
}

let state: ArmsFileState = { record: null, revokedAt: null, createdAt: null, rotatedAt: null };
let lastUsedFlushAt = 0;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function loadFile(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(ARMS_FILE, 'utf8')) as Partial<ArmsTokenRecord> | null;
    const hasHash =
      raw !== null &&
      typeof raw.tokenHash === 'string' &&
      /^[a-f0-9]{64}$/.test(raw.tokenHash);
    const revokedAt =
      raw !== null && typeof raw.revokedAt === 'number' ? raw.revokedAt : null;
    if (raw && raw.schemaVersion === 1 && typeof raw.createdAt === 'number' && (hasHash || revokedAt !== null)) {
      state = {
        record: hasHash
          ? {
              schemaVersion: 1,
              tokenHash: raw.tokenHash as string,
              createdAt: raw.createdAt,
              ...(raw !== null && typeof raw.rotatedAt === 'number' ? { rotatedAt: raw.rotatedAt } : {}),
              ...(typeof raw.lastUsedAt === 'number' ? { lastUsedAt: raw.lastUsedAt } : {}),
              ...(revokedAt !== null ? { revokedAt } : {}),
            }
          : null,
        revokedAt,
        createdAt: raw.createdAt,
        rotatedAt: raw !== null && typeof raw.rotatedAt === 'number' ? raw.rotatedAt : null,
      };
      return;
    }
  } catch {
    /* arquivo ausente/corrompido = sem token configurado */
  }
  state = { record: null, revokedAt: null, createdAt: null, rotatedAt: null };
}

function ensureState(): void {
  if (state.record === null && state.revokedAt === null && state.createdAt === null && !fs.existsSync(ARMS_FILE)) {
    return;
  }
  if (state.record === null && fs.existsSync(ARMS_FILE)) {
    loadFile();
  }
}

function persist(next: ArmsFileState): void {
  state = next;
  fs.mkdirSync(ARMS_DIR, { recursive: true, mode: 0o755 });
  const record = next.record;
  const body = record
    ? `${JSON.stringify(record, null, 2)}\n`
    : `${JSON.stringify({ schemaVersion: 1, createdAt: next.createdAt, revokedAt: next.revokedAt }, null, 2)}\n`;
  fs.writeFileSync(ARMS_FILE, body, { mode: 0o600 });
  try {
    fs.chmodSync(ARMS_FILE, 0o600);
  } catch {
    /* best effort */
  }
}

function mintPlaintext(): string {
  return `nxarms_${randomBytes(32).toString('base64url')}`;
}

export interface ArmsTokenGenerated {
  token: string;
  createdAt: number;
}

export function generateArmsToken(now = Date.now()): ArmsTokenGenerated {
  ensureState();
  if (state.record?.tokenHash && !state.revokedAt) {
    throw new Error('token Arms já existe — rotacione em vez de gerar outro');
  }
  const token = mintPlaintext();
  persist({
    record: { schemaVersion: 1, tokenHash: sha256(token), createdAt: now },
    revokedAt: null,
    createdAt: now,
    rotatedAt: null,
  });
  return { token, createdAt: now };
}

export function rotateArmsToken(now = Date.now()): ArmsTokenGenerated {
  ensureState();
  if (!state.record || state.revokedAt) {
    throw new Error('não há token Arms ativo para rotacionar');
  }
  const token = mintPlaintext();
  persist({
    record: {
      schemaVersion: 1,
      tokenHash: sha256(token),
      createdAt: state.record.createdAt,
      rotatedAt: now,
    },
    revokedAt: null,
    createdAt: state.record.createdAt,
    rotatedAt: now,
  });
  return { token, createdAt: state.record.createdAt };
}

export function revokeArmsToken(now = Date.now()): void {
  ensureState();
  if (!state.record || state.revokedAt) {
    throw new Error('não há token Arms ativo para revogar');
  }
  persist({
    record: null,
    revokedAt: now,
    createdAt: state.createdAt,
    rotatedAt: state.rotatedAt,
  });
}

export interface ArmsStatus {
  configured: boolean;
  revoked: boolean;
  createdAt: number | null;
  rotatedAt: number | null;
  lastUsedAt: number | null;
}

export function armsStatus(): ArmsStatus {
  ensureState();
  return {
    configured: Boolean(state.record?.tokenHash) && !state.revokedAt,
    revoked: Boolean(state.revokedAt),
    createdAt: state.createdAt,
    rotatedAt: state.rotatedAt,
    lastUsedAt: state.record?.lastUsedAt ?? null,
  };
}

/** Comparação em tempo constante do hash; nunca loga o valor. */
export function authenticateArmsToken(candidate: unknown, now = Date.now()): boolean {
  if (typeof candidate !== 'string' || candidate.length < 16 || candidate.length > 256) {
    return false;
  }
  ensureState();
  if (!state.record?.tokenHash || state.revokedAt) return false;
  const candidateHash = Buffer.from(sha256(candidate), 'hex');
  const storedHash = Buffer.from(state.record.tokenHash, 'hex');
  if (!timingSafeEqual(candidateHash, storedHash)) return false;
  // lastUsedAt em disco no máx. 1x/min — o token é validado a cada request.
  if (now - lastUsedFlushAt > 60_000 && state.record) {
    lastUsedFlushAt = now;
    persist({
      record: { ...state.record, lastUsedAt: now },
      revokedAt: state.revokedAt,
      createdAt: state.createdAt,
      rotatedAt: state.rotatedAt,
    });
  }
  return true;
}

/** Reinicializa o módulo entre testes (não usar em produção). */
export function resetArmsTokenStoreForTests(): void {
  state = { record: null, revokedAt: null, createdAt: null, rotatedAt: null };
  lastUsedFlushAt = 0;
}
