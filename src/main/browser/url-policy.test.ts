import { describe, expect, it, vi } from 'vitest';
import {
  assessBrowserUrl,
  browserNetworkTargetKey,
  classifyBrowserAddress,
  normalizeBrowserUrl,
  redactBrowserUrl,
} from './url-policy';

describe('browser URL policy', () => {
  it('normalizes public http/https URLs and rejects active schemes or credentials', () => {
    expect(normalizeBrowserUrl('example.com/docs')).toBe('https://example.com/docs');
    expect(() => normalizeBrowserUrl('file:///etc/passwd')).toThrow(/only allow/);
    expect(() => normalizeBrowserUrl('https://user:pass@example.com/')).toThrow(
      /credentials/,
    );
  });

  it('classifies private, link-local, metadata, mapped IPv4 and public addresses', () => {
    expect(classifyBrowserAddress('127.0.0.1')).toBe('loopback');
    expect(classifyBrowserAddress('10.2.3.4')).toBe('private');
    expect(classifyBrowserAddress('169.254.1.2')).toBe('link-local');
    expect(classifyBrowserAddress('169.254.169.254')).toBe('metadata');
    expect(classifyBrowserAddress('::1')).toBe('loopback');
    expect(classifyBrowserAddress('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyBrowserAddress('::7f00:1')).toBe('loopback');
    expect(classifyBrowserAddress('64:ff9b::a9fe:a9fe')).toBe('metadata');
    expect(classifyBrowserAddress('2002:7f00:0001::')).toBe('loopback');
    expect(classifyBrowserAddress('fc00::1')).toBe('private');
    expect(classifyBrowserAddress('fd00:ec2::254')).toBe('metadata');
    expect(classifyBrowserAddress('2606:4700:4700::1111')).toBe('public');
    expect(classifyBrowserAddress('1.1.1.1')).toBe('public');
  });

  it('allows a public hostname only when every DNS answer is public', async () => {
    const resolver = vi.fn(async () => ['93.184.216.34', '2606:2800:220:1::']);
    const decision = await assessBrowserUrl('https://example.test/', { resolver });
    expect(decision.allowed).toBe(true);
    expect(resolver).toHaveBeenCalledWith('example.test');
  });

  it('blocks DNS rebinding and mixed public/private answers without confirmation', async () => {
    const resolver = async () => ['93.184.216.34', '10.0.0.8'];
    const decision = await assessBrowserUrl('https://public-looking.test/', { resolver });
    expect(decision).toMatchObject({
      allowed: false,
      kind: 'private-network',
    });
  });

  it('allows a confirmed private target but scopes the grant key to host and port', async () => {
    const resolver = async () => ['192.168.1.10'];
    const decision = await assessBrowserUrl('http://printer.example:8080/', {
      resolver,
      allowPrivateNetwork: true,
    });
    expect(decision.allowed).toBe(true);
    expect(browserNetworkTargetKey('http://printer.example:8080/')).not.toBe(
      browserNetworkTargetKey('http://printer.example:8081/redirect'),
    );
  });

  it('resolves an allowed private hostname to numeric addresses for socket pinning', async () => {
    const resolver = vi.fn(async () => ['127.0.0.1', '::1']);
    const decision = await assessBrowserUrl('http://localhost:8080/', {
      resolver,
      allowPrivateNetwork: true,
    });

    expect(decision).toMatchObject({
      allowed: true,
      addresses: ['127.0.0.1', '::1'],
      addressClasses: ['loopback', 'loopback'],
    });
    expect(resolver).toHaveBeenCalledWith('localhost');
  });

  it('allows only an explicitly trusted Nexus preview without a private grant', async () => {
    const trusted = await assessBrowserUrl('http://127.0.0.1:49152/app', {
      isTrustedPrivateUrl: (url) => url.origin === 'http://127.0.0.1:49152',
    });
    const unrelated = await assessBrowserUrl('http://127.0.0.1:49153/app', {
      isTrustedPrivateUrl: (url) => url.origin === 'http://127.0.0.1:49152',
    });
    expect(trusted.allowed).toBe(true);
    expect(unrelated).toMatchObject({ allowed: false, kind: 'private-network' });
  });

  it('normalizes non-canonical IPv4 literals before applying the policy', async () => {
    const decimal = await assessBrowserUrl('http://2130706433/');
    const hexadecimal = await assessBrowserUrl('http://0x7f000001/');
    expect(decimal).toMatchObject({ allowed: false, kind: 'private-network' });
    expect(hexadecimal).toMatchObject({ allowed: false, kind: 'private-network' });
  });

  it('never allows metadata, link-local, multicast or reserved targets', async () => {
    for (const target of [
      'http://169.254.169.254/latest/meta-data',
      'http://169.254.10.20/',
      'http://224.0.0.1/',
      'http://metadata.google.internal/',
    ]) {
      const decision = await assessBrowserUrl(target, {
        allowPrivateNetwork: true,
      });
      expect(decision).toMatchObject({
        allowed: false,
        kind: 'forbidden-network',
      });
    }
  });

  it('fails closed when DNS cannot be resolved safely', async () => {
    const decision = await assessBrowserUrl('https://offline.example/', {
      resolver: async () => {
        throw new Error('offline');
      },
    });
    expect(decision).toMatchObject({ allowed: false, kind: 'dns-failure' });
  });

  it('redacts credentials, every query value and secret-bearing fragments', () => {
    const redacted = redactBrowserUrl(
      'https://user:pass@example.com/path?page=2&access_token=secret#token=abc',
    );
    expect(redacted).not.toContain('user');
    expect(redacted).not.toContain('pass');
    expect(redacted).not.toContain('secret');
    expect(redacted).not.toContain('abc');
    expect(redacted).toContain('access_token=%5BREDACTED%5D');
    expect(redacted).toContain('#[REDACTED]');
  });
});
