// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: ABI checks of
// apps/web/src/terminal/ghostty/runtimeAbi.test.ts (pinned revision, size
// budget, repeated create/write/free) against the Nexus artifact and loader,
// plus import surface, layouts, sha256 pin, path resolution and load failure.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  GHOSTTY_VT_REVISION,
  GhosttyRuntime,
  loadGhosttyRuntime,
  resolveGhosttyWasmPath,
} from './ghostty-runtime';

const REPO = path.resolve(__dirname, '../../..');
const WASM = path.join(REPO, 'resources/ghostty/ghostty-vt.wasm');
/** Byte-for-byte copy of t3code apps/web/src/terminal/ghostty/vendor/ghostty-vt.wasm. */
const WASM_SHA256 = '51b016a6aa3c29ead71c7c8acf8c01d43b064bae19957a9c9f9e2bf469267629';

/** Every export the detector grid drives; a rebuild must keep them all. */
const REQUIRED_EXPORTS = [
  'memory',
  'ghostty_type_json',
  'ghostty_build_info',
  'ghostty_wasm_alloc_u8_array',
  'ghostty_wasm_free_u8_array',
  'ghostty_wasm_alloc_opaque',
  'ghostty_wasm_free_opaque',
  'ghostty_wasm_alloc_usize',
  'ghostty_wasm_free_usize',
  'ghostty_terminal_new',
  'ghostty_terminal_free',
  'ghostty_terminal_vt_write',
  'ghostty_terminal_resize',
  'ghostty_terminal_reset',
  'ghostty_formatter_terminal_new',
  'ghostty_formatter_format_buf',
  'ghostty_formatter_free',
];

describe('vendored libghostty-vt WebAssembly (ABI)', () => {
  it('is the pinned upstream artifact within the size budget', () => {
    const bytes = fs.readFileSync(WASM);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(WASM_SHA256);
    expect(bytes.byteLength).toBeLessThan(750_000);
  });

  it('imports only env.log — no WASI, filesystem or network', () => {
    const module = new WebAssembly.Module(new Uint8Array(fs.readFileSync(WASM)));
    expect(WebAssembly.Module.imports(module)).toEqual([
      { module: 'env', name: 'log', kind: 'function' },
    ]);
    const exported = new Set(WebAssembly.Module.exports(module).map((entry) => entry.name));
    expect(REQUIRED_EXPORTS.filter((name) => !exported.has(name))).toEqual([]);
  });

  it('embeds the revision pinned in third_party/ghostty-vt/VERSION', () => {
    const pinned = fs.readFileSync(path.join(REPO, 'third_party/ghostty-vt/VERSION'), 'utf8').trim();
    expect(GHOSTTY_VT_REVISION).toBe(pinned);
    expect(loadGhosttyRuntime(WASM).buildRevision()).toBe(pinned);
  });

  it('describes every struct the grid writes through type_json', () => {
    const runtime = loadGhosttyRuntime(WASM);
    const terminal = runtime.layout('GhosttyTerminalOptions');
    expect(terminal.size).toBe(8);
    expect(Object.keys(terminal.fields)).toEqual(['cols', 'rows', 'max_scrollback']);
    const format = runtime.layout('GhosttyFormatterTerminalOptions');
    expect(Object.keys(format.fields)).toEqual(['size', 'emit', 'unwrap', 'trim', 'extra', 'selection']);
    expect(format.fields.extra?.size).toBe(runtime.layout('GhosttyFormatterTerminalExtra').size);
    expect(runtime.layout('GhosttyFormatterTerminalExtra').fields.screen?.size).toBe(
      runtime.layout('GhosttyFormatterScreenExtra').size,
    );
    expect(Object.keys(runtime.layout('GhosttyString').fields)).toEqual(['ptr', 'len']);
  });

  it('creates, writes multi-codepoint graphemes, and frees repeated terminals', () => {
    // Fresh instance: this test must not move the shared runtime's counters.
    const runtime = GhosttyRuntime.fromBytes(new Uint8Array(fs.readFileSync(WASM)));
    const optionsSize = runtime.layout('GhosttyTerminalOptions').size;
    let settled = 0;
    for (let iteration = 0; iteration < 25; iteration += 1) {
      const options = runtime.alloc(optionsSize);
      runtime.setField(options, 'GhosttyTerminalOptions', 'cols', 80);
      runtime.setField(options, 'GhosttyTerminalOptions', 'rows', 24);
      runtime.setField(options, 'GhosttyTerminalOptions', 'max_scrollback', 5_000);
      const slot = runtime.allocOpaque();
      expect(runtime.call('ghostty_terminal_new', 0, slot, options)).toBe(0);
      const terminal = runtime.readPointer(slot);
      const input = new TextEncoder().encode('é 👨‍👩‍👧‍👦 العربية\r\n');
      const pointer = runtime.alloc(input.length);
      runtime.bytes(pointer, input.length).set(input);
      runtime.call('ghostty_terminal_vt_write', terminal, pointer, input.length);
      runtime.free(pointer, input.length);
      runtime.call('ghostty_terminal_free', terminal);
      runtime.freeOpaque(slot);
      runtime.free(options, optionsSize);
      if (iteration === 4) settled = runtime.memory.buffer.byteLength;
    }
    // Freed terminals are reused: churn does not grow linear memory.
    expect(runtime.memory.buffer.byteLength).toBe(settled);
  });

  it('renews its DataView after linear memory grows', () => {
    const runtime = GhosttyRuntime.fromBytes(new Uint8Array(fs.readFileSync(WASM)));
    const slot = runtime.alloc(runtime.layout('GhosttyString').size);
    runtime.setField(slot, 'GhosttyString', 'len', 7);
    const before = runtime.memory.buffer;
    runtime.memory.grow(1);
    expect(runtime.memory.buffer).not.toBe(before);
    // A stale DataView over the detached buffer would throw here.
    expect(runtime.readField(slot, 'GhosttyString', 'len')).toBe(7);
    runtime.setField(slot, 'GhosttyString', 'len', 9);
    expect(runtime.readField(slot, 'GhosttyString', 'len')).toBe(9);
  });

  it('ships Ghostty’s MIT notice next to the artifact and in third_party', () => {
    const license = fs.readFileSync(path.join(REPO, 'third_party/ghostty-vt/LICENSE'), 'utf8');
    expect(license).toContain('Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors');
    expect(fs.readFileSync(path.join(REPO, 'resources/ghostty/LICENSE'), 'utf8')).toBe(license);
  });
});

