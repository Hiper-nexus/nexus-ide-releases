import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '../jarvis/audit-log';
import type { ProjectExecutionScope } from '../../shared/types';

const fixtures = vi.hoisted(() => ({
  entries: [] as AuditEntry[],
  secret: '11'.repeat(32) as string | null,
  setSecret: vi.fn(() => ({ ok: true as const })),
}));

vi.mock('../jarvis/audit-log', () => ({
  readAuditLog: () => fixtures.entries,
}));

vi.mock('../persistence/secrets-store', () => ({
  getSecret: () => fixtures.secret,
  setSecret: fixtures.setSecret,
}));

import {
  signCronAuthority,
  verifyCronAuthority,
} from './cron-authority-auth';

const scope: ProjectExecutionScope = {
  version: 1,
  installationId: 'installation-auth-test',
  projectId: 'project-auth-test',
  checkoutId: 'checkout-auth-test',
  rootRealPath: '/workspace/auth-test',
  identitySource: 'manifest',
};

const receiptId = '00000000-0000-4000-8000-000000000123';
const consent = {
  toolName: 'cron',
  action: 'create' as const,
  grantedAt: 1_800_000_000_000,
  receiptId,
};

function auditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: new Date(1_800_000_000_000).toISOString(),
    session: 'cron-auth-test',
    project_id: scope.projectId,
    checkout_id: scope.checkoutId,
    source: 'http-mcp',
    tool: 'nexus_cron',
    args: { action: 'create' },
    result: 'intent',
    invocation_id: receiptId,
    duration_ms: 1,
    user_authorized: true,
    ...overrides,
  };
}

describe('authenticated cron recurring consent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixtures.secret = '11'.repeat(32);
    fixtures.entries = [auditEntry()];
  });

  it('signs only an authenticated one-shot audit receipt and detects tampering', () => {
    const payload = '{"job":"cron-final-id"}';
    const authorityTag = signCronAuthority(scope, consent, payload);

    expect(authorityTag).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyCronAuthority(payload, authorityTag)).toBe(true);
    expect(verifyCronAuthority(`${payload} `, authorityTag)).toBe(false);
  });

  it('rejects a forged or non-authorized audit receipt', () => {
    fixtures.entries = [
      auditEntry({ result: 'ok' }),
      auditEntry({
        invocation_id: '00000000-0000-4000-8000-000000000999',
      }),
      auditEntry({ user_authorized: false }),
      auditEntry({ args: { action: 'update' } }),
    ];

    expect(() => signCronAuthority(scope, consent, '{}')).toThrow(
      /cron_exact_consent_unverifiable/i,
    );
  });

  it('fails closed when the OS-backed signing key is unavailable', () => {
    fixtures.secret = null;

    expect(verifyCronAuthority('{}', 'a'.repeat(64))).toBe(false);
  });
});
