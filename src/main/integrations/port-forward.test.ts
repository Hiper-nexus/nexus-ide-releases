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
  it('starts and lists a local forward', () => {
    const r = startPortForward({
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

  it('rejects duplicate local ports', () => {
    const a = startPortForward({
      localPort: 39112,
      remoteHost: '127.0.0.1',
      remotePort: 9,
    });
    expect(a.ok).toBe(true);
    const b = startPortForward({
      localPort: 39112,
      remoteHost: '127.0.0.1',
      remotePort: 10,
    });
    expect(b.ok).toBe(false);
  });
});
