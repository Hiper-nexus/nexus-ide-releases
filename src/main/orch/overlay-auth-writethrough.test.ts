import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GROK_AUTH_WRITE_THROUGH_POLICY as policy } from './cli-mcp-session-grok';
import {
  decideAuthWriteThrough,
  startAuthWriteThrough,
  writeThroughOnce,
} from './overlay-auth-writethrough';

const ACCOUNT = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
const grokAuth = (refresh: string, expiresAt: string, key = ACCOUNT, email = 'op@example.com') =>
  JSON.stringify({ [key]: { email, refresh_token: refresh, expires_at: expiresAt } });

const NOW = Date.parse('2026-09-29T12:00:00Z');
const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-auth-wt-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** O Grok regrava o auth.json por temporário + rename (desfaz o hardlink). */
function cliRenameWrite(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

describe('devolução do auth.json renovado ao perfil de origem (F-684)', () => {
  it('mesma conta: só o blob mais novo volta; nunca um mais velho', () => {
    const old = grokAuth('r1', '2026-09-23T01:59:00Z');
    const fresh = grokAuth('r2', '2026-09-29T18:00:00Z');
    expect(decideAuthWriteThrough(fresh, old, policy, NOW)).toBe('write');
    expect(decideAuthWriteThrough(old, fresh, policy, NOW)).toBe('skip');
    expect(decideAuthWriteThrough(fresh, fresh, policy, NOW)).toBe('skip');
  });

  it('login novo no pane com a origem vazia é persistido', () => {
    expect(decideAuthWriteThrough(grokAuth('r1', '2026-09-29T18:00:00Z'), null, policy, NOW)).toBe('write');
  });

  it('outra conta nunca pisa num login válido; só substitui origem vencida', () => {
    const other = grokAuth('rx', '2026-09-29T18:00:00Z', 'https://auth.x.ai::outra', 'outra@example.com');
    expect(decideAuthWriteThrough(other, grokAuth('r1', '2026-09-29T15:00:00Z'), policy, NOW)).toBe('skip');
    expect(decideAuthWriteThrough(other, grokAuth('r1', '2026-09-23T01:59:00Z'), policy, NOW)).toBe('write');
  });

  it('blob ilegível no overlay nunca vai para a origem', () => {
    expect(decideAuthWriteThrough('{quebrado', grokAuth('r1', '2026-09-23T01:59:00Z'), policy, NOW)).toBe('skip');
  });

  it('Windows: rename da CLI desfaz o hardlink; o token novo volta NO arquivo de origem e alcança o outro pane', () => {
    const native = tempDir();
    const paneA = tempDir();
    const paneB = tempDir();
    const source = path.join(native, 'auth.json');
    fs.writeFileSync(source, grokAuth('r1', '2026-09-23T01:59:00Z'));
    fs.linkSync(source, path.join(paneA, 'auth.json'));
    fs.linkSync(source, path.join(paneB, 'auth.json'));

    const renewed = grokAuth('r2', '2026-09-29T18:00:00Z');
    cliRenameWrite(path.join(paneA, 'auth.json'), renewed);
    expect(fs.readFileSync(source, 'utf8')).not.toBe(renewed);

    expect(writeThroughOnce(path.join(paneA, 'auth.json'), source, policy, NOW)).toBe(true);
    expect(fs.readFileSync(source, 'utf8')).toBe(renewed);
    // Gravação no próprio arquivo: o pane B, ainda no hardlink, vê o token novo.
    expect(fs.readFileSync(path.join(paneB, 'auth.json'), 'utf8')).toBe(renewed);
  });

  it('o disposer faz a última passada ao fechar o pane', () => {
    const native = tempDir();
    const pane = tempDir();
    const source = path.join(native, 'auth.json');
    const overlay = path.join(pane, 'auth.json');
    fs.writeFileSync(source, grokAuth('r1', '2026-09-23T01:59:00Z'));
    fs.copyFileSync(source, overlay);
    const stop = startAuthWriteThrough({ overlayFile: overlay, sourceFile: source, policy, intervalMs: 60_000 });
    const renewed = grokAuth('r3', '2099-01-01T00:00:00Z');
    cliRenameWrite(overlay, renewed);
    stop();
    expect(fs.readFileSync(source, 'utf8')).toBe(renewed);
  });
});
