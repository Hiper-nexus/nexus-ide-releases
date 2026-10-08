import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
/** Native suite receipts. Compilation output alone is never test evidence. */
export type NativeRegressionKind = 'go' | 'cargo';
export interface NativeRegressionReport {
  complete: boolean;
  noTests?: boolean;
  ran: string[];
  skipped: string[];
  failures: Array<{ file: string; message: string }>;
}
export function nativeRegressionArgs(kind: NativeRegressionKind, lockExists: boolean): string[] {
  return kind === 'go' ? ['test', '-json', '-count=1', '-p=1', '-parallel=1', './...']
    : ['test', '--workspace', '--no-fail-fast', '--jobs', '1', '--color', 'never', '--message-format=json',
      ...(lockExists ? ['--locked'] : []), '--', '--format', 'pretty', '--color', 'never', '--test-threads', '1'];
}
const empty = (): NativeRegressionReport => ({ complete: false, ran: [], skipped: [], failures: [] });
const safeName = (name: unknown): name is string => typeof name === 'string' && name.length > 0 && name.length <= 2_000 && !/[\x00-\x1f\x7f]/.test(name);

/** Go TestEvent NDJSON: pair each actual run with its terminal event and a
 * terminal package event. Package PASS, stdout text or build success is not a test. */
export function parseGoTestEvents(output: string, exitCode: number | null): NativeRegressionReport {
  const result = empty(); const tests = new Map<string, { name: string; state: string }>();
  const packages = new Map<string, string>(); let valid = true;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line); } catch { valid = false; continue; }
    if (!event || typeof event !== 'object' || !safeName(event.Action)) { valid = false; continue; }
    if (event.Action === 'build-output') continue;
    if (event.Action === 'build-fail' || event.FailedBuild) { valid = false; continue; }
    if (!safeName(event.Package)) { valid = false; continue; }
    if (!['start', 'run', 'pause', 'cont', 'pass', 'fail', 'skip', 'output', 'bench'].includes(event.Action)) { valid = false; continue; }
    if (!packages.has(event.Package)) packages.set(event.Package, 'running');
    if (event.Test === undefined) {
      if (['pass', 'fail', 'skip'].includes(event.Action)) packages.set(event.Package, event.Action);
      continue;
    }
    if (!safeName(event.Test)) { valid = false; continue; }
    const id = `go:${event.Package}/${event.Test}`;
    if (event.Action === 'run') {
      if (tests.has(id)) valid = false;
      tests.set(id, { name: event.Test, state: 'run' });
    } else if (['pass', 'fail', 'skip'].includes(event.Action)) {
      const test = tests.get(id);
      if (!test || test.state !== 'run') { valid = false; continue; }
      test.state = event.Action;
    }
  }
  for (const [id, test] of tests) {
    if (test.state === 'run') { valid = false; continue; }
    if (test.state === 'skip') result.skipped.push(id);
    else result.ran.push(id);
    if (test.state === 'fail') result.failures.push({ file: id, message: `Go: ${test.name} falhou.` });
  }
  const packageFailed = [...packages.values()].some(state => state === 'fail');
  result.complete = valid && result.ran.length > 0 && result.skipped.length === 0 &&
    [...packages.values()].every(state => state !== 'running') && exitCode !== null &&
    (result.failures.length > 0 ? exitCode !== 0 && packageFailed : exitCode === 0 && !packageFailed);
  result.noTests = valid && tests.size === 0 && packages.size > 0 && exitCode === 0 &&
    [...packages.values()].every(state => state === 'pass' || state === 'skip');
  return result;
}

/** Stable libtest pretty blocks, with exact count reconciliation. Cargo JSON
 * artifacts are inventory only; build-finished never supplies a passing test. */
