import { describe, expect, it } from 'vitest';
import {
  cronDefinitionHash,
  portableCronDefinitionSchema,
} from './portable-cron-definition';

const GOLDEN = {
  schemaVersion: 1 as const,
  name: 'Nightly review',
  schedule: '0 0 * * *',
  brief: 'review code',
  workingDirectory: 'packages/api',
  target: { kind: 'agent' as const, id: 'reviewer' },
  status: 'active' as const,
};

describe('portable cron definition', () => {
  it('matches the server canonical hash vector', () => {
    expect(cronDefinitionHash(GOLDEN)).toBe(
      '10ae6d15125b43cab0ee392609cc02b7f7d7a8283a1eb53f1e4af3b757bc2f41',
    );
  });

  it('rejects absolute/traversing working directories', () => {
    expect(() =>
      portableCronDefinitionSchema.parse({ ...GOLDEN, workingDirectory: 'C:\\repo' }),
    ).toThrow();
    expect(() =>
      portableCronDefinitionSchema.parse({ ...GOLDEN, workingDirectory: 'a/../b' }),
    ).toThrow();
  });

  it.each([
    ['name', { name: 'password=hunter2' }],
    ['brief', { brief: 'Authorization: Basic dXNlcjpwYXNz' }],
    [
      'target.id',
      { target: { kind: 'agent' as const, id: 'api_key=example-value' } },
    ],
    ['workingDirectory', { workingDirectory: 'ghp_abcdefghijklmnopqrstuv' }],
  ])('rejects credential material in %s', (_field, override) => {
    expect(() =>
      portableCronDefinitionSchema.parse({ ...GOLDEN, ...override }),
    ).toThrow(/sync-safe|credential/i);
  });
});
