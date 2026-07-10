import { describe, expect, it } from 'vitest';
import { cronDefinitionHash, portableCronDefinitionSchema } from './cron-contract';

const GOLDEN = {
  schemaVersion: 1 as const,
  name: 'Nightly review',
  schedule: '0 0 * * *',
  brief: 'review code',
  workingDirectory: 'packages/api',
  target: { kind: 'agent' as const, id: 'reviewer' },
  status: 'active' as const,
};

describe('portable cron wire contract', () => {
  it('keeps the canonical hash compatible with the desktop implementation', () => {
    expect(cronDefinitionHash(GOLDEN)).toBe(
      '10ae6d15125b43cab0ee392609cc02b7f7d7a8283a1eb53f1e4af3b757bc2f41',
    );
  });

  it('rejects machine paths and traversal in portable definitions', () => {
    expect(() =>
      portableCronDefinitionSchema.parse({
        ...GOLDEN,
        workingDirectory: '/Users/alice/project',
      }),
    ).toThrow();
    expect(() =>
      portableCronDefinitionSchema.parse({
        ...GOLDEN,
        workingDirectory: '../other-project',
      }),
    ).toThrow();
  });

  it.each([
    ['name', { name: 'Bearer placeholder' }],
    ['brief', { brief: 'Inspect /Users/alice/private-project' }],
    [
      'target.id',
      { target: { kind: 'agent' as const, id: 'Bearer placeholder' } },
    ],
    [
      'target.id path',
      { target: { kind: 'agent' as const, id: '/Users/alice/agent' } },
    ],
    ['password assignment', { brief: 'password=hunter2' }],
    ['AWS secret assignment', { brief: 'AWS_SECRET_ACCESS_KEY=example-value' }],
    ['Basic authorization', { brief: 'Authorization: Basic dXNlcjpwYXNz' }],
    ['API key assignment', { brief: 'api_key=example-value' }],
    ['working directory credential', { workingDirectory: 'password=hunter2' }],
    ['Stripe secret', { brief: 'STRIPE_SECRET_KEY=sk_live_abcdefghijklmnop' }],
    ['client secret key', { brief: 'CLIENT_SECRET_KEY=example-value' }],
    ['generic secret key', { brief: 'secret_key=example-value' }],
    ['encryption key', { brief: 'ENCRYPTION_KEY=example-value' }],
    ['GitLab token', { brief: 'glpat-abcdefghijklmnop' }],
    ['home-relative path', { brief: 'Inspect ~/.ssh/id_rsa' }],
    ['file URI', { brief: 'Open file:///Users/alice/key.pem' }],
    ['single-segment absolute path', { brief: 'Check /etc' }],
    ['embedded UNC path', { brief: 'Inspect \\\\server\\share\\secret.txt' }],
  ])('rejects non-portable content in %s', (_field, override) => {
    expect(() =>
      portableCronDefinitionSchema.parse({ ...GOLDEN, ...override }),
    ).toThrow();
  });
});