export function parseRustTestOutput(output: string, exitCode: number | null, stderr = ''): NativeRegressionReport {
  const result = empty(); const artifacts = new Set<string>();
  const tests: Array<{ name: string; status: string }> = [];
  let block: { count: number; tests: typeof tests } | null = null;
  let valid = true; let blocks = 0; let built = false;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('{')) {
      try {
        const event = JSON.parse(line);
        if (event.reason === 'compiler-artifact' && event.profile?.test && typeof event.executable === 'string') artifacts.add(event.executable);
        if (event.reason === 'build-finished') { built = event.success === true; if (!built) valid = false; }
      } catch { valid = false; }
      continue;
    }
    const start = /^running (\d+) tests?$/.exec(line);
    if (start) {
      if (block) valid = false;
      block = { count: Number(start[1]), tests: [] }; continue;
    }
    const row = /^test (.+) \.\.\. (ok|FAILED|ignored)(?:, .*)?$/.exec(line);
    if (row) {
      if (!block || !safeName(row[1])) { valid = false; continue; }
      block.tests.push({ name: row[1], status: row[2] }); continue;
    }
    const end = /^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;(?: finished in [^\r\n]+)?$/.exec(line);
    if (end) {
      if (!block) { valid = false; continue; }
      const [passed, failed, ignored, measured, filtered] = end.slice(2).map(Number);
      if (block.count !== passed + failed + ignored || block.tests.length !== block.count || measured || filtered ||
        block.tests.filter(test => test.status === 'ok').length !== passed || block.tests.filter(test => test.status === 'FAILED').length !== failed ||
        block.tests.filter(test => test.status === 'ignored').length !== ignored || (end[1] === 'ok') !== (failed === 0)) valid = false;
      tests.push(...block.tests); blocks++; block = null;
    }
  }
  const counts = new Map<string, number>();
  for (const test of tests) counts.set(test.name, (counts.get(test.name) ?? 0) + 1);
  for (const test of tests) {
    const id = `rust:${test.name}`;
    if (test.status === 'ignored') result.skipped.push(id); else result.ran.push(id);
    if (test.status === 'FAILED') result.failures.push({
      // Duplicate names across binaries cannot identify a baseline failure.
      file: counts.get(test.name)! > 1 ? `(rust ambiguous) ${test.name}` : id,
      message: `Rust: ${test.name} falhou.`,
    });
  }
  const docTargets = [...stderr.matchAll(/^\s*Doc-tests [^\r\n]+$/gm)].length;
  const covered = valid && block === null && blocks >= artifacts.size + docTargets;
  result.complete = covered && result.ran.length > 0 && result.skipped.length === 0 &&
    exitCode !== null && (result.failures.length > 0 ? exitCode !== 0 : exitCode === 0);
  result.noTests = covered && (built || blocks > 0) && tests.length === 0 && exitCode === 0;
  return result;
}

/** Positive workspace membership only: ambiguous implicit members may execute
 * again, but an excluded or independent crate must never disappear from coverage. */
