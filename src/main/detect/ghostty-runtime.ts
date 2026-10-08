// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: Node/worker_threads
// loader (fs + synchronous WebAssembly.Instance) instead of fetch, no PTY
// write trampoline (the grid is headless and never answers the PTY), pinned
// revision check, dev/packaged path resolution and budget/trap bookkeeping.
//
// libghostty-vt is Ghostty's terminal core (MIT, © 2024 Mitchell Hashimoto,
// Ghostty contributors; see third_party/ghostty-vt/). The vendored artifact
// resources/ghostty/ghostty-vt.wasm imports only `env.log` — no WASI, no
// filesystem, no network — so it is a pure state machine over the bytes fed.

import fs from 'node:fs';
import path from 'node:path';

/** Ghostty revision of the vendored artifact (third_party/ghostty-vt/VERSION). */
export const GHOSTTY_VT_REVISION = '9f62873bf195e4d8a762d768a1405a5f2f7b1697';
/** GHOSTTY_BUILD_INFO_VERSION_BUILD (build_info.h): semver build metadata. */
const GHOSTTY_BUILD_INFO_VERSION_BUILD = 10;
const GHOSTTY_SUCCESS = 0;

type WasmFunction = (...args: Array<number | bigint>) => number;

interface TypeField {
  readonly offset: number;
  readonly size: number;
  readonly type: string;
}

export interface TypeLayout {
  readonly size: number;
  readonly align: number;
  readonly fields: Readonly<Record<string, TypeField>>;
}

type TypeLayouts = Readonly<Record<string, TypeLayout>>;

const textDecoder = new TextDecoder();

export class GhosttyRuntime {
  readonly memory: WebAssembly.Memory;
  readonly layouts: TypeLayouts;
  /** Terminals alive on this instance (budget accounting, ghostty-screen.ts). */
  liveTerminals = 0;
  /**
   * Set after a WebAssembly trap. A Zig panic aborts mid-call and can leave
   * the allocator inconsistent, so nothing calls into this instance again.
   */
  broken = false;
  private readonly exports: WebAssembly.Exports;
  private memoryView: DataView;

  private constructor(
    instance: WebAssembly.Instance,
    /** Compiled once; respawn() instantiates it again without recompiling. */
    readonly module: WebAssembly.Module,
    private readonly log?: (message: string) => void,
  ) {
    this.exports = instance.exports;
    const memory = instance.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) {
      throw new Error('libghostty-vt did not export WebAssembly memory');
    }
    this.memory = memory;
    this.memoryView = new DataView(memory.buffer);
    const jsonPointer = this.call('ghostty_type_json');
    const bytes = new Uint8Array(memory.buffer);
    let end = jsonPointer;
    while (end < bytes.length && bytes[end] !== 0) end += 1;
    this.layouts = JSON.parse(textDecoder.decode(bytes.subarray(jsonPointer, end))) as TypeLayouts;
  }

  /**
   * Synchronous on purpose: the detector API is synchronous and PTY bytes
   * that arrived before an async instantiate settled would be missing from
   * the grid forever. Node has no main-thread size limit on sync compile.
   */
  static fromBytes(bytes: BufferSource, log?: (message: string) => void): GhosttyRuntime {
    return GhosttyRuntime.fromModule(new WebAssembly.Module(bytes), log);
  }

  static fromModule(module: WebAssembly.Module, log?: (message: string) => void): GhosttyRuntime {
    let instance: WebAssembly.Instance | undefined;
    const imports = {
      env: {
        log: (pointer: number, length: number) => {
          if (!instance || !log) return;
          const memory = instance.exports.memory;
          if (!(memory instanceof WebAssembly.Memory)) return;
          log(textDecoder.decode(new Uint8Array(memory.buffer, pointer, length)));
        },
      },
    };
    instance = new WebAssembly.Instance(module, imports);
    return new GhosttyRuntime(instance, module, log);
  }

  /**
   * A fresh instance of the same module: new linear memory (1.25 MiB), no
   * terminals. WebAssembly.Memory never shrinks, so this is the only way to
   * hand back pages a past peak grew; the old instance is freed once nothing
   * references it.
   */
  respawn(): GhosttyRuntime {
    return GhosttyRuntime.fromModule(this.module, this.log);
  }

  call(name: string, ...args: Array<number | bigint>): number {
    const fn = this.exports[name];
    if (typeof fn !== 'function') {
      throw new Error(`libghostty-vt export is unavailable: ${name}`);
    }
    return (fn as WasmFunction)(...args);
  }

  layout(name: string): TypeLayout {
    const layout = this.layouts[name];
    if (!layout) throw new Error(`libghostty-vt type layout is unavailable: ${name}`);
    return layout;
  }

  alloc(size: number): number {
    const pointer = this.call('ghostty_wasm_alloc_u8_array', size);
    if (pointer === 0) throw new Error(`libghostty-vt failed to allocate ${size} bytes`);
    new Uint8Array(this.memory.buffer, pointer, size).fill(0);
    return pointer;
  }

  free(pointer: number, size: number): void {
    if (pointer !== 0) this.call('ghostty_wasm_free_u8_array', pointer, size);
  }

  allocOpaque(): number {
    const pointer = this.call('ghostty_wasm_alloc_opaque');
    if (pointer === 0) throw new Error('libghostty-vt failed to allocate an opaque pointer');
    // The slot is uninitialized until a *_new call writes it; zero it so dispose
    // paths that run after a partial initialization never free a garbage pointer.
    new DataView(this.memory.buffer).setUint32(pointer, 0, true);
    return pointer;
  }

  freeOpaque(pointer: number): void {
    if (pointer !== 0) this.call('ghostty_wasm_free_opaque', pointer);
  }

  readPointer(slot: number): number {
    return this.currentMemoryView().getUint32(slot, true);
  }

  view(pointer: number, size?: number): DataView {
    return new DataView(this.memory.buffer, pointer, size);
  }

  bytes(pointer: number, size: number): Uint8Array {
    return new Uint8Array(this.memory.buffer, pointer, size);
  }

  /** Reuse scalar reads across cells, refreshing after any terminal grows shared WASM memory. */
  private currentMemoryView(): DataView {
    if (this.memoryView.buffer !== this.memory.buffer) {
      this.memoryView = new DataView(this.memory.buffer);
    }
    return this.memoryView;
  }

  setField(pointer: number, structName: string, fieldName: string, value: number): void {
    const field = this.layout(structName).fields[fieldName];
    if (!field) throw new Error(`libghostty-vt field is unavailable: ${structName}.${fieldName}`);
    const view = this.currentMemoryView();
    const offset = pointer + field.offset;
    switch (field.type) {
      case 'bool':
      case 'u8':
        view.setUint8(offset, value);
        return;
      case 'u16':
        view.setUint16(offset, value, true);
        return;
      case 'i32':
        view.setInt32(offset, value, true);
        return;
      case 'u32':
      case 'enum':
      case 'pointer':
        view.setUint32(offset, value, true);
        return;
      case 'u64':
        view.setBigUint64(offset, BigInt(value), true);
        return;
      default:
        throw new Error(`Unsupported libghostty-vt field type: ${field.type}`);
    }
  }

  readField(pointer: number, structName: string, fieldName: string): number {
    const field = this.layout(structName).fields[fieldName];
    if (!field) throw new Error(`libghostty-vt field is unavailable: ${structName}.${fieldName}`);
    const view = this.currentMemoryView();
    const offset = pointer + field.offset;
    switch (field.type) {
      case 'bool':
      case 'u8':
        return view.getUint8(offset);
      case 'u16':
        return view.getUint16(offset, true);
      case 'i32':
        return view.getInt32(offset, true);
      case 'u32':
      case 'enum':
      case 'pointer':
        return view.getUint32(offset, true);
      case 'u64':
        return Number(view.getBigUint64(offset, true));
      default:
        throw new Error(`Unsupported libghostty-vt field type: ${field.type}`);
    }
  }

  /** Revision embedded by the build as semver build metadata (`0.1.0-dev+<sha>`). */
  buildRevision(): string {
    const size = this.layout('GhosttyString').size;
    const out = this.alloc(size);
    try {
      const result = this.call('ghostty_build_info', GHOSTTY_BUILD_INFO_VERSION_BUILD, out);
      if (result !== GHOSTTY_SUCCESS) throw new Error(`ghostty_build_info failed with result ${result}`);
      const pointer = this.readField(out, 'GhosttyString', 'ptr');
      const length = this.readField(out, 'GhosttyString', 'len');
      return textDecoder.decode(this.bytes(pointer, length));
    } finally {
      this.free(out, size);
    }
  }
}

