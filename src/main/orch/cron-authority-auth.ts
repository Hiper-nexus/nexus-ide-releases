import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { ProjectExecutionScope } from '../../shared/types';
import { readAuditLog } from '../jarvis/audit-log';
import {
  getSecret,
  setInternalSecret,
} from '../persistence/secrets-store';

const CRON_AUTHORITY_KEY = 'system:cron-authority-hmac:v1';
const KEY_PATTERN = /^[a-f0-9]{64}$/;
const TAG_PATTERN = /^[a-f0-9]{64}$/;

export interface CronConsentReceipt {
  readonly toolName: string;
  readonly action: 'create' | 'update';
  readonly grantedAt: number;
  readonly receiptId: string;
}

function canonicalToolName(value: string): string {
  return value.replace(/^nexus_/, '').toLowerCase();
}

function requireConsentIntent(
  scope: ProjectExecutionScope,
  consent: CronConsentReceipt,
): void {
  let entries;
  try {
    entries = readAuditLog({ scope }, 10_000);
  } catch (error) {
    throw new Error(
      'cron_exact_consent_unverifiable: audit persistence is unavailable',
      { cause: error },
    );
  }
  const verified = entries.some(
    (entry) =>
      entry.invocation_id === consent.receiptId &&
      entry.result === 'intent' &&
      entry.user_authorized === true &&
      canonicalToolName(entry.tool) === 'cron' &&
      entry.args.action === consent.action,
  );
  if (!verified) {
    throw new Error(
      'cron_exact_consent_unverifiable: no authenticated one-shot audit receipt',
    );
  }
}

function existingKey(): Buffer | null {
  const stored = getSecret(CRON_AUTHORITY_KEY);
  return stored && KEY_PATTERN.test(stored)
    ? Buffer.from(stored, 'hex')
    : null;
}

function issueKey(): Buffer {
  const current = existingKey();
  if (current) return current;
  const generated = randomBytes(32).toString('hex');
  const persisted = setInternalSecret(CRON_AUTHORITY_KEY, generated);
  if (!persisted.ok) {
    throw new Error(
      `cron_authority_auth_unavailable: ${
        persisted.error ?? 'OS secure storage rejected the signing key'
      }`,
    );
  }
  return Buffer.from(generated, 'hex');
}

function tag(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('hex');
}

export function signCronAuthority(
  scope: ProjectExecutionScope,
  consent: CronConsentReceipt,
  payload: string,
): string {
  requireConsentIntent(scope, consent);
  return tag(issueKey(), payload);
}

export function verifyCronAuthority(
  payload: string,
  rawTag: string,
): boolean {
  if (!TAG_PATTERN.test(rawTag)) return false;
  const key = existingKey();
  if (!key) return false;
  const expected = Buffer.from(tag(key, payload), 'hex');
  const actual = Buffer.from(rawTag, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
