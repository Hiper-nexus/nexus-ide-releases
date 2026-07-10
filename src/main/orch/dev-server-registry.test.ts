import { describe, expect, it, vi } from 'vitest';
import { createDevServerScanner, type DevServerEntry } from './dev-server-registry';

function makeScanner(paneId: string | null = 'pane-1') {
  const emitted: DevServerEntry[] = [];
  const paneIdOf = vi.fn(() => paneId);
  const scanner = createDevServerScanner({
    paneIdOf,
    emit: (entry) => emitted.push({ ...entry, urls: [...entry.urls] }),
    now: () => 1_700_000_000_000,
  });
  return { scanner, emitted, paneIdOf };
}

describe('createDevServerScanner', () => {
  it('detects a dev server URL in session output and registers it by pane and session', () => {
    const { scanner, emitted } = makeScanner();
    scanner.onData('sess-1', '  ➜  Local:   http://localhost:5173/\n');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      paneId: 'pane-1',
      sessionId: 'sess-1',
      url: 'http://localhost:5173/',
    });
    expect(scanner.get('pane-1')?.url).toBe('http://localhost:5173/');
    expect(scanner.get('sess-1')?.url).toBe('http://localhost:5173/');
    expect(scanner.get('other')).toBeNull();
  });

  it('detects a URL split across chunk boundaries (tail carry)', () => {
    const { scanner, emitted } = makeScanner();
    scanner.onData('sess-1', 'Local:   http://loc');
    expect(emitted).toHaveLength(0);
    scanner.onData('sess-1', 'alhost:5173/\n');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].url).toBe('http://localhost:5173/');
  });

  it('never re-emits a URL already known for the session', () => {
    const { scanner, emitted } = makeScanner();
    scanner.onData('sess-1', 'http://localhost:3000 ready\n');
    scanner.onData('sess-1', 'GET / 200 — http://localhost:3000\n');
    expect(emitted).toHaveLength(1);
    scanner.onData('sess-1', 'Network: http://192.168.0.9:3000\n');
    expect(emitted).toHaveLength(2);
    expect(scanner.get('sess-1')?.urls).toEqual([
      'http://localhost:3000',
      'http://192.168.0.9:3000',
    ]);
    // The primary URL stays the first (usually "Local:") one.
    expect(scanner.get('sess-1')?.url).toBe('http://localhost:3000');
  });

  it('resolves the paneId later when the pane mirror lags the first output', () => {
    let pane: string | null = null;
    const emitted: DevServerEntry[] = [];
    const scanner = createDevServerScanner({
      paneIdOf: () => pane,
      emit: (entry) => emitted.push({ ...entry }),
      now: () => 1,
    });
    scanner.onData('sess-1', 'http://localhost:5173/\n');
    expect(emitted[0].paneId).toBeNull();
    expect(scanner.get('pane-1')).toBeNull();

    pane = 'pane-1';
    scanner.onData('sess-1', 'more output\n');
    // Pane resolved → re-announced so the UI can attach the chip.
    expect(emitted).toHaveLength(2);
    expect(emitted[1].paneId).toBe('pane-1');
    expect(scanner.get('pane-1')?.url).toBe('http://localhost:5173/');
  });

  it('drops the session on exit', () => {
    const { scanner } = makeScanner();
    scanner.onData('sess-1', 'http://localhost:5173/\n');
    scanner.onExit('sess-1');
    expect(scanner.get('sess-1')).toBeNull();
    expect(scanner.get('pane-1')).toBeNull();
  });

  it('caps stored URLs per session', () => {
    const { scanner } = makeScanner();
    for (let port = 3000; port < 3010; port += 1) {
      scanner.onData('sess-1', `http://localhost:${port}\n`);
    }
    expect(scanner.get('sess-1')!.urls.length).toBeLessThanOrEqual(4);
  });
});
