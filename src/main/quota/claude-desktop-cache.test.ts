import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { readClaudeDesktopUsage } from './claude-desktop-cache';

const NOW = Date.parse('2026-09-20T20:00:00Z');
const ORG = 'a1b2c3d4-0000-4000-8000-000000000001';

const tempDirs: string[] = [];
function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-claude-cache-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Monta um entry Simple Cache: header + key + body zstd + trailer NUL. */
function writeEntry(
  dir: string,
  key: string,
  body: unknown,
  opts: { dateHeader?: string; mtimeMs?: number; compress?: boolean } = {},
): string {
  const keyBuf = Buffer.from(key, 'utf8');
  const header = Buffer.alloc(24);
  header.writeBigUInt64LE(0xfcfb6d1ba7725c30n, 0);
  header.writeUInt32LE(keyBuf.length, 12);

  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const frame =
    opts.compress === false ? payload : zlib.zstdCompressSync(payload);
  const trailer = Buffer.from(
    `\0server:cache\0date:${opts.dateHeader ?? new Date(NOW).toUTCString()}\0`,
    'latin1',
  );

  const file = path.join(dir, `${Math.random().toString(16).slice(2)}_0`);
  fs.writeFileSync(file, Buffer.concat([header, keyBuf, frame, trailer]));
  if (opts.mtimeMs !== undefined) {
    const t = opts.mtimeMs / 1000;
    fs.utimesSync(file, t, t);
  }
  return file;
}

const USAGE = {
  five_hour: { utilization: 12, resets_at: '2026-09-21T01:00:00Z' },
  seven_day: { utilization: 34, resets_at: '2026-09-27T03:00:00Z' },
};

describe('readClaudeDesktopUsage', () => {
  it('lê a resposta de usage da org pedida — janelas reais do Desktop', () => {
    const dir = makeDir();
    writeEntry(dir, `1/0/https://claude.ai/api/organizations/${ORG}/usage`, USAGE);
    const hit = readClaudeDesktopUsage(ORG, { directory: dir, now: NOW });
    expect(hit).not.toBeNull();
    expect(
      hit!.windows.find((w) => w.label === '5 Horas')?.usedRatio,
    ).toBeCloseTo(0.12, 5);
    expect(
      hit!.windows.find((w) => w.label === 'Semanal')?.usedRatio,
    ).toBeCloseTo(0.34, 5);
    expect(hit!.capturedAt).toBe(NOW);
  });

  it('variante ?skip_spend=1 é a mesma URL de usage', () => {
    const dir = makeDir();
    writeEntry(
      dir,
      `https://claude.ai/api/organizations/${ORG}/usage?skip_spend=1`,
      USAGE,
    );
    expect(readClaudeDesktopUsage(ORG, { directory: dir, now: NOW })).not.toBeNull();
  });

  it('outra organização nunca é servida — nem com o cache populado', () => {
    const dir = makeDir();
    writeEntry(dir, `https://claude.ai/api/organizations/${ORG}/usage`, USAGE);
    expect(
      readClaudeDesktopUsage('outra-org-9999', { directory: dir, now: NOW }),
    ).toBeNull();
  });

  it('path /usage/<extra> não é confundido com o endpoint de usage', () => {
    const dir = makeDir();
    writeEntry(
      dir,
      `https://claude.ai/api/organizations/${ORG}/usage/extra`,
      USAGE,
    );
    expect(readClaudeDesktopUsage(ORG, { directory: dir, now: NOW })).toBeNull();
  });

  it('entry de outro host com path parecido é rejeitada pelo host check', () => {
    const dir = makeDir();
    writeEntry(dir, `https://evil.example.com/api/organizations/${ORG}/usage`, USAGE);
    expect(readClaudeDesktopUsage(ORG, { directory: dir, now: NOW })).toBeNull();
  });

  it('entry velha demais não vira leitura "ao vivo"', () => {
    const dir = makeDir();
    writeEntry(dir, `https://claude.ai/api/organizations/${ORG}/usage`, USAGE, {
      dateHeader: new Date(NOW - 2 * 3600 * 1000).toUTCString(),
      mtimeMs: NOW - 2 * 3600 * 1000,
    });
    expect(readClaudeDesktopUsage(ORG, { directory: dir, now: NOW })).toBeNull();
  });

  it('mtime do arquivo supre a falta do header Date:', () => {
    const dir = makeDir();
    writeEntry(dir, `https://claude.ai/api/organizations/${ORG}/usage`, USAGE);
    // Remove o trailer (perde o header Date:) e só depois fixa o mtime —
    // writeFileSync regravaria o mtime com a hora real.
    const file = fs
      .readdirSync(dir)
      .map((n) => path.join(dir, n))
      .find((n) => n.endsWith('_0'))!;
    const raw = fs.readFileSync(file);
    const frameStart = 24 + raw.readUInt32LE(12);
    const trailerAt = raw
      .subarray(frameStart)
      .indexOf(Buffer.from('\0server:', 'latin1'));
    fs.writeFileSync(file, raw.subarray(0, frameStart + trailerAt));
    const t = (NOW - 60_000) / 1000;
    fs.utimesSync(file, t, t);
    const hit = readClaudeDesktopUsage(ORG, { directory: dir, now: NOW });
    expect(hit).not.toBeNull();
    expect(hit!.capturedAt).toBe(NOW - 60_000);
  });

  it('body não-zstd e lixo aleatório são ignorados', () => {
    const dir = makeDir();
    writeEntry(dir, `https://claude.ai/api/organizations/${ORG}/usage`, USAGE, {
      compress: false,
    });
    fs.writeFileSync(path.join(dir, 'junk_0'), Buffer.alloc(200, 7));
    expect(readClaudeDesktopUsage(ORG, { directory: dir, now: NOW })).toBeNull();
  });

  it('diretório ausente → null (Desktop não instalado)', () => {
    expect(
      readClaudeDesktopUsage(ORG, {
        directory: path.join(os.tmpdir(), 'nao-existe-nexus'),
        now: NOW,
      }),
    ).toBeNull();
  });

  it('org vazia → null sem tocar o disco', () => {
    expect(readClaudeDesktopUsage('  ', { directory: '/tmp', now: NOW })).toBeNull();
  });
});
