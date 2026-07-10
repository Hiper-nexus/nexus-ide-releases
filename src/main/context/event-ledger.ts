import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './canonical-json';

const HASH_256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const GENESIS_HASH = '0'.repeat(64);

export type LedgerEventType =
  | 'contract-frozen'
  | 'tool-effect'
  | 'git-state'
  | 'sensor-started'
  | 'sensor-finished'
  | 'review-finding'
  | 'finding-resolved'
  | 'merge-candidate'
  | 'merge-integrated'
  | 'workflow-transition'
  | 'context-updated'
  | 'sync-conflict';

export type LedgerActorKind =
  | 'nexus'
  | 'user'
  | 'agent'
  | 'reviewer'
  | 'sensor'
  | 'admin';

export type LedgerJsonScalar = string | number | boolean | null;
export type LedgerJsonValue =
  | LedgerJsonScalar
  | readonly LedgerJsonValue[]
  | { readonly [key: string]: LedgerJsonValue };

export interface LedgerVersions {
  readonly appVersion: string;
  readonly contextHash?: string;
  readonly contractHash?: string;
  readonly policyHash?: string;
  readonly evaluatorVersion?: string;
}

export interface LedgerEventDraft {
  readonly projectId: string;
  readonly checkoutId: string;
  readonly missionId?: string;
  readonly type: LedgerEventType;
  readonly actor: {
    readonly kind: LedgerActorKind;
    readonly id: string;
  };
  readonly payload: LedgerJsonValue;
  readonly versions: LedgerVersions;
}

export interface LedgerEvent extends LedgerEventDraft {
  readonly id: string;
  readonly sequence: number;
  readonly previousHash: string;
  readonly eventHash: string;
  readonly occurredAt: string;
}

export interface LedgerStorage {
  readLast(): LedgerEvent | null;
  /** Must be one atomic compare-and-insert transaction. */
  compareAndAppend(
    expectedSequence: number,
    expectedHash: string,
    event: LedgerEvent,
  ): boolean;
  list(): readonly LedgerEvent[];
}

export interface EventLedgerOptions {
  now?: () => number;
  makeId?: () => string;
}

export class LedgerConcurrencyError extends Error {
  constructor() {
    super('event ledger optimistic concurrency conflict');
    this.name = 'LedgerConcurrencyError';
  }
}

const actorSchema = z
  .object({
    kind: z.enum(['nexus', 'user', 'agent', 'reviewer', 'sensor', 'admin']),
    id: z.string().regex(IDENTIFIER),
  })
  .strict();

const versionSchema = z
  .object({
    appVersion: z.string().trim().min(1).max(64),
    contextHash: z.string().regex(HASH_256).optional(),
    contractHash: z.string().regex(HASH_256).optional(),
    policyHash: z.string().regex(HASH_256).optional(),
    evaluatorVersion: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

const draftMetadataSchema = z
  .object({
    projectId: z.string().regex(IDENTIFIER),
    checkoutId: z.string().regex(IDENTIFIER),
    missionId: z.string().regex(IDENTIFIER).optional(),
    type: z.enum([
      'contract-frozen',
      'tool-effect',
      'git-state',
      'sensor-started',
      'sensor-finished',
      'review-finding',
      'finding-resolved',
      'merge-candidate',
      'merge-integrated',
      'workflow-transition',
      'context-updated',
      'sync-conflict',
    ]),
    actor: actorSchema,
    versions: versionSchema,
  })
  .strict();

const storedEventSchema = draftMetadataSchema
  .extend({
    payload: z.unknown(),
    id: z.string().regex(IDENTIFIER),
    sequence: z.number().int().positive(),
    previousHash: z.string().regex(HASH_256),
    eventHash: z.string().regex(HASH_256),
    occurredAt: z.string().datetime(),
  })
  .strict();

const EFFECT_TYPES = new Set<LedgerEventType>([
  'contract-frozen',
  'tool-effect',
  'git-state',
  'sensor-started',
  'sensor-finished',
  'review-finding',
  'finding-resolved',
  'merge-candidate',
  'merge-integrated',
  'workflow-transition',
]);

const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'credential',
  'installationid',
  'installation_id',
  'password',
  'prompt',
  'rootrealpath',
  'root_real_path',
  'secret',
  'sessionid',
  'session_id',
  'sourcecode',
  'source_code',
  'token',
]);