export function cargoRegressionWorkspaces(manifests: ReadonlyMap<string, string>): { roots: string[]; unsupported: string[]; owners: Record<string, string> } {
  const tables = new Map<string, Record<string, unknown>>(); const unsupported = new Set<string>();
  const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  const normalize = (base: string, target: string) => path.posix.normalize(path.posix.join(path.posix.dirname(base), target));
  const outside = (name: string) => name === '..' || name.startsWith('../') || path.posix.isAbsolute(name) || path.win32.isAbsolute(name);
  const matches = (pattern: string, value: string): boolean => {
    if (pattern.length > 4096 || value.length > 4096) return false;
    const cache = new Map<string, boolean>();
    const parts = pattern.split('/'); const actual = value.split('/');
    if (parts.length > 64 || actual.length > 64) return false;
    const walk = (at: number, index: number): boolean => {
      const key = `${at}:${index}`;
      if (cache.has(key)) return cache.get(key)!;
      const result = match(at, index); cache.set(key, result); return result;
    };
    const match = (at: number, index: number): boolean => {
      if (at === parts.length) return index === actual.length;
      if (parts[at] === '**') return walk(at + 1, index) || index < actual.length && walk(at, index + 1);
      if (index === actual.length || /[\[\]{}?]/.test(parts[at])) return false; // unsupported glob => no deduplication
      const regex = new RegExp(`^${parts[at].split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
      return regex.test(actual[index]) && walk(at + 1, index + 1);
    };
    return walk(0, 0);
  };
  for (const [file, text] of manifests) {
    try {
      const table = parseToml(text) as Record<string, unknown>; tables.set(file, table);
      const defaults = [table.lib, ...['bin', 'test'].flatMap(kind => Array.isArray(table[kind]) ? table[kind] as unknown[] : [])];
      const optIn = ['bench', 'example'].flatMap(kind => Array.isArray(table[kind]) ? table[kind] as unknown[] : []).filter(target => object(target)?.test === true);
      if ([...defaults.filter(target => object(target)?.test !== false), ...optIn].some(target => object(target)?.harness === false)) unsupported.add(file);
      const workspace = object(table.workspace);
      if (strings(workspace?.members).some(member => path.posix.isAbsolute(member) || path.win32.isAbsolute(member) || outside(normalize(file, member)))) unsupported.add(file);
      const explicit = object(table.package)?.workspace;
      if (typeof explicit === 'string' && (path.posix.isAbsolute(explicit) || path.win32.isAbsolute(explicit) || outside(normalize(file, explicit)))) unsupported.add(file);
    } catch { unsupported.add(file); }
  }
  const owners: Record<string, string> = {};
  for (const file of manifests.keys()) {
    owners[file] = [...tables].find(([owner, table]) => {
    if (owner === file) return false;
    const workspace = object(table.workspace); if (!workspace) return false;
    const dir = path.posix.dirname(file);
    const explicit = object(tables.get(file)?.package)?.workspace;
    if (typeof explicit === 'string' && normalize(file, explicit) === path.posix.dirname(owner)) return true;
    return strings(workspace.members).some(pattern => matches(normalize(owner, pattern), dir)) &&
      !strings(workspace.exclude).some(pattern => matches(normalize(owner, pattern), dir));
    })?.[0] ?? file;
  }
  const roots = [...manifests.keys()].filter(file => owners[file] === file);
  return { roots, unsupported: [...unsupported], owners };
}

/** Only Main's fixed env assignments and native suite argv may bypass host
 * executable resolution for the OCI image. No host CLI or shell is required. */
export function isNativeContainerCommand(file: string, args: readonly string[], kind: NativeRegressionKind): boolean {
  if (file !== 'env') return false;
  const at = args.indexOf(kind); if (at < 1) return false;
  const allowed = new Set(['GOPATH', 'GOCACHE', 'GOMODCACHE', 'GOTMPDIR', 'GOENV', 'GOTOOLCHAIN', 'GOMAXPROCS', 'GOWORK', 'CARGO_HOME', 'CARGO_TARGET_DIR', 'CARGO_BUILD_JOBS', 'RUSTUP_AUTO_INSTALL']);
  const seen = new Set<string>();
  for (const entry of args.slice(0, at)) {
    const match = /^([A-Z_]+)=(.+)$/.exec(entry);
    if (!match || !allowed.has(match[1]) || seen.has(match[1])) return false;
    seen.add(match[1]); const value = match[2];
    if (!['0', '1', 'off', 'local'].includes(value) &&
      (!(value.startsWith('/nexus-runtime/') || match[1] === 'GOWORK' && value.startsWith('/workspace/')) || path.posix.normalize(value) !== value || /[\x00-\x1f\x7f]/.test(value))) return false;
  }
  const expected = nativeRegressionArgs(kind, args.includes('--locked'));
  return args.slice(at + 1).join('\0') === expected.join('\0');
}
