import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildWindowsTray } from './build-windows-tray.mjs';

it.skipIf(process.platform !== 'win32')(
  'compiles the real tray companion and its self-test passes',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'redline-tray-test-'));
    try {
      // Compila as fontes reais (MSVC /W4 /WX) e monta o bundle temporário.
      const output = join(directory, 'bundle', 'NexusRedline.exe');
      const { skipped } = buildWindowsTray({ output });
      expect(skipped).toBe(false);
      expect(existsSync(output)).toBe(true);
      // O binário valida a si mesmo: parser, formatação e roundtrip no disco.
      const report = execFileSync(output, ['--self-test'], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(report).toContain('Redline Windows checks passed');
      expect(report).not.toContain('[FALHOU]');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  600_000,
);

/** Snapshot fixture: 8 contas exercendo todos os ramos de linha. */
function paintFixture(now) {
  const adapters = ['claude', 'codex', 'grok', 'kimi', 'glm', 'opencode', 'gemini', 'cursor'];
  const entries = adapters.map((adapter, i) => {
    const base = {
      id: `${adapter}:acc${i}`,
      adapterId: adapter,
      accountId: `acc${i}`,
      label: `${adapter} conta ${i}`,
      emailMasked: `us****@e**.com`,
      active: i === 0,
      installed: true,
      onCooldown: i === 2,
      updatedAt: now,
      eligible: i !== 2,
    };
    if (i === 2) {
      return {
        ...base,
        cooldownUntil: now + 12 * 60_000,
        excludedReason: 'cooldown',
        headroom: 0,
        windows: [{ kind: 'weekly', label: 'Semanal' }],
      };
    }
    if (i === 5) {
      return {
        ...base,
        excludedReason: 'needs-relogin',
        emailMasked: undefined,
        windows: [],
      };
    }
    return {
      ...base,
      headroom: 0.9 - i * 0.1,
      decisiveWindow: { label: 'Sessão', effectiveUsedRatio: 0.1 + i * 0.1 },
      windows: [
        { kind: 'session', label: 'Sessão', usedRatio: 0.1 + i * 0.1, resetsAt: now + 3600_000 },
        { kind: 'weekly', label: 'Semanal', usedRatio: 0.05 + i * 0.05 },
        { kind: 'daily', label: 'Diária' },
      ],
    };
  });
  const ranking = {};
  for (const [i, adapter] of adapters.entries()) {
    ranking[adapter] = [
      { entryId: `${adapter}:acc${i}`, adapterId: adapter, label: `${adapter} conta ${i}`, headroom: 0.9 - i * 0.1 },
    ];
  }
  return {
    formatVersion: 1,
    generatedBy: 'nexus',
    updatedAt: now,
    worstUsedRatio: 0.8,
    entries,
    ranking,
    statusBarEntryIds: entries.slice(0, 6).map((e) => e.id),
  };
}

/** Lê o BMP 24bpp que o --paint-check grava. */
function readBmp24(path) {
  const bytes = readFileSync(path);
  expect(bytes[0]).toBe(0x42); // B
  expect(bytes[1]).toBe(0x4d); // M
  const dataOffset = bytes.readUInt32LE(10);
  const w = bytes.readInt32LE(18);
  const h = bytes.readInt32LE(22);
  expect(bytes.readUInt16LE(28)).toBe(24);
  const stride = (w * 3 + 3) & ~3;
  expect(bytes.length).toBe(dataOffset + stride * h);
  const pixels = bytes.subarray(dataOffset);
  const colors = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + x * 3;
      const key = (pixels[o] << 16) | (pixels[o + 1] << 8) | pixels[o + 2];
      colors.set(key, (colors.get(key) ?? 0) + 1);
    }
  }
  return { w, h, colors, bytes };
}

it.skipIf(process.platform !== 'win32')(
  'renders the real panel offscreen: dark surface, content and scroll move pixels',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'redline-paint-test-'));
    try {
      const output = join(directory, 'bundle', 'NexusRedline.exe');
      buildWindowsTray({ output });
      const now = Date.now();
      const snapPath = join(directory, 'snapshot.json');
      writeFileSync(snapPath, JSON.stringify(paintFixture(now)));
      const bmp1 = join(directory, 'panel.bmp');
      const bmp2 = join(directory, 'panel-scrolled.bmp');
      const report = execFileSync(
        output,
        ['--paint-check', snapPath, bmp1, bmp2],
        { encoding: 'utf8', timeout: 60_000 },
      );
      const size = report.match(/paint-check (\d+)x(\d+) fnv=([0-9a-f]+)/);
      expect(size, `relato do paint-check: ${report}`).not.toBe(null);
      const [, w, h] = size.map(Number);
      expect(w).toBe(400);
      expect(h).toBeGreaterThanOrEqual(240);
      const first = readBmp24(bmp1);
      expect(first.w).toBe(400);
      expect(first.h).toBe(h);
      // Superfície escura domina (fundo #0D0B0F/#111013, não tela branca/preta).
      const top = [...first.colors.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const r = (top >> 16) & 0xff;
      const g = (top >> 8) & 0xff;
      const b = top & 0xff;
      expect([r, g, b].every((c) => c < 0x40)).toBe(true);
      // Conteúdo real desenhado: dezenas de cores (texto AA, medidores, logos).
      expect(first.colors.size).toBeGreaterThan(60);
      // O scroll rolou a lista: os dois frames diferem.
      const second = readBmp24(bmp2);
      expect(second.bytes.equals(first.bytes)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  600_000,
);

it('is a no-op off Windows', () => {
  if (process.platform === 'win32') return;
  const { skipped, output } = buildWindowsTray({
    output: join(tmpdir(), 'redline-tray-should-not-exist.exe'),
  });
  expect(skipped).toBe(true);
  expect(output).toBe(null);
});
