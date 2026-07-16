import { afterEach, describe, expect, it } from 'vitest';
import {
  closeAllPortForwards,
  closePortForward,
  listPortForwards,
  startPortForward,
} from './port-forward';

afterEach(() => {
  closeAllPortForwards();
});

describe('port-forward', () => {
  it('starts and lists a local forward', async () => {
    const r = await startPortForward({
      localPort: 39111,
      remoteHost: '127.0.0.1',
      remotePort: 9,
      label: 'test',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.info.localUrl).toBe('http://127.0.0.1:39111');
      expect(listPortForwards().some((f) => f.id === r.info.id)).toBe(true);
      expect(closePortForward(r.info.id)).toBe(true);
    }
  });

  it('rejects duplicate local ports', async () => {
    const a = await startPortForward({
      localPort: 39112,
      remoteHost: '127.0.0.1',
      remotePort: 9,
    });
    expect(a.ok).toBe(true);
    const b = await startPortForward({
      localPort: 39112,
      remoteHost: '127.0.0.1',
      remotePort: 10,
    });
    expect(b.ok).toBe(false);
  });

  it('blocks SSRF to the cloud metadata IP (H4)', async () => {
    const r = await startPortForward({
      localPort: 39113,
      remoteHost: '169.254.169.254',
      remotePort: 80,
    });
    expect(r.ok).toBe(false);
  });

  it('blocks metadata hostnames', async () => {
    const r = await startPortForward({
      localPort: 39114,
      remoteHost: 'metadata.google.internal',
      remotePort: 80,
    });
    expect(r.ok).toBe(false);
  });

  it('still allows loopback and private LAN dev servers', async () => {
    const loop = await startPortForward({
      localPort: 39115,
      remoteHost: '127.0.0.1',
      remotePort: 9,
    });
    expect(loop.ok).toBe(true);
    const lan = await startPortForward({
      localPort: 39116,
      remoteHost: '10.1.2.3',
      remotePort: 8080,
    });
    expect(lan.ok).toBe(true);
  });
});
