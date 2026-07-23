import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  assertIdentityAllowlistNonEmpty,
  createIdentityFilteredAgent,
  filterAllowedIdentityFingerprints,
  identityAllowlistIsWildcard,
} from './ssh-identity-filter';

type AgentCallback<T> = (error?: Error | null, value?: T) => void;
type AgentLike = {
  getIdentities(callback: AgentCallback<unknown[]>): void;
  sign(
    publicKey: unknown,
    data: Buffer,
    optionsOrCallback: Record<string, unknown> | AgentCallback<Buffer>,
    callback?: AgentCallback<Buffer>,
  ): void;
};

const requireForTest = createRequire(import.meta.url);

function sshString(value: Buffer): Buffer {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

function ed25519PublicBlob(fill: number): Buffer {
  return Buffer.concat([
    sshString(Buffer.from('ssh-ed25519')),
    sshString(Buffer.alloc(32, fill)),
  ]);
}

function fingerprint(publicBlob: Buffer): string {
  const digest = createHash('sha256')
    .update(publicBlob)
    .digest('base64')
    .replace(/=+$/u, '');
  return `SHA256:${digest}`;
}

function getIdentities(agent: AgentLike): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    agent.getIdentities((error, identities) => {
      if (error) reject(error);
      else resolve(identities ?? []);
    });
  });
}

function sign(agent: AgentLike, publicKey: unknown): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    agent.sign(publicKey, Buffer.from('payload'), (error, signature) => {
      if (error) reject(error);
      else resolve(signature ?? Buffer.alloc(0));
    });
  });
}

describe('ssh-identity-filter', () => {
  it('filters allowlist case-sensitively (SHA-256 base64 is case-sensitive)', () => {
    // 'bb' must NOT match 'BB' — collapsing case would weaken pinning (H3/L17).
    expect(
      filterAllowedIdentityFingerprints(['AA', 'BB', 'CC'], ['bb', 'dd']),
    ).toEqual([]);
    expect(
      filterAllowedIdentityFingerprints(['AA', 'BB', 'CC'], ['BB', 'dd']),
    ).toEqual(['BB']);
  });

  it('normalizes the SHA256: prefix on both sides', () => {
    expect(
      filterAllowedIdentityFingerprints(['SHA256:abcDEF'], ['abcDEF']),
    ).toEqual(['SHA256:abcDEF']);
  });

  it('wildcard offers all available identities', () => {
    expect(identityAllowlistIsWildcard(['*'])).toBe(true);
    expect(filterAllowedIdentityFingerprints(['AA', 'BB'], ['*'])).toEqual([
      'AA',
      'BB',
    ]);
  });

  it('fail closed on empty allowlist', () => {
    expect(() => assertIdentityAllowlistNonEmpty([])).toThrow(/fail closed/);
  });

  it('filters the backing agent identities and signs only an authorized key', async () => {
    const ssh2 = requireForTest('ssh2') as {
      BaseAgent: new () => AgentLike;
      createAgent(socketPath: string): AgentLike;
      utils: { parseKey(value: unknown): unknown };
    };
    const allowed = ed25519PublicBlob(0x11);
    const denied = ed25519PublicBlob(0x22);
    const signCalls: unknown[] = [];
    const backingAgent: AgentLike = {
      getIdentities(callback) {
        callback(undefined, [allowed, denied, { pubKey: denied }, { malformed: true }]);
      },
      sign(publicKey, _data, optionsOrCallback, callback) {
        signCalls.push(publicKey);
        const done = typeof optionsOrCallback === 'function'
          ? optionsOrCallback
          : callback;
        done?.(undefined, Buffer.from('authorized-signature'));
      },
    };
    const createAgent = vi.fn(() => backingAgent);
    const filtered = createIdentityFilteredAgent(
      '/private/agent.sock',
      [fingerprint(allowed)],
      { ...ssh2, createAgent },
    ) as AgentLike;

    await expect(getIdentities(filtered)).resolves.toEqual([allowed]);
    await expect(sign(filtered, allowed)).resolves.toEqual(
      Buffer.from('authorized-signature'),
    );
    await expect(sign(filtered, denied)).rejects.toThrow(/not allowlisted/i);
    expect(signCalls).toEqual([allowed]);
    expect(createAgent).toHaveBeenCalledWith('/private/agent.sock');
  });

  it('rejects empty, wildcard, and malformed fingerprint policies before opening the agent', () => {
    const ssh2 = requireForTest('ssh2') as {
      BaseAgent: new () => AgentLike;
      createAgent(socketPath: string): AgentLike;
      utils: { parseKey(value: unknown): unknown };
    };
    const createAgent = vi.fn(() => ({
      getIdentities: vi.fn(),
      sign: vi.fn(),
    }) as AgentLike);
    const runtime = { ...ssh2, createAgent };

    expect(() => createIdentityFilteredAgent('/agent.sock', [], runtime))
      .toThrow(/empty identity allowlist/i);
    expect(() => createIdentityFilteredAgent('/agent.sock', ['*'], runtime))
      .toThrow(/wildcard identity allowlist/i);
    expect(() => createIdentityFilteredAgent('/agent.sock', ['SHA256:not-base64'], runtime))
      .toThrow(/malformed identity fingerprint/i);
    expect(() => createIdentityFilteredAgent('', [fingerprint(ed25519PublicBlob(0x44))], runtime))
      .toThrow(/SSH_AUTH_SOCK is unavailable/i);
    expect(createAgent).not.toHaveBeenCalled();
  });
});
