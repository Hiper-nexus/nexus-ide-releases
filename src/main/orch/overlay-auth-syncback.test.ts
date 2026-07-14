import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBackOverlayAuth } from './overlay-auth-syncback';

const created: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-syncback-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('syncBackOverlayAuth', () => {
  it('copies a fresh in-pane login (new real file) back into the real home', () => {
    const realHome = tmp();
    const overlay = tmp();
    fs.mkdirSync(path.join(overlay, 'credentials'), { recursive: true });
    fs.writeFileSync(
      path.join(overlay, 'credentials', 'kimi-code.json'),
      '{"token":"fresh"}',
    );

    syncBackOverlayAuth(overlay, realHome, new Set(['mcp.json']));

    expect(
      fs.readFileSync(path.join(realHome, 'credentials', 'kimi-code.json'), 'utf8'),
    ).toBe('{"token":"fresh"}');
  });

  it('never copies the token-bearing overlay config file back', () => {
    const realHome = tmp();
    const overlay = tmp();
    fs.writeFileSync(path.join(overlay, 'mcp.json'), '{"bearer":"secret-token"}');

    syncBackOverlayAuth(overlay, realHome, new Set(['mcp.json']));

    expect(fs.existsSync(path.join(realHome, 'mcp.json'))).toBe(false);
  });

  it('skips symlinks — writes already went through to the real home', () => {
    const realHome = tmp();
    const overlay = tmp();
    fs.writeFileSync(path.join(realHome, 'session.json'), 'REAL');
    fs.symlinkSync(
      path.join(realHome, 'session.json'),
      path.join(overlay, 'session.json'),
    );

    syncBackOverlayAuth(overlay, realHome, new Set(['mcp.json']));

    expect(fs.lstatSync(path.join(realHome, 'session.json')).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(realHome, 'session.json'), 'utf8')).toBe('REAL');
  });

  it('is a best-effort no-op when the overlay does not exist', () => {
    const realHome = tmp();
    expect(() =>
      syncBackOverlayAuth(path.join(realHome, 'missing'), realHome, new Set()),
    ).not.toThrow();
  });
});