describe('ghostty-vt.wasm resolution and load failure', () => {
  it('reads the packaged copy from Resources (outside app.asar)', () => {
    expect(
      resolveGhosttyWasmPath({ packaged: true, resourcesPath: '/Applications/Nexus.app/Contents/Resources' }),
    ).toBe(path.join('/Applications/Nexus.app/Contents/Resources', 'ghostty', 'ghostty-vt.wasm'));
  });

  it('finds the repository copy in dev, from the app path or cwd', () => {
    expect(resolveGhosttyWasmPath({ cwd: REPO })).toBe(WASM);
    expect(resolveGhosttyWasmPath({ cwd: '/nonexistent', appPath: path.join(REPO, '.vite', 'build') })).toBe(WASM);
  });

  it('remembers a failed load instead of retrying per session', () => {
    const missing = path.join(REPO, 'resources/ghostty/missing-for-test.wasm');
    let first: unknown;
    try {
      loadGhosttyRuntime(missing);
    } catch (error) {
      first = error;
    }
    expect((first as { code?: string }).code).toBe('ENOENT');
    expect(() => loadGhosttyRuntime(missing)).toThrow(first as Error);
  });

  it('refuses an artifact built from another revision', () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ghostty-rev-'));
    const copy = path.join(dir, 'ghostty-vt.wasm');
    fs.copyFileSync(WASM, copy);
    const bytes = fs.readFileSync(copy);
    // Flip one hex digit of the embedded revision string; the module stays valid.
    const at = bytes.indexOf(Buffer.from(GHOSTTY_VT_REVISION));
    expect(at).toBeGreaterThan(0);
    bytes[at] = bytes[at] === 0x30 ? 0x31 : 0x30;
    fs.writeFileSync(copy, bytes);
    expect(() => loadGhosttyRuntime(copy)).toThrow(/revision mismatch/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