function looksAbsolutePath(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('\\\\') ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function sanitizePayload(value: unknown, key = '', depth = 0): LedgerJsonValue {
  if (depth > 32) throw new Error('ledger payload exceeds nesting limit');
  const normalizedKey = key.toLowerCase().replace(/[-\s]/g, '_');
  if (FORBIDDEN_PAYLOAD_KEYS.has(normalizedKey)) {
    throw new Error(`ledger payload contains sensitive field: ${key}`);
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (looksAbsolutePath(value)) {
      throw new Error('ledger payload contains sensitive absolute path');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('ledger payload contains non-finite number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (value.length > 16_384) throw new Error('ledger payload array is too large');
    return Object.freeze(
      value.map((item) => sanitizePayload(item, '', depth + 1)),
    );
  }
  if (typeof value === 'object' && value !== null) {
    const output: Record<string, LedgerJsonValue> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 16_384) throw new Error('ledger payload object is too large');
    for (const [childKey, childValue] of entries) {
      if (!childKey || childKey.length > 256) throw new Error('ledger payload key is invalid');
      output[childKey] = sanitizePayload(childValue, childKey, depth + 1);
    }
    return Object.freeze(output);
  }
  throw new Error(`ledger payload contains non-JSON ${typeof value}`);
}

function eventMaterial(event: Omit<LedgerEvent, 'eventHash'>): string {
  return canonicalJson(event);
}

function eventHash(event: Omit<LedgerEvent, 'eventHash'>): string {
  return createHash('sha256')
    .update(event.previousHash)
    .update('\0')
    .update(eventMaterial(event))
    .digest('hex');
}

function freezeEvent(event: LedgerEvent): LedgerEvent {
  return Object.freeze({
    ...event,
    actor: Object.freeze({ ...event.actor }),
    versions: Object.freeze({ ...event.versions }),
    payload: sanitizePayload(event.payload),
  });
}

/** Parse one durable event and verify its own content-addressed hash. */
export function parseLedgerEvent(raw: unknown): LedgerEvent {
  const parsed = storedEventSchema.parse(raw);
  const event = freezeEvent({
    ...parsed,
    payload: sanitizePayload(parsed.payload),
  });
  const { eventHash: actualHash, ...material } = event;
  if (eventHash(material) !== actualHash) {
    throw new Error('ledger event content hash mismatch');
  }
  return event;
}

export function verifyEventChain(events: readonly LedgerEvent[]):
  | { valid: true; count: number }
  | { valid: false; count: number; brokenSequence: number; reason: string } {
  let previousHash = GENESIS_HASH;
  let projectId: string | null = null;
  let checkoutId: string | null = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const sequence = index + 1;
    if (event.sequence !== sequence) {
      return { valid: false, count: events.length, brokenSequence: sequence, reason: 'sequence' };
    }
    if (event.previousHash !== previousHash) {
      return {
        valid: false,
        count: events.length,
        brokenSequence: sequence,
        reason: 'previous-hash',
      };
    }
    if (projectId === null) {
      projectId = event.projectId;
      checkoutId = event.checkoutId;
    } else if (event.projectId !== projectId || event.checkoutId !== checkoutId) {
      return { valid: false, count: events.length, brokenSequence: sequence, reason: 'scope' };
    }
    const { eventHash: actualHash, ...material } = event;
    if (eventHash(material) !== actualHash) {
      return { valid: false, count: events.length, brokenSequence: sequence, reason: 'event-hash' };
    }
    previousHash = actualHash;
  }
  return { valid: true, count: events.length };
}

export class EventLedger {
  readonly #storage: LedgerStorage;
  readonly #now: () => number;
  readonly #makeId: () => string;

  constructor(storage: LedgerStorage, options: EventLedgerOptions = {}) {
    if (!storage) throw new Error('event ledger requires durable storage');
    this.#storage = storage;
    this.#now = options.now ?? Date.now;
    this.#makeId = options.makeId ?? randomUUID;
  }

  append(rawDraft: LedgerEventDraft): LedgerEvent {
    const { payload: rawPayload, ...rawMetadata } = rawDraft;
    const metadata = draftMetadataSchema.parse(rawMetadata);
    if (EFFECT_TYPES.has(metadata.type)) {
      if (
        !metadata.missionId ||
        !metadata.versions.contextHash ||
        !metadata.versions.contractHash
      ) {
        throw new Error(
          'mission effect requires missionId, contextHash and contractHash',
        );
      }
    }
    const payload = sanitizePayload(rawPayload);
    const payloadSize = Buffer.byteLength(canonicalJson(payload), 'utf8');
    if (payloadSize > MAX_PAYLOAD_BYTES) throw new Error('ledger payload is too large');
    const last = this.#storage.readLast();
    if (
      last &&
      (last.projectId !== metadata.projectId ||
        last.checkoutId !== metadata.checkoutId)
    ) {
      throw new Error('ledger storage contains another project checkout');
    }
    const expectedSequence = last?.sequence ?? 0;
    const previousHash = last?.eventHash ?? GENESIS_HASH;
    const occurredAtMs = this.#now();
    if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0) {
      throw new Error('ledger clock returned an invalid timestamp');
    }
    const id = this.#makeId();
    if (!IDENTIFIER.test(id)) throw new Error('ledger id factory returned an invalid id');
    const withoutHash: Omit<LedgerEvent, 'eventHash'> = {
      ...metadata,
      payload,
      id,
      sequence: expectedSequence + 1,
      previousHash,
      occurredAt: new Date(occurredAtMs).toISOString(),
    };
    const event = freezeEvent({
      ...withoutHash,
      eventHash: eventHash(withoutHash),
    });
    if (
      !this.#storage.compareAndAppend(expectedSequence, previousHash, event)
    ) {
      throw new LedgerConcurrencyError();
    }
    return freezeEvent(event);
  }

  listVerified(): readonly LedgerEvent[] {
    const events = this.#storage.list().map(freezeEvent);
    const verification = verifyEventChain(events);
    if (!verification.valid) {
      throw new Error(
        `event ledger chain is invalid at sequence ${verification.brokenSequence}: ${verification.reason}`,
      );
    }
    return Object.freeze(events);
  }

  replay<T>(initial: T, reducer: (state: T, event: LedgerEvent) => T): T {
    let state = initial;
    for (const event of this.listVerified()) state = reducer(state, event);
    return state;
  }
}
