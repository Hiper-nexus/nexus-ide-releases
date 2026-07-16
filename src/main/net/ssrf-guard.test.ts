import { describe, expect, it } from 'vitest';
import { checkNetworkTarget } from './ssrf-guard';

describe('checkNetworkTarget', () => {
  it('blocks the cloud metadata IP literal', async () => {
    const r = await checkNetworkTarget('169.254.169.254');
    expect(r.ok).toBe(false);
  });

  it('blocks metadata hostnames without resolving', async () => {
    const r = await checkNetworkTarget('metadata.google.internal', async () => {
      throw new Error('lookup should not run');
    });
    expect(r.ok).toBe(false);
  });

  it('blocks a hostname that resolves to a private/metadata address', async () => {
    const r = await checkNetworkTarget('evil.example', async () => [
      '169.254.169.254',
    ]);
    expect(r.ok).toBe(false);
  });

  it('allows a public IP literal and pins it', async () => {
    const r = await checkNetworkTarget('93.184.216.34');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.address).toBe('93.184.216.34');
  });

  it('allows loopback and RFC1918 (legit dev/LAN targets)', async () => {
    expect((await checkNetworkTarget('127.0.0.1')).ok).toBe(true);
    expect((await checkNetworkTarget('10.1.2.3')).ok).toBe(true);
    expect((await checkNetworkTarget('192.168.0.10')).ok).toBe(true);
  });

  it('pins the first resolved address to defeat rebinding', async () => {
    const r = await checkNetworkTarget('host.example', async () => [
      '93.184.216.34',
      '8.8.8.8',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.address).toBe('93.184.216.34');
  });

  it('fails closed when resolution throws', async () => {
    const r = await checkNetworkTarget('nope.example', async () => {
      throw new Error('DNS fail');
    });
    expect(r.ok).toBe(false);
  });

  it('handles bracketed IPv6: allows [::1] loopback, blocks mapped metadata', async () => {
    expect((await checkNetworkTarget('[::1]')).ok).toBe(true);
    expect((await checkNetworkTarget('[::ffff:169.254.169.254]')).ok).toBe(false);
  });
});