/**
 * Dev (repo) vs packaged (extraResource, outside app.asar) resolution of
 * resources/ghostty/ghostty-vt.wasm — same candidate strategy as the
 * agent-detection manifests. The analysis Worker reads it with plain fs, so
 * the artifact must never live inside the asar.
 */
export function resolveGhosttyWasmPath(candidates?: {
  appPath?: string;
  resourcesPath?: string;
  packaged?: boolean;
  cwd?: string;
}): string {
  const cwd = candidates?.cwd ?? process.cwd();
  if (candidates?.packaged && candidates.resourcesPath) {
    return path.join(candidates.resourcesPath, 'ghostty', 'ghostty-vt.wasm');
  }
  const appPath = candidates?.appPath ?? cwd;
  const options = [cwd, appPath, path.join(appPath, '..'), path.join(appPath, '..', '..')].map(
    (base) => path.join(base, 'resources', 'ghostty', 'ghostty-vt.wasm'),
  );
  return path.resolve(options.find((candidate) => fs.existsSync(candidate)) ?? options[0]);
}

const modules = new Map<string, WebAssembly.Module | Error>();

/**
 * One compiled, revision-checked module per thread and artifact; each call
 * returns its own instance. The detector's sessions share that instance, and
 * the detector may replace it (respawn) to give memory back, so the cache must
 * not pin an old instance's linear memory. A failed load is remembered, so a
 * missing or foreign artifact costs one attempt, not one per session.
 */
export function loadGhosttyRuntime(wasmPath = resolveGhosttyWasmPath()): GhosttyRuntime {
  const key = path.resolve(wasmPath);
  const cached = modules.get(key);
  if (cached instanceof Error) throw cached;
  if (cached) return GhosttyRuntime.fromModule(cached);
  try {
    const runtime = GhosttyRuntime.fromBytes(new Uint8Array(fs.readFileSync(key)));
    const revision = runtime.buildRevision();
    // Option ids, enum values and by-value struct passing are pinned to this
    // revision; a different artifact must not be driven with these numbers.
    if (revision !== GHOSTTY_VT_REVISION) {
      throw Object.assign(new Error(`libghostty-vt revision mismatch: ${revision.slice(0, 64)}`), {
        name: 'GhosttyRevisionMismatch',
      });
    }
    modules.set(key, runtime.module);
    return runtime;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    modules.set(key, failure);
    throw failure;
  }
}
